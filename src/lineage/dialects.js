// Dialect registry and auto-detection.

// `id` is what node-sql-parser expects for its `database` option.
export const DIALECTS = [
  { id: "PostgresQL", label: "PostgreSQL" },
  { id: "MySQL", label: "MySQL" },
  { id: "MariaDB", label: "MariaDB" },
  { id: "BigQuery", label: "BigQuery" },
  { id: "Snowflake", label: "Snowflake" },
  { id: "Redshift", label: "Redshift" },
  { id: "Hive", label: "Hive" },
  { id: "FlinkSQL", label: "Flink SQL" },
  { id: "Trino", label: "Trino / Presto" },
  { id: "Athena", label: "Athena" },
  { id: "Sqlite", label: "SQLite" },
  { id: "TransactSQL", label: "T-SQL (SQL Server)" },
  { id: "DB2", label: "Db2" },
  { id: "Noql", label: "Generic ANSI" },
];

export const AUTO = "auto";

// SAS is a language, not a SQL dialect: its DATA steps and PROCs have no SQL
// grammar, and its PROC SQL blocks are parsed with a SQL engine chosen inside
// the SAS reader. It therefore sits outside DIALECTS -- which is exactly the
// list of ids node-sql-parser understands -- but is offered in the picker.
export const SAS = "SAS";

export const LANGUAGES = [{ id: SAS, label: "SAS" }];

export const DIALECT_OPTIONS = [
  { id: AUTO, label: "Auto-detect" },
  ...DIALECTS,
  ...LANGUAGES,
];

export function dialectLabel(id) {
  if (id === AUTO) return "Auto-detect";
  return (
    DIALECTS.find((d) => d.id === id)?.label ??
    LANGUAGES.find((l) => l.id === id)?.label ??
    id
  );
}

// Syntax fingerprints. Each hit adds to a dialect's score; used to break ties
// when several dialects parse a script equally well (a plain ANSI query parses
// everywhere, so parse rate alone cannot pick a winner).
const FINGERPRINTS = [
  { re: /\bunnest\s*\(/i, dialects: ["BigQuery", "Trino", "Athena"], weight: 2 },
  { re: /`[\w-]+\.[\w-]+\.[\w-]+`/, dialects: ["BigQuery"], weight: 4 },
  { re: /\b_table_suffix\b/i, dialects: ["BigQuery"], weight: 4 },
  { re: /\bstruct\s*</i, dialects: ["BigQuery"], weight: 3 },
  { re: /\bsafe_cast\s*\(|\bsafe\./i, dialects: ["BigQuery"], weight: 3 },
  { re: /\bqualify\b/i, dialects: ["Snowflake", "BigQuery"], weight: 3 },
  { re: /\blateral\s+flatten\b/i, dialects: ["Snowflake"], weight: 4 },
  { re: /\bvariant\b|\bobject_construct\s*\(/i, dialects: ["Snowflake"], weight: 3 },
  { re: /\bilike\b/i, dialects: ["PostgresQL", "Snowflake"], weight: 2 },
  { re: /\breturning\b/i, dialects: ["PostgresQL"], weight: 3 },
  { re: /::\s*\w+/, dialects: ["PostgresQL", "Redshift", "Snowflake"], weight: 2 },
  { re: /\bserial\b|\bjsonb\b/i, dialects: ["PostgresQL"], weight: 3 },
  { re: /\bdistkey\b|\bsortkey\b/i, dialects: ["Redshift"], weight: 4 },
  { re: /\binsert\s+overwrite\b/i, dialects: ["Hive", "FlinkSQL"], weight: 4 },
  { re: /\blateral\s+view\b/i, dialects: ["Hive"], weight: 4 },
  { re: /\bstored\s+as\b|\bdistribute\s+by\b|\bcluster\s+by\b/i, dialects: ["Hive"], weight: 3 },
  { re: /\bengine\s*=/i, dialects: ["MySQL", "MariaDB"], weight: 3 },
  { re: /\blimit\s+\d+\s*,\s*\d+/i, dialects: ["MySQL", "MariaDB"], weight: 3 },
  { re: /\btop\s+\d+\b|\bnolock\b|\[\w+\]/i, dialects: ["TransactSQL"], weight: 3 },
  { re: /\bapprox_distinct\s*\(|\bcardinality\s*\(/i, dialects: ["Trino", "Athena"], weight: 2 },
];

/** Heuristic score per dialect, purely from surface syntax. */
export function fingerprintScores(sql) {
  const scores = {};
  for (const { re, dialects, weight } of FINGERPRINTS) {
    if (!re.test(sql)) continue;
    for (const d of dialects) scores[d] = (scores[d] ?? 0) + weight;
  }
  return scores;
}

/**
 * Picks the dialect that parses the most statements, using fingerprints to
 * break ties. `tryParse(dialectId)` returns how many of `total` statements
 * parsed cleanly.
 *
 * Candidates are tried in fingerprint order and the search stops as soon as one
 * parses everything, so the common case costs a single pass rather than one per
 * dialect -- trying all fourteen on a long script is slow enough to be felt
 * while typing.
 */
export function detectDialect(sql, tryParse, total) {
  const fingerprints = fingerprintScores(sql);

  const candidates = [...DIALECTS].sort(
    (a, b) => (fingerprints[b.id] ?? 0) - (fingerprints[a.id] ?? 0)
  );

  let best = null;
  for (const { id } of candidates) {
    const parsed = tryParse(id);
    const score = fingerprints[id] ?? 0;
    const candidate = { id, parsed, score };

    if (
      !best ||
      candidate.parsed > best.parsed ||
      (candidate.parsed === best.parsed && candidate.score > best.score)
    ) {
      best = candidate;
    }

    if (best.parsed === total) break;
  }

  return best ?? { id: "PostgresQL", parsed: 0, score: 0 };
}
