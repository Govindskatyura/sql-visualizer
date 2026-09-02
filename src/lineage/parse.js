// Turns a SQL script into a normalized statement/relation model.
//
// node-sql-parser is the primary engine. Its AST shape varies between dialects
// (a column name may be a string, {value}, or {expr:{value}}), so every read of
// the AST goes through a defensive accessor. Statements the parser rejects fall
// back to a heuristic reader so one exotic statement never blanks the whole view.

import { Parser } from "node-sql-parser";
import { splitStatements, splitTopLevel, findKeyword, blankComments } from "./scanner";
import { DIALECTS, AUTO, detectDialect } from "./dialects";

const parser = new Parser();

let nextId = 0;
const uid = (prefix) => `${prefix}_${(nextId += 1)}`;

// ---------------------------------------------------------------- AST helpers

/** Reads a name that the parser may encode as a string, {value} or {expr:{value}}. */
function nameOf(node) {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(nameOf).filter(Boolean).join(".");
  if (typeof node.value === "string") return node.value;
  if (node.expr) return nameOf(node.expr);
  if (typeof node.name === "string") return node.name;
  return null;
}

/** Deep-walks any AST node collecting every column reference it contains. */
function collectColumnRefs(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectColumnRefs(item, out);
    return out;
  }
  if (node.type === "column_ref") {
    const column = nameOf(node.column);
    if (column) out.push({ table: nameOf(node.table), column });
  }
  for (const key of Object.keys(node)) {
    if (key === "type") continue;
    collectColumnRefs(node[key], out);
  }
  return out;
}

const LITERAL_TYPES = new Set([
  "number",
  "bool",
  "null",
  "string",
  "single_quote_string",
  "double_quote_string",
  "hex_string",
  "bit_string",
  "var_string",
  "origin",
]);

/** Renders an AST expression back to readable SQL. Used when raw text is unavailable. */
function exprToText(node) {
  if (node == null) return "";
  if (typeof node !== "object") return String(node);
  if (Array.isArray(node)) return node.map(exprToText).join(", ");

  switch (node.type) {
    case "column_ref": {
      const table = nameOf(node.table);
      const column = nameOf(node.column) ?? "*";
      return table ? table + "." + column : column;
    }
    case "star":
      return "*";
    case "single_quote_string":
    case "string":
      return "'" + node.value + "'";
    case "double_quote_string":
      return '"' + node.value + '"';
    case "expr_list":
      return exprToText(node.value);
    case "binary_expr":
      return exprToText(node.left) + " " + node.operator + " " + exprToText(node.right);
    case "unary_expr":
      return node.operator + " " + exprToText(node.expr);
    case "aggr_func": {
      const distinct = node.args && node.args.distinct ? "DISTINCT " : "";
      const args = node.args && node.args.expr !== undefined ? node.args.expr : node.args;
      return node.name + "(" + distinct + exprToText(args) + ")";
    }
    case "window_func":
      return nameOf(node.name) + "(" + exprToText(node.args) + ") OVER (...)";
    case "function":
      return nameOf(node.name) + "(" + exprToText(node.args) + ")";
    case "cast":
      return "CAST(" + exprToText(node.expr) + " AS " + (nameOf(node.target) ?? "?") + ")";
    case "case": {
      const arms = (node.args ?? [])
        .map((arm) =>
          arm.type === "when"
            ? "WHEN " + exprToText(arm.cond) + " THEN " + exprToText(arm.result)
            : "ELSE " + exprToText(arm.result)
        )
        .join(" ");
      return "CASE " + arms + " END";
    }
    case "interval":
      return ("INTERVAL " + exprToText(node.expr) + " " + (node.unit ?? "")).trim();
    case "select":
      return "(subquery)";
    default:
      break;
  }

  if (LITERAL_TYPES.has(node.type)) return String(node.value);
  if (node.value !== undefined) return String(nameOf(node) ?? node.value);
  if (node.expr) return exprToText(node.expr);
  return "";
}

// -------------------------------------------------------------- raw SQL slices

const TRAILING_CLAUSES = [
  "from",
  "where",
  "group by",
  "order by",
  "limit",
  "qualify",
  "having",
  "window",
  "union",
];

/** Extracts the raw text of a select list, so users see the expression they wrote. */
function rawSelectList(fragment) {
  const selectAt = findKeyword(fragment, "select");
  if (selectAt === -1) return null;

  let start = selectAt + "select".length;
  // Skip set quantifiers so they are not mistaken for the first column.
  const quantifier = /^\s*(distinct|all)\b/i.exec(fragment.slice(start));
  if (quantifier) start += quantifier[0].length;

  let end = fragment.length;
  for (const clause of TRAILING_CLAUSES) {
    const at = findKeyword(fragment, clause, start);
    if (at !== -1 && at < end) end = at;
  }

  const list = fragment.slice(start, end);
  return list.trim() ? splitTopLevel(list, ",") : null;
}

const ALIAS_KEYWORDS = new Set([
  "from",
  "where",
  "and",
  "or",
  "end",
  "then",
  "else",
  "when",
  "as",
  "distinct",
]);

/** Splits `expr AS alias` / `expr alias` into its two halves. */
function splitAlias(item) {
  const asAt = findKeyword(item, "as");
  if (asAt !== -1) {
    const alias = item
      .slice(asAt + 2)
      .trim()
      .replace(/^["`[]|["`\]]$/g, "");
    if (alias && !alias.includes(" ")) {
      return { expression: item.slice(0, asAt).trim(), alias };
    }
  }
  // Implicit alias: a bare identifier after the expression, e.g. `a.id user_id`.
  const implicit = /(^|[\s)`"\]])([A-Za-z_][\w$]*)\s*$/.exec(item);
  if (implicit) {
    const alias = implicit[2];
    const head = item.slice(0, item.length - alias.length).trim();
    const headEndsCleanly = /[)\w`"\]]$/.test(head);
    if (head && headEndsCleanly && !ALIAS_KEYWORDS.has(alias.toLowerCase())) {
      return { expression: head, alias };
    }
  }
  return { expression: item.trim(), alias: null };
}

/** Finds the balanced-paren body starting at `open` (index of the open paren). */
function balancedBody(text, open) {
  const masked = blankComments(text);
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === "(") depth += 1;
    else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i };
    }
  }
  return { body: text.slice(open + 1), end: text.length };
}

/** Maps CTE name -> the raw SQL inside its parentheses. */
function extractCteFragments(statementText) {
  const fragments = {};
  const withAt = findKeyword(statementText, "with");
  if (withAt === -1) return fragments;

  const masked = blankComments(statementText);
  const re = /([A-Za-z_][\w$]*)\s*(?:\([^)]*\)\s*)?\bAS\b\s*(?:NOT\s+MATERIALIZED\s*|MATERIALIZED\s*)?\(/gi;
  re.lastIndex = withAt;
  let match;
  while ((match = re.exec(masked)) !== null) {
    const open = match.index + match[0].length - 1;
    const { body, end } = balancedBody(statementText, open);
    fragments[match[1].toLowerCase()] = body;
    re.lastIndex = end;
  }
  return fragments;
}

/** The part of the statement after any WITH clause -- the outer query. */
function outerFragment(statementText) {
  const withAt = findKeyword(statementText, "with");
  if (withAt === -1) return statementText;
  const fragments = extractCteFragments(statementText);
  const names = Object.keys(fragments);
  if (!names.length) return statementText;
  const lastBody = fragments[names[names.length - 1]];
  const at = statementText.indexOf(lastBody);
  return at === -1 ? statementText : statementText.slice(at + lastBody.length + 1);
}

// ------------------------------------------------------------------ relations

/** Builds the source list (FROM/JOIN) for one select AST node. */
function buildSources(ast, scope) {
  const sources = [];
  const from = Array.isArray(ast && ast.from) ? ast.from : [];

  for (const item of from) {
    if (!item) continue;
    const alias = nameOf(item.as);

    if (item.type === "unnest") {
      const ref = collectColumnRefs(item.expr)[0];
      sources.push({
        id: uid("src"),
        name: alias ?? "unnest",
        alias,
        kind: "unnest",
        parent: ref ? (ref.table ? ref.table + "." : "") + ref.column : null,
        join: item.join ?? null,
        on: item.on ? exprToText(item.on) : null,
      });
      continue;
    }

    const subAst =
      (item.expr && item.expr.ast) || (item.expr && item.expr.type === "select" ? item.expr : null);
    if (subAst) {
      sources.push({
        id: uid("src"),
        name: alias ?? "subquery",
        alias,
        kind: "subquery",
        relation: buildRelation(subAst, null, scope),
        join: item.join ?? null,
        on: item.on ? exprToText(item.on) : null,
      });
      continue;
    }

    const table = nameOf(item.table);
    if (!table) continue;
    const db = nameOf(item.db);
    const qualified = db ? db + "." + table : table;
    sources.push({
      id: uid("src"),
      name: qualified,
      alias,
      kind: scope.has(table.toLowerCase()) ? "cte" : "table",
      join: item.join ?? null,
      on: item.on ? exprToText(item.on) : null,
    });
  }

  return sources;
}

/** alias/table name (lowercased) -> source, for resolving `a.col` prefixes. */
function aliasIndex(sources) {
  const index = new Map();
  for (const source of sources) {
    if (source.alias) index.set(source.alias.toLowerCase(), source);
    if (source.name) {
      index.set(source.name.toLowerCase(), source);
      const bare = source.name.split(".").pop();
      if (bare) index.set(bare.toLowerCase(), source);
    }
  }
  return index;
}

/**
 * Attributes a column expression to its source relation(s).
 * Unqualified names bind to the only source when there is one, and are reported
 * as ambiguous otherwise -- the old code silently colored them by the first table.
 */
function resolveRefs(refs, sources, index) {
  const resolved = [];
  for (const ref of refs) {
    if (ref.column === "*" && !ref.table) continue;
    if (ref.table) {
      const source = index.get(ref.table.toLowerCase());
      resolved.push({
        column: ref.column,
        table: ref.table,
        sourceId: source ? source.id : null,
        sourceName: source ? source.name : ref.table,
        status: source ? "resolved" : "unknown",
      });
    } else if (sources.length === 1) {
      resolved.push({
        column: ref.column,
        table: sources[0].alias ?? sources[0].name,
        sourceId: sources[0].id,
        sourceName: sources[0].name,
        status: "inferred",
      });
    } else {
      resolved.push({
        column: ref.column,
        table: null,
        sourceId: null,
        sourceName: null,
        status: sources.length ? "ambiguous" : "unknown",
        candidates: sources.map((s) => s.name),
      });
    }
  }

  // De-duplicate: `a.x + a.x` is one dependency.
  const seen = new Set();
  return resolved.filter((r) => {
    const key = (r.sourceName ?? "?") + "." + r.column;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Builds a relation from a select AST, merging any UNION / INTERSECT / EXCEPT
 * branches. A set operation's output column draws from the column at the same
 * position in every branch, so all of those are real sources for it; the output
 * names come from the first branch, as SQL specifies.
 */
function buildRelation(ast, rawFragment, scope) {
  const relation = buildSingleRelation(ast, rawFragment, scope);
  if (!ast || !ast._next) return relation;

  const setOps = [];
  let branch = ast._next;
  let operator = ast.set_op;

  while (branch) {
    setOps.push(operator ?? "union");
    // Only the first branch's raw text is locatable, so later branches render
    // their expressions from the AST.
    const next = buildSingleRelation(branch, null, scope);

    relation.sources.push(...next.sources);
    relation.joins.push(...next.joins);

    next.columns.forEach((column, i) => {
      const target = relation.columns[i];
      if (!target) {
        relation.columns.push(column);
        return;
      }
      const seen = new Set(target.refs.map((r) => `${r.sourceName ?? "?"}.${r.column}`));
      for (const ref of column.refs) {
        const key = `${ref.sourceName ?? "?"}.${ref.column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        target.refs.push(ref);
      }
      if (column.expression && column.expression !== target.expression) {
        target.branchExpressions = [...(target.branchExpressions ?? []), column.expression];
      }
    });

    operator = branch.set_op;
    branch = branch._next;
  }

  relation.setOps = setOps;
  return relation;
}

/** Builds columns/sources/joins for a single select block (no set operations). */
function buildSingleRelation(ast, rawFragment, scope) {
  const sources = buildSources(ast, scope);
  const index = aliasIndex(sources);
  const astColumns = Array.isArray(ast && ast.columns) ? ast.columns : [];
  const rawItems = rawFragment ? rawSelectList(rawFragment) : null;
  const useRaw = rawItems && rawItems.length === astColumns.length;

  const columns = astColumns.map((col, i) => {
    const expr = col && col.expr !== undefined ? col.expr : col;
    const rawItem = useRaw ? rawItems[i] : null;
    const rawSplit = rawItem ? splitAlias(rawItem) : null;

    const isStar = nameOf(expr && expr.column) === "*" || (expr && expr.type === "star") || col === "*";
    const starTable = isStar ? nameOf(expr && expr.table) : null;
    const starSourceEntry = starTable ? index.get(starTable.toLowerCase()) : null;

    const alias = nameOf(col && col.as) ?? (rawSplit ? rawSplit.alias : null);
    const expression = (rawSplit ? rawSplit.expression : null) ?? exprToText(expr) ?? "";
    const refs = collectColumnRefs(expr);

    let name = alias;
    if (!name) {
      if (isStar) name = starTable ? starTable + ".*" : "*";
      else if (refs.length === 1 && expression.replace(/^[\w$]+\./, "") === refs[0].column)
        name = refs[0].column;
      else name = expression || "col_" + (i + 1);
    }

    return {
      id: uid("col"),
      name,
      alias,
      expression: expression || name,
      isStar,
      starSource: starSourceEntry ? starSourceEntry.id : null,
      isComputed: !isStar && refs.length !== 1,
      refs: resolveRefs(refs, sources, index),
    };
  });

  const joins = sources
    .filter((s) => s.join)
    .map((s) => ({ type: s.join, target: s.name, alias: s.alias, on: s.on }));

  const groupByNodes = (ast && ast.groupby && ast.groupby.columns) || (ast && ast.groupby) || [];

  return {
    sources,
    columns,
    joins,
    where: ast && ast.where ? exprToText(ast.where) : null,
    groupBy: (Array.isArray(groupByNodes) ? groupByNodes : []).map(exprToText).filter(Boolean),
  };
}

// ----------------------------------------------------------------- statements

/** Reads a statement's target table, keeping any schema/database prefix. */
function targetName(tableNode) {
  const entry = Array.isArray(tableNode) ? tableNode[0] : tableNode;
  if (!entry) return null;
  const table = nameOf(entry.table ?? entry);
  if (!table) return null;
  const db = nameOf(entry.db);
  return db ? db + "." + table : table;
}

/** Unwraps the select AST out of SELECT / CTAS / INSERT-SELECT / CREATE VIEW. */
function classify(ast) {
  if (!ast) return { kind: "other", selectAst: null, target: null };
  const node = Array.isArray(ast) ? ast[0] : ast;
  if (!node) return { kind: "other", selectAst: null, target: null };

  if (node.type === "select") return { kind: "select", selectAst: node, target: null };

  if (node.type === "create") {
    const target = targetName(node.table);
    const selectAst = node.query_expr ?? node.as_select ?? node.definition ?? null;
    if (selectAst && selectAst.type === "select") {
      return {
        kind: node.keyword === "view" ? "create_view" : "create_table_as",
        selectAst,
        target,
      };
    }
    return { kind: "create", selectAst: null, target };
  }

  if (node.type === "insert" || node.type === "replace") {
    const target = targetName(node.table);
    const selectAst = node.values && node.values.type === "select" ? node.values : null;
    return { kind: selectAst ? "insert_select" : "insert", selectAst, target };
  }

  return { kind: node.type ?? "other", selectAst: null, target: null };
}

/** Last-resort reader for statements node-sql-parser cannot handle. */
function heuristicStatement(text) {
  const clean = blankComments(text);
  const sources = [];
  const re = /\b(?:from|join)\s+([`"[]?[\w.$-]+[`"\]]?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
  let match;
  while ((match = re.exec(clean)) !== null) {
    const name = match[1].replace(/^[`"[]|[`"\]]$/g, "");
    const alias =
      match[2] && !/^(on|where|left|right|inner|full|cross|join|group|order|using|limit)$/i.test(match[2])
        ? match[2]
        : null;
    if (!sources.some((s) => s.name === name && s.alias === alias)) {
      sources.push({ id: uid("src"), name, alias, kind: "table", join: null, on: null });
    }
  }

  const index = aliasIndex(sources);
  const items = rawSelectList(text) ?? [];
  const columns = items.map((item, i) => {
    const { expression, alias } = splitAlias(item);
    const refs = [];
    const refRe = /([A-Za-z_][\w$]*)\.([A-Za-z_*][\w$]*)|(?:^|[\s(,])([A-Za-z_][\w$]*)(?=\s*$|\s*[,)])/g;
    let m;
    while ((m = refRe.exec(expression)) !== null) {
      if (m[1]) refs.push({ table: m[1], column: m[2] });
      else if (m[3] && !/^(distinct|all|null|true|false)$/i.test(m[3]))
        refs.push({ table: null, column: m[3] });
    }
    const isStar = expression.trim() === "*" || /\.\*$/.test(expression.trim());
    return {
      id: uid("col"),
      name: alias ?? expression ?? "col_" + (i + 1),
      alias,
      expression,
      isStar,
      starSource: null,
      isComputed: !isStar && refs.length !== 1,
      refs: resolveRefs(refs, sources, index),
    };
  });

  return { sources, columns, joins: [], where: null, groupBy: [] };
}

function parseStatement(statement, dialect) {
  const base = {
    id: uid("stmt"),
    index: statement.index,
    startLine: statement.startLine,
    text: statement.text,
  };

  let ast = null;
  let parseError = null;
  try {
    ast = parser.astify(statement.text, { database: dialect });
  } catch (error) {
    parseError = (error && error.message) || String(error);
  }

  if (!ast) {
    // Only worth showing if it actually looks like a query.
    const relation = heuristicStatement(statement.text);
    const isQuery = relation.columns.length > 0 || relation.sources.length > 0;
    return {
      ...base,
      kind: isQuery ? "select" : "other",
      target: null,
      ctes: [],
      relation: isQuery ? relation : null,
      parseError,
      degraded: true,
    };
  }

  const { kind, selectAst, target } = classify(ast);
  const cteFragments = extractCteFragments(statement.text);
  const root = Array.isArray(ast) ? ast[0] : ast;
  const withNodes = (root && root.with) || (selectAst && selectAst.with) || [];
  const scope = new Set();
  const ctes = [];

  for (const node of Array.isArray(withNodes) ? withNodes : []) {
    const name = nameOf(node && node.name);
    if (!name) continue;
    const stmt = (node.stmt && node.stmt.ast) || node.stmt;
    // CTEs may reference earlier CTEs, so register each before building the next.
    const relation = buildRelation(stmt, cteFragments[name.toLowerCase()] ?? null, scope);
    scope.add(name.toLowerCase());
    ctes.push({ id: uid("cte"), name, relation });
  }

  const relation = selectAst
    ? buildRelation(selectAst, kind === "select" ? outerFragment(statement.text) : null, scope)
    : null;

  return { ...base, kind, target, ctes, relation, parseError: null, degraded: false };
}

const DETECTION_SAMPLE = 12;

/** Picks `count` statements spread across the script, so late syntax still counts. */
function evenSample(statements, count) {
  const step = statements.length / count;
  const picked = [];
  for (let i = 0; i < count; i += 1) picked.push(statements[Math.floor(i * step)]);
  return picked;
}

/** Parses a whole script. `dialect` may be a dialect id or AUTO. */
export function parseScript(sql, dialect = AUTO) {
  nextId = 0;
  const raw = splitStatements(sql).map((s, index) => ({ ...s, index }));

  let resolvedDialect = dialect;
  let detection = null;

  if (dialect === AUTO) {
    if (!raw.length) {
      return {
        dialect: "PostgresQL",
        detected: null,
        statements: [],
        stats: { total: 0, parsed: 0, degraded: 0 },
      };
    }
    // Detection reads a sample rather than the whole script: dialect is a
    // property of the syntax, so a dozen statements settle it, and parsing
    // hundreds of them once per candidate is too slow to run on every edit.
    const sample = raw.length <= DETECTION_SAMPLE ? raw : evenSample(raw, DETECTION_SAMPLE);
    const countParsed = (id) =>
      sample.reduce((n, s) => {
        try {
          parser.astify(s.text, { database: id });
          return n + 1;
        } catch {
          return n;
        }
      }, 0);
    detection = detectDialect(sql, countParsed, sample.length);
    resolvedDialect = detection.id;
  }

  if (!DIALECTS.some((d) => d.id === resolvedDialect)) resolvedDialect = "PostgresQL";

  const statements = raw.map((s) => parseStatement(s, resolvedDialect));

  return {
    dialect: resolvedDialect,
    detected: detection,
    statements,
    stats: {
      total: statements.length,
      parsed: statements.filter((s) => !s.degraded).length,
      degraded: statements.filter((s) => s.degraded).length,
    },
  };
}
