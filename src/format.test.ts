import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  formatValue,
  renderCount,
  renderDetail,
  renderList,
  renderRows,
} from "./format.js";
import type { AutocliSpec, SpecDefaults, TableSpec } from "./types.js";

function makeTable(name: string, o: Partial<TableSpec> = {}): TableSpec {
  return {
    name,
    description: `${name} records`,
    identityFields: [],
    redactedFields: [],
    blobFields: [],
    filters: [],
    indexes: [],
    belongsTo: [],
    hasMany: [],
    search: [],
    ...o,
  };
}

function makeSpec(tables: TableSpec[], defaults: Partial<SpecDefaults> = {}): AutocliSpec {
  return {
    specVersion: 1,
    adapter: "convex",
    projectName: "testproj",
    schemaHash: "0".repeat(64),
    defaults: { rowLimit: 20, maxRowLimit: 100, outputTokenBudget: 2000, countCap: 1000, ...defaults },
    workflows: [],
    tables: Object.fromEntries(tables.map((t) => [t.name, t])),
  };
}

describe("estimateTokens", () => {
  it("uses the chars/4 heuristic, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("formatValue", () => {
  it("renders epoch-ms numbers as compact ISO timestamps", () => {
    expect(formatValue(1_700_000_000_000)).toBe("2023-11-14T22:13:20Z");
    expect(formatValue(1_700_000_000_123)).toBe("2023-11-14T22:13:20.123Z");
  });

  it("leaves numbers outside the 2001–2100 epoch window alone", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(999_999_999_999)).toBe("999999999999");
    expect(formatValue(4_102_444_800_000)).toBe("4102444800000");
  });

  it("formats non-integers to 4 decimal places", () => {
    expect(formatValue(3.14159265)).toBe("3.1416");
  });

  it("renders null, undefined, booleans, strings, and objects", () => {
    expect(formatValue(null)).toBe("null");
    expect(formatValue(undefined)).toBe("—");
    expect(formatValue(true)).toBe("true");
    expect(formatValue("hi")).toBe("hi");
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue([1, 2])).toBe("[1,2]");
  });
});

describe("renderRows", () => {
  const rows = [
    { _id: "abc123", name: "a", status: "ok" },
    { _id: "x", name: "longername", status: "no" },
  ];

  it("always moves _id to the last column", () => {
    const out = renderRows(rows, ["_id", "name", "status"]);
    const header = out.split("\n")[0];
    expect(header).toBe("name        status  _id");
  });

  it("pads columns to the widest cell", () => {
    const lines = renderRows(rows, ["name", "status"]).split("\n");
    expect(lines).toEqual([
      "name        status  _id",
      "a           ok      abc123",
      "longername  no      x",
    ]);
    // every value starts at the same column offset
    expect(lines.every((l) => l.slice(0, 12).trimEnd().length <= 10)).toBe(true);
  });

  it("truncates cells over 40 chars with an ellipsis and collapses whitespace", () => {
    const long = "z".repeat(50);
    const out = renderRows([{ _id: "1", name: long }], ["name"]);
    const row = out.split("\n")[1] ?? "";
    expect(row).toContain(`${"z".repeat(39)}…`);
    expect(row).not.toContain("z".repeat(40));
    const multiline = renderRows([{ _id: "1", name: "a\nb\tc" }], ["name"]);
    expect(multiline.split("\n")[1]).toContain("a b c");
  });

  it("renders undefined cells as —", () => {
    const out = renderRows([{ _id: "1" }], ["name"]);
    expect(out.split("\n")[1]).toContain("—");
  });
});

describe("renderList", () => {
  const fatRow = (i: number) => ({
    _id: `id_${String(i).padStart(4, "0")}`,
    val: "x".repeat(38),
    _creationTime: 1_700_000_000_000 + i,
  });

  it("trims rows from the bottom when the output exceeds the token budget", () => {
    const table = makeTable("things", { identityFields: ["val"] });
    const spec = makeSpec([table], { outputTokenBudget: 200 });
    const page = Array.from({ length: 100 }, (_, i) => fatRow(i));
    const out = renderList({ spec, table, page, isDone: true, cursor: null, activeFilters: [] });

    expect(out).toContain("things — 100 rows");
    const m = /\((\d+) rows hidden to fit output budget/.exec(out);
    expect(m).not.toBeNull();
    const hidden = Number(m?.[1]);
    expect(hidden).toBeGreaterThan(0);
    expect(hidden).toBeLessThan(100);
    // the trimmed body actually fits the budget
    const body = out
      .split("\n")
      .filter((l) => l.startsWith("x".repeat(10)) || l.startsWith("val"))
      .join("\n");
    expect(estimateTokens(body)).toBeLessThanOrEqual(200);
    expect(out).toContain("Next steps:");
  });

  it("does not trim when the budget is generous", () => {
    const table = makeTable("things", { identityFields: ["val"] });
    const spec = makeSpec([table], { outputTokenBudget: 100_000 });
    const page = Array.from({ length: 100 }, (_, i) => fatRow(i));
    const out = renderList({ spec, table, page, isDone: true, cursor: null, activeFilters: [] });
    expect(out).not.toContain("rows hidden");
  });

  it("keeps a floor of 3 rows when trimming an over-budget page", () => {
    const table = makeTable("things", { identityFields: ["val"] });
    const spec = makeSpec([table], { outputTokenBudget: 10 });
    const page = Array.from({ length: 5 }, (_, i) => fatRow(i));
    const out = renderList({ spec, table, page, isDone: true, cursor: null, activeFilters: [] });
    expect(out).toContain("(2 rows hidden to fit output budget");
    expect(out).toContain("id_0000"); // first rows survive the floor
    expect(out).toContain("id_0002");
    expect(out).not.toContain("id_0003");
  });

  it("shows filters in the heading and a pagination hint when more rows exist", () => {
    const table = makeTable("things", { identityFields: ["val"] });
    const spec = makeSpec([table]);
    const out = renderList({
      spec,
      table,
      page: [fatRow(1)],
      isDone: false,
      cursor: "CURSOR_TOKEN_1234567890abcdef",
      activeFilters: ["status=active"],
    });
    expect(out).toContain("things (status=active) — 1 row, more available");
    expect(out).toContain(`--cursor '${"CURSOR_TOKEN_1234567890abcdef".slice(0, 24)}…'`);
  });

  it("suggests count --by for tables with a multi-value enum filter", () => {
    const table = makeTable("things", {
      identityFields: ["val"],
      filters: [{ flag: "status", field: "status", kind: "enum", enumValues: ["a", "b"] }],
    });
    const out = renderList({
      spec: makeSpec([table]),
      table,
      page: [fatRow(1)],
      isDone: true,
      cursor: null,
      activeFilters: [],
    });
    expect(out).toContain("autocli things count --by status");
  });

  it("renders empty-state hints", () => {
    const table = makeTable("things");
    const spec = makeSpec([table]);
    const empty = renderList({ spec, table, page: [], isDone: true, cursor: null, activeFilters: [] });
    expect(empty).toContain("Table is empty.");
    const filtered = renderList({
      spec,
      table,
      page: [],
      isDone: true,
      cursor: null,
      activeFilters: ["status=x"],
    });
    expect(filtered).toContain("No rows match");
  });
});

describe("renderDetail", () => {
  it("truncates blob fields at 400 chars with a --full note", () => {
    const table = makeTable("posts", { blobFields: ["body"] });
    const spec = makeSpec([table]);
    const body = "x".repeat(500);
    const out = renderDetail({
      spec,
      table,
      doc: { _id: "p1", title: "Hello", body },
      labels: {},
      related: [],
      full: false,
    });
    expect(out).toContain(`${"x".repeat(400)}… [500 chars — use --full]`);
    expect(out).not.toContain("x".repeat(401));
  });

  it("--full renders the whole blob with no truncation note", () => {
    const table = makeTable("posts", { blobFields: ["body"] });
    const body = "x".repeat(500);
    const out = renderDetail({
      spec: makeSpec([table]),
      table,
      doc: { _id: "p1", body },
      labels: {},
      related: [],
      full: true,
    });
    expect(out).toContain(body);
    expect(out).not.toContain("use --full");
  });

  it("shows the labelField value in the header and belongs-to labels inline", () => {
    const table = makeTable("posts", { labelField: "title" });
    const out = renderDetail({
      spec: makeSpec([table]),
      table,
      doc: { _id: "p1", title: "Hello", orgId: "org_1" },
      labels: { orgId: "Acme" },
      related: [],
      full: false,
    });
    expect(out.split("\n")[0]).toBe("posts p1 — Hello");
    expect(out).toContain("(Acme)");
  });

  it("lists linked records with capped counts and a copy-pasteable command", () => {
    const posts = makeTable("posts");
    const comments = makeTable("comments", {
      filters: [{ flag: "post-id", field: "postId", kind: "id", refTable: "posts" }],
    });
    const out = renderDetail({
      spec: makeSpec([posts, comments]),
      table: posts,
      doc: { _id: "p1", title: "t" },
      labels: {},
      related: [
        { table: "comments", field: "postId", count: 100, capped: true },
        { table: "unknowns", field: "someRef", count: 2, capped: false },
      ],
      full: false,
    });
    expect(out).toContain("Linked records:");
    expect(out).toContain("100+");
    expect(out).toContain("autocli comments --post-id p1");
    // unknown tables fall back to kebab-cased field flag
    expect(out).toContain("autocli unknowns --some-ref p1");
  });
});

describe("renderCount", () => {
  const table = makeTable("jobs");

  it("renders a plain count", () => {
    expect(renderCount(table, { count: 42 }, undefined, [])).toBe("jobs: 42");
  });

  it("appends + when capped and shows active filters", () => {
    expect(renderCount(table, { count: 1000, capped: true }, undefined, ["status=failed"])).toBe(
      "jobs (status=failed): 1000+",
    );
  });

  it("renders --by distributions sorted descending", () => {
    const out = renderCount(table, { counts: { a: 2, b: 5 }, scanned: 7 }, "status", []);
    const lines = out.split("\n");
    expect(lines[0]).toBe("jobs by status:");
    expect(lines[1]).toBe("       5  b");
    expect(lines[2]).toBe("       2  a");
    expect(out).not.toContain("rows only");
  });

  it("notes the scan cap on capped --by distributions", () => {
    const out = renderCount(table, { counts: { a: 1000 }, scanned: 1000, capped: true }, "status", []);
    expect(out).toContain("(first 1000 rows only — add filters or --since to narrow)");
  });
});
