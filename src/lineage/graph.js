// Builds a column-level lineage graph across every statement in a script.
//
// Statements are not independent: a CTE feeds the query it sits in, and a
// CREATE TABLE AS / INSERT ... SELECT feeds every later statement that reads
// that table. Following a field back to its origin means walking those hops,
// which is what this module makes possible.

export const NODE_KINDS = {
  TABLE: "table", // a base table -- lineage terminates here
  CTE: "cte", // WITH block, scoped to one statement
  DERIVED: "derived", // table/view created by a statement (CTAS, INSERT, CREATE VIEW)
  SUBQUERY: "subquery", // inline derived table in a FROM clause
  RESULT: "result", // the final result set of a bare SELECT
};

const lower = (s) => (s == null ? "" : String(s).toLowerCase());

function makeNode(id, name, kind, extra = {}) {
  return {
    id,
    name,
    kind,
    columns: [],
    statementIndex: null,
    inputs: new Set(),
    outputs: new Set(),
    ...extra,
  };
}

/**
 * @param {object} parseResult output of parseScript
 * @returns {{nodes: Map, edges: Array, order: Array, statements: Array, unresolved: Array}}
 */
export function buildLineage(parseResult) {
  const nodes = new Map();
  const edges = [];
  const unresolved = [];
  // Tables produced by earlier statements, visible to later ones.
  const derived = new Map(); // lowercased name -> node id
  const statements = [];

  const ensureNode = (id, name, kind, extra) => {
    let node = nodes.get(id);
    if (!node) {
      node = makeNode(id, name, kind, extra);
      nodes.set(id, node);
    }
    return node;
  };

  const addColumn = (node, name, column) => {
    if (!name) return;
    const existing = node.columns.find((c) => lower(c.name) === lower(name));
    if (existing) {
      if (column && !existing.expression) Object.assign(existing, column);
      return;
    }
    node.columns.push({ name, expression: name, refs: [], ...(column ?? {}) });
  };

  const addEdge = (fromId, toId, mapping) => {
    if (!fromId || !toId || fromId === toId) return;
    let edge = edges.find((e) => e.from === fromId && e.to === toId);
    if (!edge) {
      edge = { id: `${fromId}->${toId}`, from: fromId, to: toId, columns: [] };
      edges.push(edge);
      nodes.get(toId)?.inputs.add(fromId);
      nodes.get(fromId)?.outputs.add(toId);
    }
    const duplicate = edge.columns.some(
      (c) => c.to === mapping.to && c.from === mapping.from
    );
    if (!duplicate) edge.columns.push(mapping);
  };

  /**
   * Materializes one relation as a node, recursing into its subquery sources.
   * `scope` maps a name visible in this statement to a node id (CTEs first,
   * then tables created by earlier statements, then base tables).
   */
  const materialize = (relation, node, statementIndex, scope) => {
    if (!relation) return;
    node.statementIndex = statementIndex;
    node.relation = relation;

    // Resolve every FROM/JOIN source to a node.
    const sourceNodes = new Map(); // relation-local source id -> node id
    relation.sources.forEach((source, i) => {
      let sourceId;

      if (source.kind === "subquery") {
        sourceId = `sub:${statementIndex}:${node.id}:${i}`;
        const subNode = ensureNode(sourceId, source.alias ?? `subquery ${i + 1}`, NODE_KINDS.SUBQUERY);
        materialize(source.relation, subNode, statementIndex, scope);
      } else if (source.kind === "unnest") {
        sourceId = `unnest:${statementIndex}:${node.id}:${i}`;
        ensureNode(sourceId, source.name, NODE_KINDS.SUBQUERY, { unnestOf: source.parent });
      } else {
        const key = lower(source.name);
        const bare = lower(source.name.split(".").pop());
        const scoped = scope.get(key) ?? scope.get(bare);
        if (scoped) {
          sourceId = scoped;
        } else if (derived.has(key) || derived.has(bare)) {
          sourceId = derived.get(key) ?? derived.get(bare);
        } else {
          sourceId = `table:${key}`;
          ensureNode(sourceId, source.name, NODE_KINDS.TABLE);
        }
      }

      sourceNodes.set(source.id, sourceId);
    });

    node.joins = relation.joins ?? [];
    node.where = relation.where ?? null;

    // Project columns and draw an edge per dependency.
    for (const column of relation.columns) {
      if (column.isStar) {
        // `t.*` pulls every known column of t; a bare `*` pulls from all sources.
        const targets = column.starSource
          ? [sourceNodes.get(column.starSource)].filter(Boolean)
          : Array.from(sourceNodes.values());

        for (const targetId of targets) {
          const source = nodes.get(targetId);
          const starColumns = source && source.columns.length ? source.columns : null;
          if (starColumns) {
            for (const c of starColumns) {
              addColumn(node, c.name, { expression: `${source.name}.${c.name}`, viaStar: true });
              addEdge(targetId, node.id, { to: c.name, from: c.name, expression: "*", viaStar: true });
            }
          } else {
            addColumn(node, column.name, { expression: column.expression, isStar: true });
            addEdge(targetId, node.id, {
              to: column.name,
              from: "*",
              expression: column.expression,
              viaStar: true,
              wildcard: true,
            });
          }
        }
        continue;
      }

      addColumn(node, column.name, {
        expression: column.expression,
        isComputed: column.isComputed,
        refs: column.refs,
      });

      for (const ref of column.refs) {
        const targetId = ref.sourceId ? sourceNodes.get(ref.sourceId) : null;
        if (!targetId) {
          unresolved.push({
            statementIndex,
            node: node.name,
            column: column.name,
            ref: ref.column,
            status: ref.status,
            candidates: ref.candidates ?? [],
          });
          continue;
        }
        // Base tables have no definition of their own; record the columns we
        // observe being read from them so they are not empty boxes.
        const target = nodes.get(targetId);
        if (target && target.kind === NODE_KINDS.TABLE) addColumn(target, ref.column);

        addEdge(targetId, node.id, {
          to: column.name,
          from: ref.column,
          expression: column.expression,
          status: ref.status,
        });
      }
    }
  };

  for (const statement of parseResult.statements) {
    const scope = new Map();

    for (const cte of statement.ctes) {
      const id = `cte:${statement.index}:${lower(cte.name)}`;
      const node = ensureNode(id, cte.name, NODE_KINDS.CTE, { statementIndex: statement.index });
      materialize(cte.relation, node, statement.index, scope);
      // Registered after materializing so a CTE cannot resolve to itself.
      scope.set(lower(cte.name), id);
    }

    let outputId = null;
    if (statement.relation) {
      if (statement.target) {
        outputId = `rel:${lower(statement.target)}`;
        const node = ensureNode(outputId, statement.target, NODE_KINDS.DERIVED, {
          statementIndex: statement.index,
        });
        node.kind = NODE_KINDS.DERIVED;
        materialize(statement.relation, node, statement.index, scope);
        derived.set(lower(statement.target), outputId);
        const bare = lower(statement.target.split(".").pop());
        if (!derived.has(bare)) derived.set(bare, outputId);
      } else {
        outputId = `result:${statement.index}`;
        const node = ensureNode(outputId, `Result ${statement.index + 1}`, NODE_KINDS.RESULT, {
          statementIndex: statement.index,
        });
        materialize(statement.relation, node, statement.index, scope);
      }
    }

    statements.push({
      ...statement,
      outputId,
      cteIds: statement.ctes.map((c) => `cte:${statement.index}:${lower(c.name)}`),
    });
  }

  return { nodes, edges, order: topoOrder(nodes, edges), statements, unresolved };
}

/** Kahn's algorithm; leftover nodes (cycles) are appended so nothing is lost. */
function topoOrder(nodes, edges) {
  const indegree = new Map();
  for (const id of nodes.keys()) indegree.set(id, 0);
  for (const edge of edges) {
    if (indegree.has(edge.to)) indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  const order = [];
  const seen = new Set();

  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const edge of edges) {
      if (edge.from !== id || !indegree.has(edge.to)) continue;
      indegree.set(edge.to, indegree.get(edge.to) - 1);
      if (indegree.get(edge.to) === 0) queue.push(edge.to);
    }
  }

  for (const id of nodes.keys()) if (!seen.has(id)) order.push(id);
  return order;
}

/** Longest-path depth per node, used to lay the graph out in columns. */
export function computeDepths(graph) {
  const depths = new Map();
  for (const id of graph.order) {
    const node = graph.nodes.get(id);
    let depth = 0;
    for (const input of node.inputs) {
      if (depths.has(input)) depth = Math.max(depth, depths.get(input) + 1);
    }
    depths.set(id, depth);
  }
  return depths;
}

/**
 * Walks a column back to the base tables it originates from.
 * Returns a tree of hops; `terminal` marks a base-table origin.
 */
export function traceColumn(graph, nodeId, columnName, options = {}) {
  // Cycles are caught by the path set below, so this is only a runaway guard.
  // It must stay well above realistic pipeline depth: a chain of 40 staging
  // tables is ordinary, and truncating one reports an intermediate table as if
  // it were the true origin.
  const maxDepth = options.maxDepth ?? 250;

  const visit = (id, column, depth, path) => {
    const node = graph.nodes.get(id);
    if (!node) return null;

    const key = `${id}::${lower(column)}`;
    const columnDef =
      node.columns.find((c) => lower(c.name) === lower(column)) ?? { name: column, expression: column };

    const base = {
      nodeId: id,
      nodeName: node.name,
      nodeKind: node.kind,
      statementIndex: node.statementIndex,
      column: columnDef.name,
      expression: columnDef.expression,
      isComputed: !!columnDef.isComputed,
      // No refs at all means a literal or a row-level aggregate such as
      // count(*) -- a real origin, not a reference we failed to resolve.
      derivedFromNoColumns: Array.isArray(columnDef.refs) && columnDef.refs.length === 0,
      joins: node.joins ?? [],
      where: node.where ?? null,
    };

    if (node.kind === NODE_KINDS.TABLE) return { ...base, terminal: true, sources: [] };
    if (depth >= maxDepth) return { ...base, terminal: true, truncated: true, sources: [] };
    if (path.has(key)) return { ...base, terminal: true, cyclic: true, sources: [] };

    const nextPath = new Set(path).add(key);
    const sources = [];

    for (const edge of graph.edges) {
      if (edge.to !== id) continue;
      for (const mapping of edge.columns) {
        if (lower(mapping.to) !== lower(column)) continue;
        const from = mapping.wildcard ? column : mapping.from;
        const child = visit(edge.from, from, depth + 1, nextPath);
        if (child) sources.push({ ...child, via: mapping });
      }
    }

    return { ...base, terminal: sources.length === 0, sources };
  };

  return visit(nodeId, columnName, 0, new Set());
}

/**
 * Pre-computes origins for every column in the graph.
 * The views colour hundreds of chips by origin, so tracing on each render is
 * too slow; this runs once per parse and is keyed `nodeId::column`.
 */
export function computeOriginIndex(graph) {
  const index = new Map();
  for (const [nodeId, node] of graph.nodes) {
    for (const column of node.columns) {
      const key = `${nodeId}::${lower(column.name)}`;
      if (index.has(key)) continue;
      index.set(key, traceOrigins(traceColumn(graph, nodeId, column.name)));
    }
  }
  return index;
}

/** The single base table a column comes from, or null when it is not exactly one. */
export function primaryOrigin(origins) {
  const real = (origins ?? []).filter((o) => !o.literal && !o.unresolved);
  const tables = new Set(real.map((o) => o.table));
  return tables.size === 1 ? real[0].table : null;
}

/** Flattens a trace tree to the distinct base-table columns at its leaves. */
export function traceOrigins(trace) {
  const origins = [];
  const seen = new Set();

  const walk = (hop) => {
    if (!hop) return;
    if (hop.nodeKind === NODE_KINDS.TABLE) {
      const key = `${hop.nodeName}.${hop.column}`;
      if (!seen.has(key)) {
        seen.add(key);
        origins.push({ table: hop.nodeName, column: hop.column });
      }
      return;
    }
    if (!hop.sources.length && hop.terminal) {
      const key = `${hop.nodeName}.${hop.column}`;
      if (!seen.has(key)) {
        seen.add(key);
        origins.push({
          table: hop.nodeName,
          column: hop.column,
          // Distinguish "computed from no column" (count(*), a literal) from
          // "we could not work out where this came from", and never present a
          // truncated or cyclic stop as if it were a real origin.
          literal: !!hop.derivedFromNoColumns && !hop.truncated && !hop.cyclic,
          truncated: !!hop.truncated,
          cyclic: !!hop.cyclic,
          unresolved: !hop.derivedFromNoColumns || !!hop.truncated || !!hop.cyclic,
        });
      }
      return;
    }
    hop.sources.forEach(walk);
  };

  walk(trace);
  return origins;
}
