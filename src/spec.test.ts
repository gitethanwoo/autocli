import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRawSchema } from "./introspect.js";
import { DEFAULTS, generateSpec, kebab, singular } from "./spec.js";
import type { RawSchemaExport, RawTableJson, TableSpec, ValidatorJson } from "./types.js";

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/faithbase-schema.json", import.meta.url));
const ir = parseRawSchema(readFileSync(FIXTURE_PATH, "utf8"));
const spec = generateSpec(ir, { projectName: "faithbase" });

function specTable(name: string): TableSpec {
  const t = spec.tables[name];
  if (!t) throw new Error(`spec table ${name} missing`);
  return t;
}

// -- synthetic-schema helpers ----------------------------------------------

type FieldDef = { fieldType: ValidatorJson; optional: boolean };

function rawTable(
  tableName: string,
  fields: Record<string, FieldDef>,
  indexes: { name: string; fields: string[] }[] = [],
): RawTableJson {
  return {
    tableName,
    indexes: indexes.map((i) => ({ indexDescriptor: i.name, fields: i.fields })),
    searchIndexes: [],
    vectorIndexes: [],
    documentType: { type: "object", value: fields },
  };
}

function req(fieldType: ValidatorJson): FieldDef {
  return { fieldType, optional: false };
}

function specFrom(tables: RawTableJson[]) {
  const export_: RawSchemaExport = { tables };
  return generateSpec(parseRawSchema(JSON.stringify(export_)), { projectName: "synthetic" });
}

const str: ValidatorJson = { type: "string" };
const num: ValidatorJson = { type: "number" };

// ---------------------------------------------------------------------------

describe("generateSpec redaction heuristics (faithbase fixture)", () => {
  it("redacts users.email", () => {
    expect(specTable("users").redactedFields).toContain("email");
  });

  it('redacts secrets but NOT token usage counters', () => {
    expect(specTable("webhooks").redactedFields).toContain("secret");
    expect(specTable("conversations").redactedFields).toContain("visitorSecretHash");
    // "token"/"key" only redact as suffixes: accessToken yes, tokensPrompt no.
    expect(specTable("messages").redactedFields).not.toContain("tokensPrompt");
    expect(specTable("organizations").redactedFields).not.toContain("rateLimitTokens");
  });

  it("redacted top-level spec: every redacted field exists on its table", () => {
    for (const t of Object.values(spec.tables)) {
      const irTable = ir.tables.find((x) => x.name === t.name);
      for (const f of t.redactedFields) {
        expect(irTable?.fields.some((x) => x.name === f)).toBe(true);
      }
    }
  });
});

describe("generateSpec identity fields (faithbase fixture)", () => {
  it("picks known candidates first, excludes redacted fields, caps at 4 (users)", () => {
    const users = specTable("users");
    expect(users.identityFields).toEqual([
      "role",
      "createdAt",
      "workosUpdatedAt",
      "onboardingCompletedAt",
    ]);
    expect(users.identityFields).not.toContain("email");
  });

  it("never exceeds 4 identity fields, never includes redacted or blob fields", () => {
    for (const t of Object.values(spec.tables)) {
      expect(t.identityFields.length).toBeLessThanOrEqual(4);
      for (const f of t.identityFields) {
        expect(t.redactedFields).not.toContain(f);
        expect(t.blobFields).not.toContain(f);
      }
    }
  });
});

describe("generateSpec filters (faithbase fixture)", () => {
  it("derives filters only from indexed fields (users)", () => {
    const users = specTable("users");
    expect(users.filters.map((f) => f.field).sort()).toEqual([
      "organizationId",
      "role",
      "workosOrganizationMembershipId",
      "workosUserId",
    ]);
    const orgFilter = users.filters.find((f) => f.field === "organizationId");
    expect(orgFilter).toMatchObject({ flag: "organization-id", kind: "id", refTable: "organizations" });
    const roleFilter = users.filters.find((f) => f.field === "role");
    expect(roleFilter?.enumValues).toEqual(["owner", "admin", "member", "viewer", "prayer_team"]);
  });

  it("never exposes _creationTime or non-indexed fields as filters", () => {
    for (const t of Object.values(spec.tables)) {
      const indexed = new Set(t.indexes.flatMap((i) => i.fields));
      for (const f of t.filters) {
        expect(f.field).not.toBe("_creationTime");
        expect(indexed.has(f.field)).toBe(true);
      }
    }
  });
});

describe("generateSpec relations (faithbase fixture)", () => {
  it("organizations hasMany users via the by_organizationId index", () => {
    const rel = specTable("organizations").hasMany.find((r) => r.table === "users");
    expect(rel).toEqual({
      table: "users",
      field: "organizationId",
      index: "by_organizationId",
      flag: "organization-id",
    });
  });

  it("users belongsTo organizations", () => {
    expect(specTable("users").belongsTo).toContainEqual({
      field: "organizationId",
      table: "organizations",
    });
  });
});

describe("generateSpec workflows seed (faithbase fixture)", () => {
  it("emits one todo workflow rooted at the most-referenced table", () => {
    expect(spec.workflows).toHaveLength(1);
    const wf = spec.workflows[0];
    expect(wf?.todo).toBe(true);
    expect(wf?.steps.length).toBeGreaterThanOrEqual(2);
    expect(wf?.steps[0]?.cmd).toBe("autocli organizations");
    expect(wf?.steps.at(-1)?.cmd).toBe("autocli whois <id>");
    for (const s of wf?.steps ?? []) {
      expect(s.cmd.startsWith("autocli ")).toBe(true);
      expect(s.note.length).toBeGreaterThan(0);
    }
  });
});

describe("generateSpec defaults and envelope", () => {
  it("copies DEFAULTS and stamps the schema hash", () => {
    expect(DEFAULTS).toEqual({ rowLimit: 20, maxRowLimit: 100, outputTokenBudget: 2000, countCap: 1000 });
    expect(spec.defaults).toEqual(DEFAULTS);
    expect(spec.schemaHash).toBe(ir.schemaHash);
    expect(spec.specVersion).toBe(1);
    expect(spec.adapter).toBe("convex");
    expect(spec.projectName).toBe("faithbase");
  });
});

describe("generateSpec heuristics (synthetic schemas)", () => {
  it("labelField prefers title, then slug", () => {
    const s = specFrom([
      rawTable("posts", { title: req(str), slug: req(str) }),
      rawTable("pages", { slug: req(str), views: req(num) }),
    ]);
    expect(s.tables["posts"]?.labelField).toBe("title");
    expect(s.tables["pages"]?.labelField).toBe("slug");
  });

  it('a field literally called "name" is NOT redacted and wins as labelField', () => {
    // Entity names (organizations, agents, sources) are labels, not PII;
    // person-name fields (firstName/lastName/fullName) still redact.
    const s = specFrom([rawTable("orgs", { name: req(str), slug: req(str) })]);
    expect(s.tables["orgs"]?.redactedFields).not.toContain("name");
    expect(s.tables["orgs"]?.labelField).toBe("name");
    expect(specTable("organizations").redactedFields).not.toContain("name");
    expect(specTable("organizations").labelField).toBe("name");
    const person = specFrom([rawTable("people", { firstName: req(str), fullName: req(str) })]);
    expect(person.tables["people"]?.redactedFields).toEqual(["firstName", "fullName"]);
  });

  it('redacts "name" on person-like tables (email + phone present)', () => {
    const s = specFrom([
      rawTable("leads", { name: req(str), email: req(str), phone: req(str) }),
    ]);
    expect(s.tables["leads"]?.redactedFields).toContain("name");
    // Entity table with just a name stays visible.
    const e = specFrom([rawTable("orgs", { name: req(str), slug: req(str) })]);
    expect(e.tables["orgs"]?.redactedFields).not.toContain("name");
  });

  it("identity fields exclude blob fields and redacted fields, cap at 4", () => {
    const s = specFrom([
      rawTable("things", {
        title: req(str),
        description: req(str), // blob by name
        apiKey: req(str), // secret
        status: req(str),
        state: req(str),
        kind: req(str),
        role: req(str),
      }),
    ]);
    const t = s.tables["things"];
    expect(t?.blobFields).toContain("description");
    expect(t?.redactedFields).toContain("apiKey");
    expect(t?.identityFields).toEqual(["title", "status", "state", "kind"]);
  });

  it("filters come only from indexed fields, excluding _creationTime and redacted fields", () => {
    const s = specFrom([
      rawTable(
        "events",
        { status: req(str), email: req(str), plain: req(str) },
        [
          { name: "by_status", fields: ["status", "_creationTime"] },
          { name: "by_email", fields: ["email"] },
        ],
      ),
    ]);
    expect(s.tables["events"]?.filters.map((f) => f.field)).toEqual(["status"]);
  });

  it("hasMany is derived only when an index's FIRST field is the FK", () => {
    const s = specFrom([
      rawTable("teams", { title: req(str) }),
      rawTable(
        "members",
        { teamId: req({ type: "id", tableName: "teams" }), role: req(str) },
        [{ name: "by_teamId_role", fields: ["teamId", "role"] }],
      ),
      rawTable(
        "items",
        { teamId: req({ type: "id", tableName: "teams" }), status: req(str) },
        [{ name: "by_status_teamId", fields: ["status", "teamId"] }],
      ),
    ]);
    const teams = s.tables["teams"];
    expect(teams?.hasMany).toEqual([
      { table: "members", field: "teamId", index: "by_teamId_role", flag: "team-id" },
    ]);
    // items has an FK but no index starting with it — filter exists, hasMany doesn't.
    expect(teams?.hasMany.some((r) => r.table === "items")).toBe(false);
  });
});

describe("kebab", () => {
  it("splits camelCase and lowercases", () => {
    expect(kebab("organizationId")).toBe("organization-id");
    expect(kebab("workosUserId")).toBe("workos-user-id");
  });
  it("converts underscores", () => {
    expect(kebab("foo_bar")).toBe("foo-bar");
  });
  it("handles digit-to-upper boundaries", () => {
    expect(kebab("a1B")).toBe("a1-b");
  });
  it("leaves lowercase words alone", () => {
    expect(kebab("status")).toBe("status");
  });
  it("collapses consecutive capitals (no boundary detected)", () => {
    expect(kebab("HTMLContent")).toBe("htmlcontent");
  });
});

describe("singular", () => {
  it("handles ies → y", () => {
    expect(singular("companies")).toBe("company");
    expect(singular("entries")).toBe("entry");
  });
  it("handles ses → s-stem", () => {
    expect(singular("statuses")).toBe("status");
    expect(singular("buses")).toBe("bus");
  });
  it("strips a plain trailing s", () => {
    expect(singular("organizations")).toBe("organization");
  });
  it("leaves ss endings alone", () => {
    expect(singular("address")).toBe("address");
    expect(singular("process")).toBe("process");
  });
  it("leaves non-plurals alone", () => {
    expect(singular("data")).toBe("data");
  });
  it('edge: a bare "s" becomes the empty string (current behavior)', () => {
    expect(singular("s")).toBe("");
  });
});
