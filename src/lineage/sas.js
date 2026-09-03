// Turns a SAS program into the same statement/relation model the SQL path
// produces, so the lineage graph, the trace panel and the views need no
// knowledge that SAS was involved.
//
// Two engines feed that model:
//   * PROC SQL blocks are unwrapped and handed to the SQL parser, after the
//     SAS-only spellings (CALCULATED, column LABEL=/FORMAT=, SELECT ... INTO)
//     are normalized away.
//   * DATA steps and the table-shaped PROCs (SORT, TRANSPOSE, SUMMARY, APPEND,
//     ...) are read here, because no SQL grammar describes them.
//
// A DATA step carries every variable of every SET/MERGE dataset forward unless
// told otherwise, so it is modelled as `select *` plus one column per
// assignment -- the same shape `SELECT *, a + b AS total` would produce.

import { splitSasStatements, blankSasComments, balancedBody } from "./sasScanner";

// PROC SQL is close enough to ANSI that a real grammar reads it; Postgres is
// the most forgiving of the engines available and accepts CREATE TABLE AS,
// comma joins and the function calls SAS scripts actually contain.
export const SAS_SQL_ENGINE = "PostgresQL";

let nextId = 0;
const uid = (prefix) => `sas${prefix}_${(nextId += 1)}`;

const lower = (s) => String(s ?? "").toLowerCase();

// ------------------------------------------------------------------ detection

// A SAS program announces itself loudly: PROC/RUN/QUIT step boundaries and
// `data x;` have no SQL reading. Weighted so one strong signal is enough but no
// single weak one (a table called `data`) can flip a SQL script.
const SAS_SIGNALS = [
  { re: /\bproc\s+sql\b/i, weight: 6 },
  { re: /\bproc\s+\w+[^;]*\bdata\s*=/i, weight: 5 },
  { re: /^[ \t]*data\s+[\w.&$]+[^;]*;/im, weight: 4 },
  { re: /^[ \t]*(set|merge)\s+[\w.&$]+[^;]*;/im, weight: 3 },
  { re: /^[ \t]*%(let|macro|mend|include|put)\b/im, weight: 3 },
  { re: /^[ \t]*libname\s+\w+/im, weight: 3 },
  { re: /^[ \t]*(run|quit)\s*;/im, weight: 2 },
];

/** Weighted syntax score; 5 or more is treated as SAS. */
export function sasScore(text) {
  return SAS_SIGNALS.reduce((n, { re, weight }) => (re.test(text) ? n + weight : n), 0);
}

export function looksLikeSas(text) {
  return sasScore(text) >= 5;
}

// ------------------------------------------------------------ macro variables

/** Resolves `&name` / `&name.` / `&&name` against the values seen so far. */
function applyMacroVars(text, vars) {
  let out = text;
  for (let pass = 0; pass < 3 && out.includes("&"); pass += 1) {
    const next = out.replace(/&&?([A-Za-z_]\w*)\.?/g, (_, name) => {
      const value = vars.get(lower(name));
      // An unresolved reference still has to yield a parsable identifier, so it
      // becomes a visible placeholder rather than a syntax error.
      return value !== undefined ? value : `mv_${name}`;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

// --------------------------------------------------------------------- names

/**
 * SAS resolves a one-level name against the WORK library, so `orders` and
 * `work.orders` are the same dataset -- qualifying makes that visible and lets
 * a PROC SQL table and a DATA step target land on one node.
 */
export function qualifyDataset(name) {
  if (!name) return name;
  const clean = String(name).replace(/^["']|["']$/g, "");
  if (clean.includes(".") || /^_null_$/i.test(clean)) return clean;
  return `work.${clean}`;
}

const splitNames = (value) =>
  String(value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

// ---------------------------------------------------------- dataset references

/** Reads `keep=a b rename=(x=y) where=(amt>0)` into an option map. */
function parseDatasetOptions(body) {
  const options = {};
  let i = 0;

  while (i < body.length) {
    const head = /^\s*([A-Za-z_]\w*)\s*=\s*/.exec(body.slice(i));
    if (!head) {
      i += 1;
      continue;
    }
    i += head[0].length;
    const key = lower(head[1]);

    if (body[i] === "(") {
      const { body: inner, end } = balancedBody(body, i);
      options[key] = inner.trim();
      i = end + 1;
      continue;
    }

    // Bare value, possibly a list: read tokens until one turns out to be the
    // next option's key (that is, until a token is followed by `=`).
    const start = i;
    while (i < body.length) {
      const token = /^\s*([^\s()=]+)/.exec(body.slice(i));
      if (!token) break;
      const after = i + token[0].length;
      if (/^\s*=/.test(body.slice(after))) break;
      i = after;
    }
    if (i === start) break;
    options[key] = body.slice(start, i).trim();
  }

  return options;
}

/** `lib.a (keep=x) b` -> [{name, keep, drop, rename, where}, ...] */
function parseDatasetList(text) {
  const datasets = [];
  const re = /([A-Za-z_$][\w.$]*)/g;
  let match;

  while ((match = re.exec(text)) !== null) {
    const name = match[1];
    let options = {};
    let cursor = match.index + match[0].length;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] === "(") {
      const { body, end } = balancedBody(text, cursor);
      options = parseDatasetOptions(body);
      re.lastIndex = end + 1;
    }

    const rename = {};
    for (const pair of String(options.rename ?? "").matchAll(/([\w$]+)\s*=\s*([\w$]+)/g)) {
      rename[lower(pair[1])] = pair[2];
    }

    datasets.push({
      name: qualifyDataset(name),
      keep: splitNames(options.keep).map(lower),
      drop: splitNames(options.drop).map(lower),
      rename,
      where: options.where ?? null,
    });
  }

  return datasets;
}

// ------------------------------------------------------------ expression reads

// Operators, control words and automatic variables that are not data columns.
const NOT_A_VARIABLE = new Set([
  "and", "or", "not", "eq", "ne", "lt", "le", "gt", "ge", "in", "of", "to", "by",
  "if", "then", "else", "do", "end", "while", "until", "select", "when",
  "otherwise", "output", "return", "delete", "stop", "missing", "null", "true",
  "false", "_n_", "_error_", "_all_", "_numeric_", "_character_", "_infile_",
  "descending", "notsorted", "calculated", "as", "distinct", "from", "where",
]);

/**
 * Every variable an expression reads. Function names, format specifications
 * (`date9.`), quoted text and numeric exponents are excluded -- treating any of
 * those as a column invents lineage that does not exist.
 */
export function readVariables(expression) {
  const text = String(expression ?? "")
    .replace(/'[^']*'/g, " ' ' ")
    .replace(/"[^"]*"/g, ' " " ');
  const found = [];
  const seen = new Set();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match;

  while ((match = re.exec(text)) !== null) {
    const name = match[0];
    const before = text[match.index - 1] ?? " ";
    const after = text.slice(match.index + name.length);
    if (/[\d.&]/.test(before)) continue; // 1e5, lib.member, &macro
    if (/^\s*\(/.test(after)) continue; // function call
    if (/^\./.test(after)) continue; // format or informat
    if (NOT_A_VARIABLE.has(lower(name))) continue;
    if (seen.has(lower(name))) continue;
    seen.add(lower(name));
    found.push(name);
  }

  return found;
}

// ------------------------------------------------------------ statement reads

const DATA_STEP_NOISE =
  /^(run|quit|by|format|informat|label|length|attrib|array|retain|output|put|file|infile|input|call|stop|return|delete|do|end|select|when|otherwise|abort|list|error|datalines|cards|lines|title\d*|footnote\d*|options|ods|window|display)\b/i;

/**
 * Reads an assignment out of a DATA step statement, seeing through the
 * conditional wrappers SAS allows: `if x then y = 1;` assigns to y.
 *
 * The condition comes back separately because the assigned value depends on it:
 * `if channel = 'web' then group = 'online'` makes `group` a function of
 * `channel`, exactly as the equivalent CASE expression would in SQL.
 */
export function readAssignment(statementText) {
  let text = statementText.trim();
  const conditions = [];

  for (let guard = 0; guard < 6; guard += 1) {
    const before = text;
    text = text.replace(/^else\s+/i, "");
    text = text.replace(/^if\b([\s\S]*?)\bthen\b\s*/i, (_, condition) => {
      conditions.push(condition.trim());
      return "";
    });
    if (text === before) break;
  }

  const build = (name, value) => ({
    name,
    value,
    condition: conditions.join(" and "),
    // A conditional assignment reads better as the line the user wrote.
    expression: conditions.length ? statementText.trim() : value,
    line: statementText.trim(),
  });

  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(text);
  if (
    assignment &&
    !DATA_STEP_NOISE.test(assignment[1]) &&
    !/^(set|merge|update|modify|keep|drop|rename|where|if)$/i.test(assignment[1])
  ) {
    return build(assignment[1], assignment[2].trim());
  }

  // Sum statement: `total + amount;` accumulates into total.
  const sum = /^([A-Za-z_][A-Za-z0-9_]*)\s*\+\s*([\s\S]+)$/.exec(text);
  if (sum && !DATA_STEP_NOISE.test(sum[1])) {
    return build(sum[1], `${sum[1]} + ${sum[2].trim()}`);
  }

  return null;
}

// -------------------------------------------------------------- relation parts

function makeSource(dataset, joinType) {
  return {
    id: uid("src"),
    name: dataset.name,
    alias: null,
    kind: "table",
    join: joinType,
    on: null,
    keep: dataset.keep ?? [],
    drop: dataset.drop ?? [],
    // Reverse map: the step sees `y`, the dataset stores it as `x`.
    unrename: Object.fromEntries(
      Object.entries(dataset.rename ?? {}).map(([from, to]) => [lower(to), from])
    ),
  };
}

function dedupeRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.sourceName ?? "?"}.${ref.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Binds a DATA step variable to the datasets it can come from. SAS has no
 * qualified references, so with several inputs a variable genuinely may come
 * from any of them that could contain it; that is reported rather than guessed.
 * KEEP/DROP on an input narrows the candidates, which is usually enough to make
 * a merge unambiguous.
 */
function refsForVariable(name, sources) {
  const candidates = sources.filter((source) => {
    const key = lower(source.unrename[lower(name)] ?? name);
    if (source.keep.length) return source.keep.includes(key);
    if (source.drop.length) return !source.drop.includes(key);
    return true;
  });

  if (!candidates.length) {
    return [{ column: name, table: null, sourceId: null, sourceName: null, status: "unknown" }];
  }

  return candidates.map((source) => ({
    column: source.unrename[lower(name)] ?? name,
    table: source.name,
    sourceId: source.id,
    sourceName: source.name,
    status: candidates.length === 1 ? "inferred" : "ambiguous",
    candidates: candidates.length === 1 ? undefined : candidates.map((s) => s.name),
  }));
}

function makeColumn(name, expression, refs) {
  return {
    id: uid("col"),
    name,
    alias: null,
    expression: expression || name,
    isStar: false,
    starSource: null,
    isComputed: refs.length !== 1,
    refs: dedupeRefs(refs),
  };
}

/**
 * The implicit pass-through of every variable a SET/MERGE input carries.
 * `excludes` are the variables a DROP took back out, so a dropped column does
 * not reappear in the output when the input's columns are known.
 */
function starColumn(source, only, excludes = []) {
  const name = only ? "*" : `${source.name}.*`;
  return {
    id: uid("col"),
    name,
    alias: null,
    expression: excludes.length ? `${name} except ${excludes.join(", ")}` : name,
    isStar: true,
    starSource: source.id,
    starExcludes: excludes,
    isComputed: false,
    refs: [],
  };
}

// ------------------------------------------------------------------ DATA step

/**
 * Builds one relation per output dataset. A DATA step may write several
 * datasets with different KEEP/DROP/RENAME options, and each is its own node in
 * the lineage.
 */
function buildDataStep(step) {
  const head = step.statements[0].text.replace(/^\s*data\b/i, "");
  const outputs = parseDatasetList(head);

  const sources = [];
  const assignments = [];
  const assignedBy = new Map();
  const by = [];
  const keep = [];
  const drop = [];
  const rename = {};
  let where = null;

  for (const statement of step.statements.slice(1)) {
    const text = statement.text.trim();

    const read = /^(set|merge|update|modify)\b([\s\S]*)$/i.exec(text);
    if (read) {
      const readKind = lower(read[1]);
      for (const dataset of parseDatasetList(read[2])) {
        if (dataset.where && !where) where = dataset.where;
        sources.push(makeSource(dataset, sources.length ? readKind : null));
      }
      continue;
    }

    const byMatch = /^by\b([\s\S]*)$/i.exec(text);
    if (byMatch) {
      by.push(
        ...splitNames(byMatch[1]).filter((n) => !/^(descending|notsorted|groupformat)$/i.test(n))
      );
      continue;
    }

    const whereMatch = /^where\b([\s\S]*)$/i.exec(text);
    if (whereMatch) {
      where = whereMatch[1].trim();
      continue;
    }

    const keepMatch = /^keep\b([\s\S]*)$/i.exec(text);
    if (keepMatch) {
      keep.push(...splitNames(keepMatch[1]));
      continue;
    }

    const dropMatch = /^drop\b([\s\S]*)$/i.exec(text);
    if (dropMatch) {
      drop.push(...splitNames(dropMatch[1]));
      continue;
    }

    const renameMatch = /^rename\b([\s\S]*)$/i.exec(text);
    if (renameMatch) {
      for (const pair of renameMatch[1].matchAll(/([\w$]+)\s*=\s*([\w$]+)/g)) {
        rename[lower(pair[1])] = pair[2];
      }
      continue;
    }

    if (DATA_STEP_NOISE.test(text)) continue;

    const assignment = readAssignment(text);
    if (!assignment) continue;

    // `if a then x = 1; else x = 2;` is one output column with two branches.
    let entry = assignedBy.get(lower(assignment.name));
    if (!entry) {
      entry = { name: assignment.name, expressions: [], lines: [], variables: [] };
      assignedBy.set(lower(assignment.name), entry);
      assignments.push(entry);
    }
    entry.expressions.push(assignment.expression);
    entry.lines.push(assignment.line);
    entry.variables.push(
      ...readVariables(assignment.value),
      ...readVariables(assignment.condition)
    );
  }

  // A variable assigned earlier in the step was not read from a dataset, so its
  // own sources stand in for it -- that is what makes `total = a + b; share =
  // total / n;` trace back to a, b and n.
  const computed = new Map();
  for (const assignment of assignments) {
    const refs = [];
    for (const variable of assignment.variables) {
      const earlier = computed.get(lower(variable));
      // A variable that reads itself (`total = total + amt`) is reading the
      // input dataset, not the value this step is about to give it.
      if (earlier && lower(variable) !== lower(assignment.name)) refs.push(...earlier);
      else refs.push(...refsForVariable(variable, sources));
    }
    assignment.refs = dedupeRefs(refs);
    // One branch shows the value; several only make sense as the lines written.
    assignment.expression =
      assignment.expressions.length === 1
        ? assignment.expressions[0]
        : assignment.lines.join("; ");
    computed.set(lower(assignment.name), assignment.refs);
  }

  const joins = sources.slice(1).map((source) => ({
    type: source.join ?? "set",
    target: source.name,
    alias: null,
    on: by.length ? `by ${by.join(" ")}` : null,
  }));

  const columnsFor = (output) => {
    const columns = [];
    const emitted = new Set();
    const add = (column) => {
      if (emitted.has(lower(column.name))) return;
      emitted.add(lower(column.name));
      columns.push(column);
    };

    const keepList = [...keep, ...output.keep].map(lower);
    const dropList = [...drop, ...output.drop].map(lower);
    const renames = { ...rename, ...output.rename };
    const kept = (name) => {
      const key = lower(name);
      if (dropList.includes(key)) return false;
      return keepList.length ? keepList.includes(key) : true;
    };
    const outName = (name) => renames[lower(name)] ?? name;

    // Assignments first: where a step overwrites a variable it also carries
    // through (`amt = amt / 100`), the expression the user wrote has to win
    // over the pass-through copy of the same name.
    for (const assignment of assignments) {
      if (!kept(assignment.name)) continue;
      add(makeColumn(outName(assignment.name), assignment.expression, assignment.refs));
    }

    // Variables named only in KEEP or RENAME are read straight from the inputs.
    for (const name of [...keepList, ...Object.keys(renames)]) {
      if (!kept(name) || computed.has(lower(name))) continue;
      add(makeColumn(outName(name), name, refsForVariable(name, sources)));
    }

    // Everything else flows through, exactly like `select *`.
    if (!keepList.length) {
      for (const source of sources) add(starColumn(source, sources.length === 1, dropList));
    }

    return columns;
  };

  return outputs.map((output) => ({
    target: /^_null_$/i.test(output.name) ? null : output.name,
    relation: { sources, columns: columnsFor(output), joins, where, groupBy: [] },
  }));
}

// ----------------------------------------------------------------- PROC steps

/** Reads `data=`, `out=`, `base=` and friends off a PROC statement. */
function procOption(text, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*([A-Za-z_$][\\w.$]*)`, "i").exec(text);
  return match ? qualifyDataset(match[1]) : null;
}

/**
 * The table-shaped PROCs. None of them renames columns in a way that can be
 * read in general, so lineage is carried at the table level (`*`) and refined
 * with whatever VAR / BY / OUTPUT statements say.
 */
function buildProcStep(step) {
  const head = step.statements[0].text;
  const procName = lower(/^proc\s+(\w+)/i.exec(head)?.[1] ?? "");

  let input = procOption(head, "data") ?? procOption(head, "base") ?? procOption(head, "table");
  let target = procOption(head, "out") ?? procOption(head, "outtable");
  // PROC APPEND writes into BASE=, which is also one of its inputs.
  if (procName === "append") target = procOption(head, "base");

  // CLASS/ID/COPY variables survive into the output dataset as themselves;
  // VAR variables are the ones a summary collapses into statistics.
  const groupVars = [];
  const analysisVars = [];
  const statVars = [];
  const by = [];
  let where = null;

  for (const statement of step.statements.slice(1)) {
    const text = statement.text.trim();

    const output = /^output\b([\s\S]*)$/i.exec(text);
    if (output) {
      target = target ?? procOption(text, "out");
      // `sum(amount)=revenue` names an output column and the input it reads.
      for (const stat of output[1].matchAll(/([A-Za-z_]\w*)\s*\(\s*([\w$]+)\s*\)\s*=\s*([\w$]+)/g)) {
        statVars.push({ name: stat[3], expression: `${stat[1]}(${stat[2]})`, source: stat[2] });
      }
      continue;
    }

    if (/^append\b/i.test(text)) {
      // `proc datasets` appends too: `append base=a data=b;`
      target = procOption(text, "base") ?? target;
      input = procOption(text, "data") ?? input;
      continue;
    }

    const varMatch = /^(var|id|class|copy)\b([\s\S]*)$/i.exec(text);
    if (varMatch) {
      const target = /^var$/i.test(varMatch[1]) ? analysisVars : groupVars;
      target.push(...splitNames(varMatch[2]));
      continue;
    }

    const byMatch = /^by\b([\s\S]*)$/i.exec(text);
    if (byMatch) {
      by.push(
        ...splitNames(byMatch[1]).filter((n) => !/^(descending|notsorted|groupformat)$/i.test(n))
      );
      continue;
    }

    const whereMatch = /^where\b([\s\S]*)$/i.exec(text);
    if (whereMatch) where = whereMatch[1].trim();
  }

  if (!input) return [];

  const source = makeSource({ name: input }, null);
  const sources = [source];
  const columns = [];

  for (const stat of statVars) {
    columns.push(makeColumn(stat.name, stat.expression, refsForVariable(stat.source, sources)));
  }
  // Once a summary has named its statistics, the analysed variables themselves
  // are gone from the output -- only the grouping variables come through.
  const passThrough = statVars.length ? [...by, ...groupVars] : [...by, ...groupVars, ...analysisVars];
  for (const name of passThrough) {
    if (columns.some((c) => lower(c.name) === lower(name))) continue;
    columns.push(makeColumn(name, name, refsForVariable(name, sources)));
  }
  // A PROC that summarises names its outputs; anything else passes rows through.
  if (!statVars.length) columns.push(starColumn(source, true));

  return [
    {
      target,
      kind: `proc_${procName}`,
      relation: { sources, columns, joins: [], where, groupBy: [] },
    },
  ];
}

// ------------------------------------------------------------------- PROC SQL

// Statements inside PROC SQL that carry no lineage of their own. `execute` and
// `connect` hand SQL to a foreign database in its own dialect, which this tool
// deliberately does not guess at.
const PROC_SQL_NOISE =
  /^(reset|title\d*|footnote\d*|validate|describe|connect|disconnect|execute|quit|run)\b/i;

/**
 * Rewrites the SAS-only spellings in a PROC SQL statement into something a SQL
 * grammar accepts. Returns the rewritten text plus the aliases referenced with
 * CALCULATED, whose lineage resolves against the select list rather than a table.
 */
export function normalizeProcSql(text) {
  const calculated = new Set();
  let out = text;

  out = out.replace(/\bcalculated\s+([A-Za-z_]\w*)/gi, (_, name) => {
    calculated.add(lower(name));
    return name;
  });

  // Column modifiers: `select amount format=8.2 label='Amount'`
  out = out.replace(
    /\s+\b(label|format|informat|length|transcode)\s*=\s*('[^']*'|"[^"]*"|[\w$.]+)/gi,
    ""
  );

  // `select count(*) into :n from t` -- the macro target is not a column.
  out = out.replace(/\binto\s*:[\s\S]*?(?=\bfrom\b)/i, "");

  return { text: out.trim(), calculated };
}

/**
 * CALCULATED refers to an alias defined earlier in the same select list, so its
 * lineage is that alias's lineage, not a column of any table.
 */
function inlineCalculated(relation, calculated) {
  if (!relation || !calculated.size) return relation;
  const byName = new Map();

  for (const column of relation.columns) {
    const refs = [];
    for (const ref of column.refs) {
      // CALCULATED is the definitive signal, so the name is not looked for on
      // any table: SAS requires the keyword precisely because a bare name would
      // have meant the table's column.
      const earlier = calculated.has(lower(ref.column)) ? byName.get(lower(ref.column)) : null;
      if (earlier) refs.push(...earlier);
      else refs.push(ref);
    }
    column.refs = dedupeRefs(refs);
    if (!column.isStar) column.isComputed = column.refs.length !== 1;
    byName.set(lower(column.name), column.refs);
  }

  return relation;
}

/** Qualifies one-level dataset names so PROC SQL and DATA steps meet at one node. */
function qualifyRelation(relation) {
  if (!relation) return relation;

  for (const source of relation.sources) {
    if (source.kind === "table") {
      const qualified = qualifyDataset(source.name);
      for (const column of relation.columns) {
        for (const ref of column.refs) {
          if (ref.sourceId === source.id) ref.sourceName = qualified;
        }
      }
      source.name = qualified;
    }
    if (source.relation) qualifyRelation(source.relation);
  }

  for (const join of relation.joins ?? []) {
    if (join.target) join.target = qualifyDataset(join.target);
  }

  return relation;
}

// -------------------------------------------------------------------- stepping

const GLOBAL_STATEMENT =
  /^(libname|filename|options|goptions|title\d*|footnote\d*|ods|dm|x|systask|endsas|%macro|%mend|%include|%put|%if|%then|%else|%do|%end|%global|%local|%symdel|%syscall|%sysexec|%abort|run|quit)\b/i;

/** Groups the flat statement list into DATA steps, PROC steps and PROC SQL blocks. */
function groupSteps(statements, vars) {
  const steps = [];
  let current = null;
  let skipDataLines = false;

  const flush = () => {
    if (current && current.statements.length) steps.push(current);
    current = null;
  };

  for (const raw of statements) {
    if (skipDataLines) {
      // The line block after DATALINES is data, not code.
      skipDataLines = false;
      continue;
    }

    const letMatch = /^%let\s+([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/i.exec(raw.text);
    if (letMatch) {
      vars.set(lower(letMatch[1]), applyMacroVars(letMatch[2].trim(), vars));
      continue;
    }

    const statement = { ...raw, text: applyMacroVars(raw.text, vars) };
    const text = statement.text;

    if (/^(datalines|cards|lines)\b/i.test(text)) {
      skipDataLines = true;
      continue;
    }

    if (/^data\s+[A-Za-z_$]/i.test(text)) {
      flush();
      current = { kind: "data", statements: [statement] };
      continue;
    }

    if (/^proc\s+sql\b/i.test(text)) {
      flush();
      current = { kind: "sql", statements: [] };
      continue;
    }

    const proc = /^proc\s+(\w+)/i.exec(text);
    if (proc) {
      flush();
      current = { kind: "proc", name: lower(proc[1]), statements: [statement] };
      continue;
    }

    if (/^(run|quit)\b/i.test(text)) {
      flush();
      continue;
    }

    if (!current) continue;
    if (current.kind === "sql") {
      if (PROC_SQL_NOISE.test(text)) continue;
    } else if (GLOBAL_STATEMENT.test(text) && !readAssignment(text)) {
      // Guarded by the assignment test because several global statements are
      // also ordinary variable names: `x = 1;` is an assignment, not the X
      // command, and a step full of variables called x or dm is not unusual.
      continue;
    }

    current.statements.push(statement);
  }

  flush();
  return steps;
}

// ---------------------------------------------------------------------- entry

/**
 * Parses a SAS program into the shape `parseScript` returns.
 *
 * @param {string} source the program text
 * @param {(statement: object, dialect: string) => object} parseSqlStatement
 *        the SQL statement parser, injected so this module does not depend on
 *        the SQL path and the two cannot form an import cycle.
 */
export function parseSasScript(source, parseSqlStatement) {
  nextId = 0;
  const text = blankSasComments(source);
  const vars = new Map();
  const steps = groupSteps(splitSasStatements(text), vars);
  const statements = [];

  const push = (statement) => statements.push({ ...statement, index: statements.length });

  for (const step of steps) {
    if (step.kind === "sql") {
      for (const inner of step.statements) {
        const { text: normalized, calculated } = normalizeProcSql(inner.text);
        if (!normalized) continue;
        const parsed = parseSqlStatement(
          { index: statements.length, startLine: inner.startLine, text: normalized },
          SAS_SQL_ENGINE
        );
        parsed.target = parsed.target ? qualifyDataset(parsed.target) : null;
        parsed.relation = qualifyRelation(inlineCalculated(parsed.relation, calculated));
        for (const cte of parsed.ctes) qualifyRelation(cte.relation);
        push({ ...parsed, sasKind: "proc_sql" });
      }
      continue;
    }

    const outputs = step.kind === "data" ? buildDataStep(step) : buildProcStep(step);
    for (const output of outputs) {
      push({
        id: uid("stmt"),
        startLine: step.statements[0].startLine,
        text: step.statements.map((s) => `${s.text};`).join("\n"),
        kind: output.kind ?? "data_step",
        target: output.target,
        ctes: [],
        relation: output.relation,
        parseError: null,
        degraded: false,
      });
    }
  }

  return {
    dialect: "SAS",
    language: "sas",
    detected: { id: "SAS", parsed: statements.length, score: sasScore(source) },
    statements,
    stats: {
      total: statements.length,
      parsed: statements.filter((s) => !s.degraded).length,
      degraded: statements.filter((s) => s.degraded).length,
    },
  };
}
