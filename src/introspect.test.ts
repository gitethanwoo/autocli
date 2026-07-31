import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IntrospectError, parseRawSchema } from "./introspect.js";
import type { RawSchemaExport, TableIR, ValidatorJson } from "./types.js";

import { EMPTY_IR, hasFixture, loadFixtureIR, loadFixtureRaw } from "./fixture-helper.js";

const raw = hasFixture ? loadFixtureRaw() : "";
const ir = hasFixture ? loadFixtureIR() : EMPTY_IR;

function table(name: string): TableIR {
  const t = ir.tables.find((t) => t.name === name);
  if (!t) throw new Error(`fixture table ${name} missing`);
  return t;
}

describe.skipIf(!hasFixture)("parseRawSchema on the faithbase fixture", () => {
  it("parses all 63 tables", () => {
    expect(ir.tables).toHaveLength(63);
  });

  it("sorts tables by name", () => {
    const names = ir.tables.map((t) => t.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
    expect(names[0]).toBe("agentLinks");
    expect(names[names.length - 1]).toBe("widgetEvents");
  });

  it("computes a deterministic sha256 schemaHash", () => {
    expect(ir.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseRawSchema(raw).schemaHash).toBe(ir.schemaHash);
    expect(parseRawSchema('{"tables":[]}').schemaHash).not.toBe(ir.schemaHash);
  });

  it("resolves id fields with their refTable (users.organizationId → organizations)", () => {
    const users = table("users");
    const orgId = users.fields.find((f) => f.name === "organizationId");
    expect(orgId).toMatchObject({
      kind: "id",
      refTable: "organizations",
      optional: false,
      nullable: false,
    });
  });

  it("detects all-literal unions as enums (llmCostTotals.window)", () => {
    const window = table("llmCostTotals").fields.find((f) => f.name === "window");
    expect(window?.kind).toBe("enum");
    expect(window?.enumValues).toEqual(["day", "month"]);
  });

  it("carries the optional flag through (users.email is optional, organizationId is not)", () => {
    const users = table("users");
    expect(users.fields.find((f) => f.name === "email")).toMatchObject({
      kind: "string",
      optional: true,
    });
    expect(users.fields.find((f) => f.name === "organizationId")?.optional).toBe(false);
  });

  it("marks union-with-null fields nullable and unwraps the inner kind", () => {
    const cursor = table("retrievalScopeBackfillControls").fields.find(
      (f) => f.name === "sourceCursor",
    );
    expect(cursor?.nullable).toBe(true);
    expect(cursor?.kind).toBe("string");
  });

  it("parses search indexes with filterFields (sourceItems)", () => {
    const items = table("sourceItems");
    expect(items.searchIndexes).toEqual([
      {
        name: "search_source_items",
        searchField: "searchText",
        filterFields: ["sourceId", "status", "deletedAt"],
      },
    ]);
  });

  it("parses regular indexes with their field lists", () => {
    const users = table("users");
    const byOrgRole = users.indexes.find((i) => i.name === "by_organizationId_role");
    expect(byOrgRole?.fields).toEqual(["organizationId", "role"]);
  });

  it("throws IntrospectError on a payload without a tables array", () => {
    expect(() => parseRawSchema('{"nope":1}')).toThrow(IntrospectError);
    expect(() => parseRawSchema('{"tables":5}')).toThrow(IntrospectError);
    expect(() => parseRawSchema("null")).toThrow(IntrospectError);
  });
});

describe("parseRawSchema on synthetic validators", () => {
  function irFor(documentType: ValidatorJson | null): TableIR {
    const export_: RawSchemaExport = {
      tables: [
        {
          tableName: "t",
          indexes: [],
          searchIndexes: [],
          vectorIndexes: [],
          documentType,
        },
      ],
    };
    const parsed = parseRawSchema(JSON.stringify(export_)).tables[0];
    if (!parsed) throw new Error("no table parsed");
    return parsed;
  }

  function objectOf(fields: Record<string, { fieldType: ValidatorJson; optional: boolean }>): ValidatorJson {
    return { type: "object", value: fields };
  }

  it("marks non-object document types as irregularShape with no fields", () => {
    const t = irFor({
      type: "union",
      value: [objectOf({ a: { fieldType: { type: "string" }, optional: false } })],
    });
    expect(t.irregularShape).toBe(true);
    expect(t.fields).toEqual([]);
    expect(irFor(null).irregularShape).toBe(true);
  });

  it("treats union of literals plus null as a nullable enum", () => {
    const t = irFor(
      objectOf({
        status: {
          fieldType: {
            type: "union",
            value: [
              { type: "literal", value: "on" },
              { type: "literal", value: "off" },
              { type: "null" },
            ],
          },
          optional: false,
        },
      }),
    );
    expect(t.fields[0]).toMatchObject({
      name: "status",
      kind: "enum",
      nullable: true,
      enumValues: ["on", "off"],
    });
  });

  it("treats a lone literal as a single-value enum", () => {
    const t = irFor(
      objectOf({ v: { fieldType: { type: "literal", value: 2 }, optional: false } }),
    );
    expect(t.fields[0]).toMatchObject({ kind: "enum", enumValues: [2] });
  });

  it("degrades mixed-kind unions to unknown", () => {
    const t = irFor(
      objectOf({
        v: {
          fieldType: { type: "union", value: [{ type: "string" }, { type: "number" }] },
          optional: false,
        },
      }),
    );
    expect(t.fields[0]?.kind).toBe("unknown");
  });

  it("treats a field that is exactly v.null() as unknown + nullable", () => {
    const t = irFor(objectOf({ v: { fieldType: { type: "null" }, optional: false } }));
    expect(t.fields[0]).toMatchObject({ kind: "unknown", nullable: true });
  });

  it("maps int64 to number kind", () => {
    const t = irFor(objectOf({ v: { fieldType: { type: "int64" }, optional: false } }));
    expect(t.fields[0]?.kind).toBe("number");
  });
});
