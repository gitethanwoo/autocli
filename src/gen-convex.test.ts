import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateConvexModule } from "./gen-convex.js";
import { parseRawSchema } from "./introspect.js";
import { generateSpec } from "./spec.js";
import type { AutocliSpec, SpecDefaults, TableSpec } from "./types.js";

import { EMPTY_IR, hasFixture, loadFixtureIR } from "./fixture-helper.js";

const ir = hasFixture ? loadFixtureIR() : EMPTY_IR;
const spec = generateSpec(ir, { projectName: "faithbase" });
const out = generateConvexModule(spec);

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
    schemaHash: "f".repeat(64),
    defaults: { rowLimit: 20, maxRowLimit: 100, outputTokenBudget: 2000, countCap: 1000, ...defaults },
    workflows: [],
    tables: Object.fromEntries(tables.map((t) => [t.name, t])),
  };
}

describe.skipIf(!hasFixture)("generateConvexModule (faithbase spec)", () => {
  it("bakes in the full table allowlist", () => {
    expect(out).toContain("const TABLES: readonly string[] =");
    const tablesBlock = out.slice(out.indexOf("const TABLES"), out.indexOf("const REDACTED"));
    for (const name of Object.keys(spec.tables)) {
      expect(tablesBlock).toContain(`"${name}"`);
    }
  });

  it("bakes in the redacted-field map", () => {
    expect(out).toContain("const REDACTED: Record<string, readonly string[]> =");
    const redactedBlock = out.slice(out.indexOf("const REDACTED"), out.indexOf("const LIST_FIELDS"));
    expect(redactedBlock).toMatch(/"users": \[[^\]]*"email"/);
    expect(redactedBlock).toMatch(/"webhooks": \[[^\]]*"secret"/);
  });

  it("bakes in MAX_LIMIT and COUNT_CAP from spec defaults", () => {
    expect(out).toContain(`const MAX_LIMIT = ${spec.defaults.maxRowLimit};`);
    expect(out).toContain(`const COUNT_CAP = ${spec.defaults.countCap};`);
    expect(out).toContain("const MAX_LIMIT = 100;");
    expect(out).toContain("const COUNT_CAP = 1000;");
  });

  it("bakes in the schema hash for drift detection", () => {
    expect(out).toContain(`const SCHEMA_HASH = "${spec.schemaHash}";`);
  });

  it("emits countPage for exact paginated aggregation", () => {
    expect(out).toContain("export const countPage = internalQueryGeneric");
    expect(out).toContain('.paginate({ numItems: COUNT_CAP, cursor: a.cursor ?? null })');
  });

  it("time windows are half-open: gte since, lt until (never lte)", () => {
    expect(out).toContain(".gte(rangeField, a.since)");
    expect(out).toContain(".lt(rangeField, a.until)");
    expect(out).not.toContain(".lte(");
  });

  it("emits the internal query surface only", () => {
    expect(out).toContain('import { internalQueryGeneric } from "convex/server";');
    for (const fn of ["list", "get", "count", "countBy", "search", "whois"]) {
      expect(out).toContain(`export const ${fn} = internalQueryGeneric(`);
    }
    // nothing writeable
    expect(out).not.toContain("mutation");
  });

  it("contains no `: any` annotations and no `as any` casts", () => {
    expect(out).not.toContain(": any");
    expect(out).not.toContain("as any");
  });

  it("includes search index metadata for searchable tables", () => {
    const searchBlock = out.slice(out.indexOf("const SEARCH"), out.indexOf("const MAX_LIMIT"));
    expect(searchBlock).toContain('"sourceItems"');
    expect(searchBlock).toContain('"search_source_items"');
    expect(searchBlock).toContain('"searchText"');
  });
});

describe("generateConvexModule (synthetic spec)", () => {
  it("respects non-default caps", () => {
    const s = makeSpec([makeTable("only")], { maxRowLimit: 7, countCap: 33 });
    const code = generateConvexModule(s);
    expect(code).toContain("const MAX_LIMIT = 7;");
    expect(code).toContain("const COUNT_CAP = 33;");
    expect(code).toContain('"only"');
  });

  it("omits empty maps but keeps LIST_FIELDS for every table", () => {
    const s = makeSpec([makeTable("bare", { identityFields: ["title"] })]);
    const code = generateConvexModule(s);
    expect(code).toMatch(/const REDACTED[^=]*= \{\}/);
    expect(code).toMatch(/"bare": \[\s*"title"\s*\]/);
  });
});
