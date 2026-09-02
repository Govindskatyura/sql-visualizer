import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import {
  sql,
  StandardSQL,
  PostgreSQL,
  MySQL,
  MSSQL,
  SQLite,
  MariaSQL,
} from "@codemirror/lang-sql";

// Our dialect ids are node-sql-parser's; CodeMirror has its own, smaller set.
// Anything without a close match highlights as standard SQL.
const CM_DIALECTS = {
  PostgresQL: PostgreSQL,
  Redshift: PostgreSQL,
  Snowflake: PostgreSQL,
  MySQL: MySQL,
  MariaDB: MariaSQL,
  TransactSQL: MSSQL,
  Sqlite: SQLite,
};

const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "#ededed",
      fontSize: "13px",
      height: "100%",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      padding: "12px 0",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "#686868",
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
    },
    ".cm-activeLine": { backgroundColor: "rgba(229, 229, 229, 0.04)" },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(229, 229, 229, 0.04)",
      color: "#c2c2c2",
    },
    ".cm-cursor": { borderLeftColor: "#ededed" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(107, 98, 242, 0.35) !important",
    },
    ".cm-scroller": { overflow: "auto", lineHeight: 1.6 },
    // Marks the statement the user is inspecting.
    ".cm-highlightedStatement": {
      backgroundColor: "rgba(107, 98, 242, 0.14)",
      borderLeft: "2px solid rgba(107, 98, 242, 0.7)",
    },
  },
  { dark: true }
);

/**
 * SQL editor. Exposes `revealLine(line)` so the lineage views can scroll the
 * source to the statement a field belongs to.
 */
export const SqlEditor = forwardRef(({ value, onChange, dialect }, ref) => {
  const viewRef = useRef(null);

  const extensions = useMemo(
    () => [sql({ dialect: CM_DIALECTS[dialect] ?? StandardSQL, upperCaseKeywords: false }), editorTheme, EditorView.lineWrapping],
    [dialect]
  );

  useImperativeHandle(ref, () => ({
    revealLine(line) {
      const view = viewRef.current;
      if (!view || !line) return;
      const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
      const pos = view.state.doc.line(clamped).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 60 }),
      });
      view.focus();
    },
  }));

  return (
    <CodeMirror
      value={value}
      height="100%"
      theme="dark"
      extensions={extensions}
      onChange={onChange}
      onCreateEditor={(view) => {
        viewRef.current = view;
      }}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        autocompletion: false,
        bracketMatching: true,
        closeBrackets: false,
        searchKeymap: true,
      }}
      style={{ height: "100%", overflow: "hidden" }}
    />
  );
});

SqlEditor.displayName = "SqlEditor";

export default SqlEditor;
