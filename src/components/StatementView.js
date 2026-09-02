import { colorFor, tintFor, KIND_LABELS } from "../lineage/colors";
import { primaryOrigin } from "../lineage/graph";

const KIND_TEXT = {
  select: "SELECT",
  create_table_as: "CREATE TABLE AS",
  create_view: "CREATE VIEW",
  insert_select: "INSERT SELECT",
  insert: "INSERT",
  create: "CREATE",
  other: "STATEMENT",
};

/**
 * One field. Colour encodes the base table it ultimately comes from, so a
 * field's origin is readable without opening anything. Fields with several
 * origins, or none, are deliberately left uncoloured rather than guessed at --
 * the earlier version colored those by whichever table happened to be first.
 */
function FieldChip({ column, origins, selected, dimmed, onSelect }) {
  const origin = primaryOrigin(origins);
  const realOrigins = (origins ?? []).filter((o) => !o.literal && !o.unresolved);
  const multi = !origin && realOrigins.length > 0;
  const literal = !realOrigins.length;

  const style = origin
    ? { background: tintFor(origin, 0.22), borderColor: colorFor(origin), color: "#ededed" }
    : {};

  const title = origin
    ? `${column.name} = ${column.expression}\nfrom ${origin}`
    : multi
    ? `${column.name} = ${column.expression}\nfrom ${realOrigins.length} sources`
    : `${column.name} = ${column.expression}`;

  return (
    <button
      type="button"
      className={[
        "field-chip",
        selected ? "is-selected" : "",
        multi ? "is-multi" : "",
        literal ? "is-literal" : "",
        dimmed ? "is-dimmed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      onClick={onSelect}
      title={title}
    >
      {origin && <span className="field-chip__dot" style={{ background: colorFor(origin) }} />}
      <span className="field-chip__name">{column.name}</span>
      {column.isComputed && <span className="field-chip__badge">fx</span>}
      {multi && <span className="field-chip__badge">{realOrigins.length}</span>}
    </button>
  );
}

/** True when the relation or any of its fields matches the search text. */
function matchesRelation(node, needle) {
  if (!needle) return true;
  if (node.name.toLowerCase().includes(needle)) return true;
  return node.columns.some(
    (c) =>
      c.name.toLowerCase().includes(needle) ||
      String(c.expression ?? "").toLowerCase().includes(needle)
  );
}

function Relation({ node, originIndex, selection, onSelect, needle }) {
  if (!node) return null;

  return (
    <div className="relation">
      <div className="relation__head">
        <span className="relation__kind">{KIND_LABELS[node.kind] ?? node.kind}</span>
        <span className="relation__name">{node.name}</span>
        {!!node.relation?.sources?.length && (
          <span className="relation__from">
            from {node.relation.sources.map((s) => s.name).join(", ")}
          </span>
        )}
      </div>

      <div className="relation__fields">
        {node.columns.length ? (
          node.columns.map((column) => {
            const matched =
              !needle ||
              column.name.toLowerCase().includes(needle) ||
              String(column.expression ?? "").toLowerCase().includes(needle);

            return (
              <FieldChip
                key={column.name}
                column={column}
                origins={originIndex.get(`${node.id}::${column.name.toLowerCase()}`)}
                selected={selection?.nodeId === node.id && selection?.column === column.name}
                dimmed={!!needle && !matched}
                onSelect={() => onSelect({ nodeId: node.id, column: column.name })}
              />
            );
          })
        ) : (
          <span className="muted">no projected fields</span>
        )}
      </div>

      {!!node.joins?.length && (
        <div className="relation__joins">
          {node.joins.map((join, i) => (
            <span key={i} className="join-note">
              {(join.type ?? "JOIN").toLowerCase()} <strong>{join.target}</strong>
              {join.on ? <span className="muted"> on {join.on}</span> : null}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StatementView({
  graph,
  originIndex,
  selection,
  onSelect,
  onJumpToLine,
  search,
}) {
  if (!graph.statements.length) {
    return <div className="empty">Nothing to visualize yet — type or load some SQL.</div>;
  }

  const needle = search.trim().toLowerCase();

  const visible = graph.statements
    .map((statement) => {
      const output = statement.outputId ? graph.nodes.get(statement.outputId) : null;
      const ctes = statement.cteIds.map((id) => graph.nodes.get(id)).filter(Boolean);
      const relations = [...ctes, output].filter(Boolean);
      const matching = relations.filter((node) => matchesRelation(node, needle));
      return { statement, output, ctes, matching };
    })
    .filter(({ matching }) => matching.length > 0);

  if (!visible.length) {
    return <div className="empty">No field matches “{search.trim()}”.</div>;
  }

  return (
    <div className="statements">
      {visible.map(({ statement, output, ctes, matching }) => {
        const shown = new Set(matching.map((n) => n.id));

        return (
          <section key={statement.id} className="statement">
            <header className="statement__head">
              <button
                type="button"
                className="statement__line"
                onClick={() => onJumpToLine(statement.startLine)}
                title="Jump to this statement in the editor"
              >
                line {statement.startLine}
              </button>
              <span className="statement__kind">{KIND_TEXT[statement.kind] ?? statement.kind}</span>
              {statement.target && <span className="statement__target">{statement.target}</span>}
              {statement.degraded && (
                <span
                  className="statement__warn"
                  title={statement.parseError ?? "Parsed with fallback heuristics"}
                >
                  partial parse
                </span>
              )}
            </header>

            {ctes
              .filter((node) => shown.has(node.id))
              .map((node) => (
                <Relation
                  key={node.id}
                  node={node}
                  originIndex={originIndex}
                  selection={selection}
                  onSelect={onSelect}
                  needle={needle}
                />
              ))}

            {output && shown.has(output.id) && (
              <Relation
                node={output}
                originIndex={originIndex}
                selection={selection}
                onSelect={onSelect}
                needle={needle}
              />
            )}

            {!output && !ctes.length && (
              <div className="muted statement__none">no projected fields in this statement</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
