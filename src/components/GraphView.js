import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";

import { computeDepths, traceColumn, NODE_KINDS } from "../lineage/graph";
import { colorFor, tintFor, KIND_COLORS, KIND_LABELS } from "../lineage/colors";
import { primaryOrigin } from "../lineage/graph";

const NODE_WIDTH = 240;
// Enough gap for the edge label to sit between two nodes without overlapping
// either. Wider than this and a long pipeline fits out to an unreadable zoom.
const COLUMN_GAP = 300;
const ROW_GAP = 28;
const HEADER_HEIGHT = 46;
const ROW_HEIGHT = 24;

function RelationNode({ data }) {
  const { node, originIndex, selection, onSelect, highlightedColumns } = data;
  const accent = KIND_COLORS[node.kind] ?? "#334155";

  return (
    <div className={`gnode gnode--${node.kind}`} style={{ borderTopColor: accent }}>
      <Handle type="target" position={Position.Left} className="gnode__handle" />
      <div className="gnode__head">
        <span className="gnode__kind" style={{ color: accent }}>
          {KIND_LABELS[node.kind] ?? node.kind}
        </span>
        <span className="gnode__name" title={node.name}>
          {node.name}
        </span>
      </div>
      <div className="gnode__cols">
        {node.columns.length ? (
          node.columns.map((column) => {
            const key = `${node.id}::${column.name.toLowerCase()}`;
            const origin = primaryOrigin(originIndex.get(key));
            const isSelected =
              selection?.nodeId === node.id && selection?.column === column.name;
            const isOnPath = highlightedColumns.has(key);

            return (
              <button
                key={column.name}
                type="button"
                className={`gcol ${isSelected ? "is-selected" : ""} ${isOnPath ? "is-path" : ""}`}
                style={origin ? { background: tintFor(origin, isOnPath ? 0.3 : 0.14) } : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect({ nodeId: node.id, column: column.name });
                }}
                title={`${column.name} = ${column.expression}`}
              >
                {origin && <span className="gcol__dot" style={{ background: colorFor(origin) }} />}
                <span className="gcol__name">{column.name}</span>
              </button>
            );
          })
        ) : (
          <span className="gnode__empty">no columns</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="gnode__handle" />
    </div>
  );
}

const nodeTypes = { relation: RelationNode };

/** Collects every node::column and edge on the selected field's lineage path. */
function highlightPath(graph, selection) {
  const columns = new Set();
  const edges = new Set();
  if (!selection) return { columns, edges };

  const walk = (hop) => {
    if (!hop) return;
    columns.add(`${hop.nodeId}::${hop.column.toLowerCase()}`);
    for (const source of hop.sources) {
      edges.add(`${source.nodeId}->${hop.nodeId}`);
      walk(source);
    }
  };

  walk(traceColumn(graph, selection.nodeId, selection.column));
  return { columns, edges };
}

export default function GraphView({ graph, originIndex, selection, onSelect }) {
  const { nodes, edges } = useMemo(() => {
    const depths = computeDepths(graph);
    const { columns: highlightedColumns, edges: highlightedEdges } = highlightPath(graph, selection);

    // Layered layout: one column per depth, stacked top to bottom.
    const nextY = new Map();
    const flowNodes = [];

    for (const id of graph.order) {
      const node = graph.nodes.get(id);
      const depth = depths.get(id) ?? 0;
      const y = nextY.get(depth) ?? 0;
      const height = HEADER_HEIGHT + Math.max(1, node.columns.length) * ROW_HEIGHT + 16;
      nextY.set(depth, y + height + ROW_GAP);

      flowNodes.push({
        id,
        type: "relation",
        position: { x: depth * COLUMN_GAP, y },
        data: { node, originIndex, selection, onSelect, highlightedColumns },
        draggable: true,
        style: { width: NODE_WIDTH },
      });
    }

    const flowEdges = graph.edges.map((edge) => {
      const onPath = highlightedEdges.has(`${edge.from}->${edge.to}`);
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        label: edge.columns.length > 1 ? `${edge.columns.length} fields` : edge.columns[0]?.to,
        animated: onPath,
        style: {
          stroke: onPath ? "#6b62f2" : "rgba(229,229,229,0.18)",
          strokeWidth: onPath ? 2 : 1,
        },
        labelStyle: { fill: onPath ? "#ededed" : "#686868", fontSize: 11 },
        labelBgStyle: { fill: "#161616", fillOpacity: 0.9 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: onPath ? "#6b62f2" : "rgba(229,229,229,0.25)",
        },
      };
    });

    return { nodes: flowNodes, edges: flowEdges };
  }, [graph, originIndex, selection, onSelect]);

  if (!nodes.length) {
    return <div className="empty">Nothing to graph yet — type or load some SQL.</div>;
  }

  return (
    <div className="graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1.2 }}
        minZoom={0.15}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background color="rgba(229,229,229,0.10)" gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => KIND_COLORS[n.data?.node?.kind] ?? "#334155"}
          maskColor="rgba(10,10,10,0.7)"
          style={{ background: "#161616", border: "1px solid rgba(229,229,229,0.12)" }}
        />
      </ReactFlow>

      <div className="graph__legend">
        {Object.entries(KIND_LABELS).map(([kind, label]) => (
          <span key={kind} className="graph__legend-item">
            <span className="dot" style={{ background: KIND_COLORS[kind] }} />
            {label}
          </span>
        ))}
        <span className="graph__legend-item muted">
          {graph.nodes.size} relations · {graph.edges.length} links
        </span>
      </div>
    </div>
  );
}

export { NODE_KINDS };
