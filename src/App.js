import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";

import Toolbar from "./components/Toolbar";
import SqlEditor from "./components/SqlEditor";
import StatementView from "./components/StatementView";
import GraphView from "./components/GraphView";
import TracePanel from "./components/TracePanel";

import { parseScript } from "./lineage/parse";
import { buildLineage, computeOriginIndex } from "./lineage/graph";
import { AUTO } from "./lineage/dialects";
import { SAMPLE_SQL } from "./sample";
import "./App.css";

export default function App() {
  const [sql, setSql] = useState(SAMPLE_SQL);
  const [dialect, setDialect] = useState(AUTO);
  const [view, setView] = useState("statements");
  const [selection, setSelection] = useState(null);
  const [search, setSearch] = useState("");

  const editorRef = useRef(null);

  // Keeps typing responsive: parsing runs against the settled value while the
  // editor stays on the latest keystroke.
  const deferredSql = useDeferredValue(sql);

  const parsed = useMemo(() => parseScript(deferredSql, dialect), [deferredSql, dialect]);
  const graph = useMemo(() => buildLineage(parsed), [parsed]);
  const originIndex = useMemo(() => computeOriginIndex(graph), [graph]);

  const handleJumpToLine = useCallback((line) => {
    editorRef.current?.revealLine(line);
  }, []);

  const handleSelect = useCallback((next) => {
    setSelection((current) =>
      current && current.nodeId === next.nodeId && current.column === next.column ? null : next
    );
  }, []);

  const handleLoad = useCallback((text) => {
    setSql(text);
    setSelection(null);
  }, []);

  const isStale = sql !== deferredSql;

  return (
    <div className="app">
      <Toolbar
        dialect={dialect}
        onDialectChange={setDialect}
        resolvedDialect={parsed.dialect}
        detected={parsed.detected}
        stats={parsed.stats}
        view={view}
        onViewChange={setView}
        search={search}
        onSearchChange={setSearch}
        onLoadFile={handleLoad}
        onLoadSample={() => handleLoad(SAMPLE_SQL)}
      />

      <main className={`layout ${selection ? "layout--tracing" : ""}`}>
        <section className="pane pane--editor">
          <div className="pane__head">
            <span className="pane__title">SQL</span>
            <span className="muted">{sql.split("\n").length} lines</span>
          </div>
          <div className="pane__body">
            <SqlEditor ref={editorRef} value={sql} onChange={setSql} dialect={parsed.dialect} />
          </div>
        </section>

        <section className="pane pane--view">
          <div className={`pane__body pane__body--scroll ${isStale ? "is-stale" : ""}`}>
            {view === "statements" ? (
              <StatementView
                graph={graph}
                originIndex={originIndex}
                selection={selection}
                onSelect={handleSelect}
                onJumpToLine={handleJumpToLine}
                search={search}
              />
            ) : (
              <GraphView
                graph={graph}
                originIndex={originIndex}
                selection={selection}
                onSelect={handleSelect}
              />
            )}
          </div>
        </section>

        {selection && (
          <TracePanel
            graph={graph}
            selection={selection}
            onClose={() => setSelection(null)}
            onJumpToLine={handleJumpToLine}
          />
        )}
      </main>
    </div>
  );
}
