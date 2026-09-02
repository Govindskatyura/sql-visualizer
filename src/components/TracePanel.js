import { traceColumn, traceOrigins, NODE_KINDS } from "../lineage/graph";
import { colorFor, KIND_LABELS } from "../lineage/colors";

/** One hop in the chain, rendered as a nested block so depth is visible. */
function Hop({ hop, depth, onJumpToLine, statementsByIndex }) {
  const statement = statementsByIndex.get(hop.statementIndex);
  const isTable = hop.nodeKind === NODE_KINDS.TABLE;

  return (
    <li className="hop" style={{ "--hop-depth": depth }}>
      <div className={`hop__card ${isTable ? "is-origin" : ""}`}>
        <div className="hop__head">
          <span
            className="hop__dot"
            style={{ background: isTable ? colorFor(hop.nodeName) : "transparent" }}
          />
          <span className="hop__kind">{KIND_LABELS[hop.nodeKind] ?? hop.nodeKind}</span>
          <span className="hop__node">{hop.nodeName}</span>
          {statement && (
            <button
              type="button"
              className="hop__line"
              onClick={() => onJumpToLine(statement.startLine)}
            >
              line {statement.startLine}
            </button>
          )}
        </div>

        <div className="hop__column">
          <strong>{hop.column}</strong>
          {!isTable && hop.expression && hop.expression !== hop.column && (
            <>
              <span className="hop__eq">=</span>
              <code>{hop.expression}</code>
            </>
          )}
        </div>

        {!!hop.joins?.length && (
          <div className="hop__meta">
            {hop.joins.map((join, i) => (
              <span key={i}>
                {(join.type ?? "JOIN").toLowerCase()} {join.target}
                {join.on ? ` on ${join.on}` : ""}
              </span>
            ))}
          </div>
        )}

        {hop.where && <div className="hop__meta">where {hop.where}</div>}

        {hop.cyclic && <div className="hop__meta hop__meta--warn">circular reference</div>}
        {hop.truncated && <div className="hop__meta hop__meta--warn">trace truncated</div>}
        {hop.terminal && !isTable && hop.derivedFromNoColumns && (
          <div className="hop__meta">computed without reading a column</div>
        )}
        {hop.terminal && !isTable && !hop.derivedFromNoColumns && (
          <div className="hop__meta hop__meta--warn">source could not be resolved</div>
        )}
      </div>

      {!!hop.sources.length && (
        <ul className="hop__children">
          {hop.sources.map((source, i) => (
            <Hop
              key={`${source.nodeId}:${source.column}:${i}`}
              hop={source}
              depth={depth + 1}
              onJumpToLine={onJumpToLine}
              statementsByIndex={statementsByIndex}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function TracePanel({ graph, selection, onClose, onJumpToLine }) {
  if (!selection) return null;

  const node = graph.nodes.get(selection.nodeId);
  if (!node) return null;

  const trace = traceColumn(graph, selection.nodeId, selection.column);
  const origins = traceOrigins(trace);
  const resolved = origins.filter((o) => !o.literal && !o.unresolved);
  const literals = origins.filter((o) => o.literal);
  const unresolved = origins.filter((o) => o.unresolved);

  const statementsByIndex = new Map(graph.statements.map((s) => [s.index, s]));

  return (
    <aside className="trace">
      <header className="trace__head">
        <div>
          <div className="trace__eyebrow">Field lineage</div>
          <h2 className="trace__title">{selection.column}</h2>
          <div className="trace__sub">
            in {KIND_LABELS[node.kind] ?? node.kind} <strong>{node.name}</strong>
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <section className="trace__origins">
        <h3>Comes from</h3>
        {resolved.length ? (
          <ul>
            {resolved.map((origin) => (
              <li key={`${origin.table}.${origin.column}`}>
                <span className="dot" style={{ background: colorFor(origin.table) }} />
                <code>
                  {origin.table}.{origin.column}
                </code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No base-table column feeds this field.</p>
        )}

        {!!literals.length && (
          <p className="muted trace__note">
            Also derived without reading a column ({literals.map((l) => l.column).join(", ")}).
          </p>
        )}
        {!!unresolved.length && (
          <p className="warn trace__note">
            {unresolved.length} reference{unresolved.length > 1 ? "s" : ""} could not be resolved —
            an unqualified name with several candidate tables, or a table defined outside this
            script.
          </p>
        )}
      </section>

      <section className="trace__chain">
        <h3>How</h3>
        <ul className="hop__children hop__children--root">
          <Hop
            hop={trace}
            depth={0}
            onJumpToLine={onJumpToLine}
            statementsByIndex={statementsByIndex}
          />
        </ul>
      </section>
    </aside>
  );
}
