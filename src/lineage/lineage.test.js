import { splitStatements, splitTopLevel, findKeyword } from "./scanner";
import { parseScript } from "./parse";
import { buildLineage, traceColumn, traceOrigins, computeOriginIndex, primaryOrigin } from "./graph";
import { SAS } from "./dialects";

const lineage = (sql, dialect = "auto") => buildLineage(parseScript(sql, dialect));

const outputOf = (graph, index = 0) => graph.nodes.get(graph.statements[index].outputId);

const columnNames = (node) => node.columns.map((c) => c.name);

const originsOf = (graph, statementIndex, column) =>
  traceOrigins(traceColumn(graph, graph.statements[statementIndex].outputId, column));

describe("scanner", () => {
  test("does not split on a semicolon inside a string literal", () => {
    const statements = splitStatements("select 'a;b' as x from t; select 1 from u");
    expect(statements).toHaveLength(2);
    expect(statements[0].text).toBe("select 'a;b' as x from t");
  });

  test("keeps a trailing statement that has no terminating semicolon", () => {
    const statements = splitStatements("select 1 from a; select 2 from b");
    expect(statements.map((s) => s.text)).toEqual(["select 1 from a", "select 2 from b"]);
  });

  test("ignores semicolons inside comments", () => {
    const statements = splitStatements("select 1 from a -- one; two\n; select 2 from b");
    expect(statements).toHaveLength(2);
  });

  test("reports the line of the SQL, not of a comment above it", () => {
    const statements = splitStatements("-- header\n-- notes\nselect 1 from a");
    expect(statements[0].startLine).toBe(3);
  });

  test("splits a select list without breaking functions, strings or CASE", () => {
    expect(splitTopLevel("a, coalesce(p, q) c, 'x,y' z, case when a>1 then 2 else 3 end k")).toEqual([
      "a",
      "coalesce(p, q) c",
      "'x,y' z",
      "case when a>1 then 2 else 3 end k",
    ]);
  });

  test("does not match a keyword inside an identifier", () => {
    expect(findKeyword("select from_days(x) from t", "from")).toBe(20);
  });
});

describe("parse", () => {
  test("keeps the expression the user wrote", () => {
    const graph = lineage("select o.amount_cents / 100.0 as amount from orders o");
    expect(outputOf(graph).columns[0].expression).toBe("o.amount_cents / 100.0");
  });

  test("treats a function call as one column", () => {
    const graph = lineage("select coalesce(a, b) as v, c from t");
    expect(columnNames(outputOf(graph))).toEqual(["v", "c"]);
  });

  test("resolves aliases to their table", () => {
    const graph = lineage("select a.id, b.name from users a join orgs b on b.id = a.org_id");
    const refs = outputOf(graph).columns.map((c) => c.refs[0].sourceName);
    expect(refs).toEqual(["users", "orgs"]);
  });

  test("flags an unqualified column that several tables could supply", () => {
    const graph = lineage("select id from orders o join customers c on c.id = o.customer_id");
    expect(graph.unresolved).toHaveLength(1);
    expect(graph.unresolved[0].status).toBe("ambiguous");
  });

  test("records the target of CREATE TABLE AS with its schema", () => {
    const graph = lineage("create table analytics.daily as select a from src");
    expect(graph.statements[0].kind).toBe("create_table_as");
    expect(graph.statements[0].target).toBe("analytics.daily");
  });

  test("reads the select behind INSERT INTO ... SELECT", () => {
    const graph = lineage("insert into tgt (a) select x from src");
    expect(graph.statements[0].kind).toBe("insert_select");
    expect(graph.statements[0].target).toBe("tgt");
  });

  test("expands t.* using the columns of the subquery it refers to", () => {
    const graph = lineage(
      "select s.*, u.email from (select user_id, sum(amount) as total from payments group by user_id) s join users u on u.id = s.user_id"
    );
    expect(columnNames(outputOf(graph))).toEqual(["user_id", "total", "email"]);
  });

  test("falls back instead of failing on a statement it cannot parse", () => {
    const parsed = parseScript("merge into t using s on t.id = s.id when matched then update set t.v = s.v");
    expect(parsed.stats.degraded).toBe(1);
    expect(parsed.statements[0].parseError).toBeTruthy();
  });
});

describe("dialects", () => {
  test.each([
    ["BigQuery", "select e.name from `proj.ds.tbl` t, unnest(t.events) e"],
    ["Snowflake", "select a from t qualify row_number() over (order by b) = 1"],
    ["Hive", "insert overwrite table w select a from f"],
    ["MySQL", "select a from t limit 10, 20"],
  ])("auto-detects %s", (expected, sql) => {
    expect(parseScript(sql, "auto").dialect).toBe(expected);
  });

  test("honours an explicitly chosen dialect", () => {
    expect(parseScript("select a from t", "Trino").dialect).toBe("Trino");
  });
});

describe("lineage graph", () => {
  const PIPELINE = `
    create table staging.clean as
    select o.id as order_id, o.amount_cents / 100.0 as amount
    from ecommerce.orders o;

    create table staging.enriched as
    select c.order_id, c.amount, cu.country
    from staging.clean c
    left join crm.customers cu on cu.id = c.order_id;

    with by_country as (
      select country, sum(amount) as revenue, count(*) as n
      from staging.enriched
      group by country
    )
    select b.country, b.revenue / nullif(b.n, 0) as avg_value
    from by_country b;
  `;

  test("links statements through the tables they create", () => {
    const graph = lineage(PIPELINE);
    const names = [...graph.nodes.values()].map((n) => n.name);
    expect(names).toEqual(
      expect.arrayContaining(["ecommerce.orders", "staging.clean", "staging.enriched", "by_country"])
    );
  });

  test("traces a field back to its base table across CTAS and CTE hops", () => {
    const graph = lineage(PIPELINE);
    const origins = originsOf(graph, 2, "avg_value").filter((o) => !o.literal);
    expect(origins).toEqual([{ table: "ecommerce.orders", column: "amount_cents" }]);
  });

  test("reports each hop with the expression that produced it", () => {
    const graph = lineage(PIPELINE);
    const trace = traceColumn(graph, graph.statements[2].outputId, "avg_value");

    const expressions = [];
    const walk = (hop) => {
      expressions.push(hop.expression);
      hop.sources.forEach(walk);
    };
    walk(trace);

    expect(expressions).toEqual(expect.arrayContaining(["o.amount_cents / 100.0", "sum(amount)"]));
  });

  test("counts count(*) as a real origin, not an unresolved reference", () => {
    const graph = lineage("select count(*) as n from t");
    const origins = originsOf(graph, 0, "n");
    expect(origins).toEqual([
      expect.objectContaining({ table: "Result 1", column: "n", literal: true, unresolved: false }),
    ]);
  });

  test("follows every branch of a UNION", () => {
    const graph = lineage(
      "create table combined as select id, ts from web_events union all select id, created_at from app_events; select c.ts from combined c;"
    );
    expect(originsOf(graph, 1, "ts")).toEqual([
      { table: "web_events", column: "ts" },
      { table: "app_events", column: "created_at" },
    ]);
  });

  test("traces through a long chain without stopping at an intermediate table", () => {
    // Deep staging chains are the case this tool exists for; an early depth cap
    // used to report the table it stopped at as if it were the origin.
    const stages = 40;
    const parts = ["create table stage_0 as select r.amount / 100.0 as amount from raw.source r;"];
    for (let i = 1; i < stages; i += 1) {
      parts.push(
        `create table stage_${i} as select s.amount * 1.01 as amount from stage_${i - 1} s;`
      );
    }
    parts.push(`select amount from stage_${stages - 1};`);

    const graph = lineage(parts.join("\n"));
    expect(originsOf(graph, stages, "amount")).toEqual([
      { table: "raw.source", column: "amount" },
    ]);
  });

  test("terminates on a circular reference rather than recursing forever", () => {
    // A view that reads a table of the same name resolves to itself.
    const graph = lineage("create view loop as select a from loop_source; select a from loop;");
    expect(() => originsOf(graph, 1, "a")).not.toThrow();
  });
});

describe("SAS", () => {
  const sas = (program) => buildLineage(parseScript(program, SAS));

  test("recognizes a SAS program without being told", () => {
    const parsed = parseScript("data work.a;\n  set raw.b;\n  x = y + 1;\nrun;", "auto");
    expect(parsed.language).toBe("sas");
    expect(parsed.dialect).toBe("SAS");
  });

  test("does not mistake SQL for SAS", () => {
    const parsed = parseScript("update t set x = 1 where id = 2; select * from t", "auto");
    expect(parsed.language).toBe("sql");
  });

  test("a DATA step names its own variables and carries the rest through", () => {
    const graph = sas("data work.clean;\n  set raw.orders;\n  amount = cents / 100;\nrun;");
    // `cents` arrives through the implicit pass-through of every input variable.
    expect(columnNames(outputOf(graph))).toEqual(["amount", "cents"]);
    expect(originsOf(graph, 0, "amount")).toEqual([{ table: "raw.orders", column: "cents" }]);
  });

  test("an assigned variable depends on the condition that chose it", () => {
    const graph = sas(
      "data work.a;\n  set raw.b;\n  if kind = 'web' then grp = 'online';\n  else grp = 'retail';\nrun;"
    );
    expect(originsOf(graph, 0, "grp")).toEqual([{ table: "raw.b", column: "kind" }]);
  });

  test("a variable defined earlier in the step is not looked for on the dataset", () => {
    const graph = sas("data work.a;\n  set raw.b;\n  total = x + y;\n  share = total / n;\nrun;");
    expect(originsOf(graph, 0, "share")).toEqual([
      { table: "raw.b", column: "x" },
      { table: "raw.b", column: "y" },
      { table: "raw.b", column: "n" },
    ]);
  });

  test("KEEP limits the output to the variables it lists", () => {
    const graph = sas("data work.a;\n  set raw.b;\n  keep id name;\nrun;");
    expect(columnNames(outputOf(graph))).toEqual(["id", "name"]);
  });

  test("DROP takes a variable back out of the pass-through", () => {
    const graph = sas("data work.a;\n  set raw.b;\n  x = id;\n  drop id;\nrun;");
    expect(columnNames(outputOf(graph))).not.toContain("id");
  });

  test("RENAME on an input maps the variable back to its name on the dataset", () => {
    const graph = sas("data work.a;\n  set raw.b (rename=(old_name=new_name));\n  x = new_name;\nrun;");
    expect(originsOf(graph, 0, "x")).toEqual([{ table: "raw.b", column: "old_name" }]);
  });

  test("MERGE reports both inputs, narrowed by KEEP", () => {
    const graph = sas(
      "data work.a;\n  merge raw.b (keep=id amt) raw.c (keep=id nm);\n  by id;\n  total = amt * 2;\nrun;"
    );
    const output = outputOf(graph);
    expect(output.relation.sources.map((s) => s.name)).toEqual(["raw.b", "raw.c"]);
    expect(originsOf(graph, 0, "total")).toEqual([{ table: "raw.b", column: "amt" }]);
  });

  test("resolves a macro variable set with %let", () => {
    const graph = sas("%let lib = raw;\ndata work.a;\n  set &lib..orders;\n  x = amt;\nrun;");
    expect(originsOf(graph, 0, "x")).toEqual([{ table: "raw.orders", column: "amt" }]);
  });

  test("a star comment is not read as code", () => {
    const graph = sas("* set raw.decoy;\ndata work.a;\n  set raw.b;\nrun;");
    expect(graph.statements).toHaveLength(1);
    expect(outputOf(graph).relation.sources.map((s) => s.name)).toEqual(["raw.b"]);
  });

  test("does not split a statement on a semicolon inside a quoted string", () => {
    const graph = sas("data work.a;\n  set raw.b;\n  note = 'x;y';\nrun;");
    expect(graph.statements).toHaveLength(1);
    expect(columnNames(outputOf(graph))).toContain("note");
  });

  test("PROC SORT carries its input through to OUT=", () => {
    const graph = sas(
      "data work.a;\n  set raw.b;\n  x = c;\nrun;\nproc sort data=work.a out=work.sorted;\n  by x;\nrun;"
    );
    expect(graph.statements[1].target).toBe("work.sorted");
    expect(originsOf(graph, 1, "x")).toEqual([{ table: "raw.b", column: "c" }]);
  });

  test("PROC SUMMARY maps an output statistic to the variable it summarized", () => {
    const graph = sas(
      "proc summary data=raw.sales nway;\n  class region;\n  var amt;\n  output out=work.s sum(amt)=total;\nrun;"
    );
    expect(columnNames(outputOf(graph))).toEqual(["total", "region"]);
    expect(originsOf(graph, 0, "total")).toEqual([{ table: "raw.sales", column: "amt" }]);
  });

  test("PROC SQL and DATA steps meet on the same WORK dataset", () => {
    const graph = sas(
      "proc sql;\n  create table clean as\n  select id, amt / 100 as dollars from raw.orders;\nquit;\n" +
        "data final;\n  set clean;\nrun;"
    );
    expect(graph.statements[0].target).toBe("work.clean");
    expect(graph.statements[1].target).toBe("work.final");
    expect(originsOf(graph, 1, "dollars")).toEqual([{ table: "raw.orders", column: "amt" }]);
  });

  test("CALCULATED resolves to the earlier item in the select list", () => {
    const graph = sas(
      "proc sql;\n  create table t as\n  select amt / 100 as dollars, calculated dollars * 0.2 as tax\n" +
        "  from raw.orders;\nquit;"
    );
    expect(originsOf(graph, 0, "tax")).toEqual([{ table: "raw.orders", column: "amt" }]);
  });

  test("ignores the pass-through SQL of a CONNECT TO block", () => {
    const graph = sas(
      "proc sql;\n  connect to oracle as ora (user=x);\n  execute (delete from t) by ora;\n  disconnect from ora;\nquit;"
    );
    expect(graph.statements).toHaveLength(0);
  });
});

describe("origin index", () => {
  test("gives one origin per field when there is exactly one", () => {
    const graph = lineage("select o.id, c.name from orders o join customers c on c.id = o.customer_id");
    const index = computeOriginIndex(graph);
    const output = outputOf(graph);

    expect(primaryOrigin(index.get(`${output.id}::id`))).toBe("orders");
    expect(primaryOrigin(index.get(`${output.id}::name`))).toBe("customers");
  });

  test("gives no single origin when a field combines two tables", () => {
    const graph = lineage("select o.a + c.b as mixed from orders o join customers c on c.id = o.cid");
    const index = computeOriginIndex(graph);
    expect(primaryOrigin(index.get(`${outputOf(graph).id}::mixed`))).toBeNull();
  });
});
