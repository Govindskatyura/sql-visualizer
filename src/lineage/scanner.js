// Character-level SQL scanner.
//
// Everything downstream depends on knowing which characters are "real" SQL and
// which are inside a string, comment or quoted identifier. The old regex-based
// parser had no such notion, so a semicolon inside a string literal split a
// statement in half and `-- from foo` was read as a real FROM clause.

const LINE_COMMENT_STARTS = [
  ["--", 2],
  ["#", 1], // MySQL / Hive
];

// Quote char -> closing char. Backtick (MySQL/BigQuery/Hive/Spark) and bracket
// (T-SQL) quote identifiers; single quotes hold strings; double quotes are
// identifiers in ANSI/Postgres and strings in MySQL -- either way we skip them.
const QUOTE_PAIRS = { "'": "'", '"': '"', "`": "`", "[": "]" };

/**
 * Walks `sql` and reports, for every index, whether it sits in code or in a
 * string/comment. Returns a Uint8Array mask: 1 = skippable (string/comment).
 */
export function maskLiterals(sql) {
  const mask = new Uint8Array(sql.length);
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // Block comment
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }

    // Line comment
    let lineComment = 0;
    for (const [token, len] of LINE_COMMENT_STARTS) {
      if (sql.startsWith(token, i)) {
        lineComment = len;
        break;
      }
    }
    if (lineComment) {
      let end = sql.indexOf("\n", i);
      if (end === -1) end = sql.length;
      mask.fill(1, i, end);
      i = end;
      continue;
    }

    // Postgres dollar quoting: $$ ... $$ or $tag$ ... $tag$
    if (ch === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const end = sql.indexOf(marker, i + marker.length);
        const stop = end === -1 ? sql.length : end + marker.length;
        mask.fill(1, i, stop);
        i = stop;
        continue;
      }
    }

    // Quoted string or identifier
    const closer = QUOTE_PAIRS[ch];
    if (closer) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\" && closer !== "]") {
          j += 2; // backslash escape (MySQL-style); never applies inside [ ]
          continue;
        }
        if (sql[j] === closer) {
          // Doubled quote is an escaped quote, not a terminator.
          if (sql[j + 1] === closer) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      mask.fill(1, i, Math.min(j, sql.length));
      i = j;
      continue;
    }

    i += 1;
  }

  return mask;
}

/** Line number (1-based) of a character offset. */
function lineAt(sql, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i += 1) {
    if (sql[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Splits a script into statements on top-level semicolons, ignoring semicolons
 * inside strings, comments and parentheses. Unlike the previous
 * `input.slice(0, lastIndexOf(";")).split(";")`, a trailing statement with no
 * terminating semicolon is kept.
 */
export function splitStatements(sql) {
  const mask = maskLiterals(sql);
  const statements = [];
  let depth = 0;
  let start = 0;

  const push = (from, to) => {
    const text = sql.slice(from, to);
    if (!text.trim()) return;
    const lead = text.length - text.trimStart().length;
    // The reported line should point at the SQL, not at a comment block sitting
    // above it -- otherwise "jump to statement" lands on the wrong place.
    let codeAt = from + lead;
    for (let i = from; i < to; i += 1) {
      if (!mask[i] && !/\s/.test(sql[i])) {
        codeAt = i;
        break;
      }
    }
    statements.push({
      text: text.trim(),
      start: from + lead,
      end: to,
      startLine: lineAt(sql, codeAt),
    });
  };

  for (let i = 0; i < sql.length; i += 1) {
    if (mask[i]) continue;
    const ch = sql[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, sql.length);

  return statements;
}

/**
 * Splits on a delimiter at paren depth 0, skipping strings and comments.
 * Used for select lists, where `coalesce(a, b)` must stay one item -- the old
 * comma-splitting regex tore such expressions apart.
 */
export function splitTopLevel(sql, delimiter = ",") {
  const mask = maskLiterals(sql);
  const parts = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < sql.length; i += 1) {
    if (mask[i]) continue;
    const ch = sql[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === delimiter && depth === 0) {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));

  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Finds a keyword at paren depth 0 outside strings/comments.
 * Returns the match offset, or -1.
 */
export function findKeyword(sql, keyword, fromIndex = 0) {
  const mask = maskLiterals(sql);
  const upper = sql.toUpperCase();
  const needle = keyword.toUpperCase();
  let depth = 0;

  for (let i = 0; i < sql.length; i += 1) {
    if (i >= fromIndex && !mask[i] && depth === 0 && upper.startsWith(needle, i)) {
      const before = i === 0 ? " " : sql[i - 1];
      const after = sql[i + needle.length] ?? " ";
      if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) return i;
    }
    if (mask[i]) continue;
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") depth = Math.max(0, depth - 1);
  }

  return -1;
}

/** Replaces comments with spaces, preserving offsets. */
export function blankComments(sql) {
  const out = sql.split("");
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      for (let k = i; k < stop; k += 1) if (out[k] !== "\n") out[k] = " ";
      i = stop;
      continue;
    }
    if (sql.startsWith("--", i) || sql[i] === "#") {
      let end = sql.indexOf("\n", i);
      if (end === -1) end = sql.length;
      for (let k = i; k < end; k += 1) out[k] = " ";
      i = end;
      continue;
    }
    const closer = QUOTE_PAIRS[sql[i]];
    if (closer) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\" && closer !== "]") { j += 2; continue; }
        if (sql[j] === closer) {
          if (sql[j + 1] === closer) { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}
