import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderTableHelp, renderTablesOverview, renderTopHelp } from "./help.js";
import { parseRawSchema } from "./introspect.js";
import { generateSpec } from "./spec.js";
import type { TableSpec } from "./types.js";

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/faithbase-schema.json", import.meta.url));
const ir = parseRawSchema(readFileSync(FIXTURE_PATH, "utf8"));
const spec = generateSpec(ir, { projectName: "faithbase" });

function specTable(name: string): TableSpec {
  const t = spec.tables[name];
  if (!t) throw new Error(`spec table ${name} missing`);
  return t;
}

describe("renderTopHelp", () => {
  const top = renderTopHelp(spec);

  it("lists every table", () => {
    const names = Object.keys(spec.tables);
    expect(names).toHaveLength(63);
    for (const name of names) {
      expect(top).toContain(`  ${name}`);
    }
  });

  it("lists every workflow step, numbered", () => {
    for (const wf of spec.workflows) {
      expect(top).toContain(`${wf.title}:`);
      wf.steps.forEach((s, i) => {
        expect(top).toContain(`${i + 1}. ${s.cmd}`);
        expect(top).toContain(s.note);
      });
    }
    expect(top).toContain("1. autocli organizations");
  });

  it("marks searchable tables and shows their first filter flags", () => {
    const sourceItemsLine = top.split("\n").find((l) => l.trim().startsWith("sourceItems"));
    expect(sourceItemsLine).toContain("search");
    const usersLine = top.split("\n").find((l) => l.trim().startsWith("users "));
    expect(usersLine).toContain("--organization-id");
  });

  it("names the project and documents the command surface", () => {
    expect(top).toContain("data exploration CLI for faithbase");
    expect(top).toContain("autocli whois <id>");
    expect(top).toContain("autocli <table> count [--by f]");
  });
});

describe("renderTableHelp", () => {
  it("shows enum values in the filter listing (users.role)", () => {
    const help = renderTableHelp(spec, specTable("users"));
    expect(help).toContain("owner|admin|member|viewer|prayer_team");
    expect(help).toContain("--organization-id");
    expect(help).toContain("id of organizations");
  });

  it("lists valid index-prefix combinations for composite indexes, in flag form", () => {
    const help = renderTableHelp(spec, specTable("users"));
    expect(help).toContain("Valid filter combinations (index prefixes");
    expect(help).toContain("--organization-id --role");
    expect(help).toContain("--workos-user-id --organization-id");
  });

  it("shows search usage with its filter fields (sourceItems)", () => {
    const help = renderTableHelp(spec, specTable("sourceItems"));
    expect(help).toContain('search "query"');
    expect(help).toContain("full-text over searchText");
    expect(help).toContain("filters: sourceId, status, deletedAt");
  });

  it("lists redacted fields, belongs-to, and has-many relations", () => {
    const usersHelp = renderTableHelp(spec, specTable("users"));
    expect(usersHelp).toContain("Redacted fields (never returned): email");
    expect(usersHelp).toContain("Belongs to: organizations (via organizationId)");

    const orgHelp = renderTableHelp(spec, specTable("organizations"));
    expect(orgHelp).toContain("Has many:");
    expect(orgHelp).toContain("autocli users --organization-id <organizations id>");
  });

  it("renders the hint block when a table has one", () => {
    const hinted: TableSpec = { ...specTable("users"), hint: "Huge table; filter by org." };
    const help = renderTableHelp(spec, hinted);
    expect(help).toContain("Hint: Huge table; filter by org.");
  });

  it("shows list columns in the usage line", () => {
    const help = renderTableHelp(spec, specTable("users"));
    expect(help).toContain("columns: role, createdAt, workosUpdatedAt, onboardingCompletedAt");
  });
});

describe("renderTablesOverview", () => {
  it("counts tables and shows relation arrows", () => {
    const overview = renderTablesOverview(spec);
    expect(overview).toContain("Tables in faithbase (63):");
    expect(overview).toContain("users");
    expect(overview).toContain("→ organizations");
  });
});
