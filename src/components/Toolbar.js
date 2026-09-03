import { useRef } from "react";
import { DIALECTS, LANGUAGES, AUTO, dialectLabel } from "../lineage/dialects";

/**
 * The favicon mark, inline so it inherits the dark theme rather than sitting on
 * the white ground the browser-tab version needs.
 */
function BrandMark() {
  return (
    <svg className="toolbar__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="13.2" y="13" width="5.6" height="11" fill="#6b62f2" />
      <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round">
        <rect x="6.25" y="7.25" width="19.5" height="17.5" rx="2.75" />
        <path d="M6.25 13h19.5" />
      </g>
    </svg>
  );
}

export default function Toolbar({
  dialect,
  onDialectChange,
  resolvedDialect,
  detected,
  language,
  stats,
  view,
  onViewChange,
  search,
  onSearchChange,
  onLoadFile,
  onLoadSample,
}) {
  const fileRef = useRef(null);

  const handleFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onLoadFile(String(reader.result ?? ""));
    reader.readAsText(file);
    // Allow re-picking the same file.
    event.target.value = "";
  };

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <BrandMark />
        {/* The only h1 on the page: gives the document a heading for crawlers
            and screen readers, which a styled span does not. */}
        <h1 className="toolbar__title">SQL Visualizer</h1>
      </div>

      <div className="toolbar__group">
        <label className="field">
          <span className="field__label">Dialect</span>
          <select
            className="select"
            value={dialect}
            onChange={(event) => onDialectChange(event.target.value)}
          >
            <option value={AUTO}>Auto-detect</option>
            {/* SAS is a language rather than a dialect -- DATA steps and PROCs
                are not SQL -- so it is offered apart from the SQL grammars. */}
            <optgroup label="SQL dialects">
              {DIALECTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Other languages">
              {LANGUAGES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        {dialect === AUTO && detected && (
          <span className="pill pill--quiet" title="Chosen by parsing the script with each dialect">
            detected {dialectLabel(resolvedDialect)}
          </span>
        )}

        {stats.total > 0 && (
          <span className={`pill ${stats.degraded ? "pill--warn" : "pill--ok"}`}>
            {stats.parsed}/{stats.total} {language === "sas" ? "steps" : "statements"} parsed
          </span>
        )}
      </div>

      <div className="toolbar__group toolbar__group--grow">
        <input
          className="input"
          type="search"
          placeholder="Find a field…"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      <div className="toolbar__group">
        <div className="tabs" role="tablist">
          {[
            ["statements", "Statements"],
            ["graph", "Graph"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              className={`tab ${view === id ? "is-active" : ""}`}
              onClick={() => onViewChange(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="button button--ghost"
          onClick={() => onLoadSample("sql")}
        >
          SQL sample
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => onLoadSample("sas")}
        >
          SAS sample
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={() => fileRef.current?.click()}
          title="Open a .sql or .sas file"
        >
          Open file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".sql,.sas,.txt"
          onChange={handleFile}
          style={{ display: "none" }}
        />
      </div>
    </header>
  );
}
