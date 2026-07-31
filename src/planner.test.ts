import { describe, expect, it } from "vitest";
import { planQuery } from "./planner.js";
import type { IndexIR, TableSpec } from "./types.js";

function tableWith(indexes: IndexIR[], timeFields: string[] = []): TableSpec {
  return {
    name: "t",
    description: "t records",
    identityFields: [],
    redactedFields: [],
    blobFields: [],
    filters: [],
    indexes,
    belongsTo: [],
    hasMany: [],
    search: [],
    timeFields,
  };
}

describe("planQuery", () => {
  it("empty filters → ok with no index (creation-time default)", () => {
    const plan = planQuery(tableWith([{ name: "by_a", fields: ["a"] }]), []);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.index).toBeUndefined();
      expect(plan.fields).toEqual([]);
    }
  });

  it("single indexed field → picks that index (exact length → implicit _creationTime range)", () => {
    const plan = planQuery(tableWith([{ name: "by_status", fields: ["status"] }]), ["status"]);
    expect(plan).toEqual({
      ok: true,
      index: "by_status",
      fields: ["status"],
      rangeField: "_creationTime",
    });
  });

  it("two fields covered by a composite index prefix → picks it, fields in index order", () => {
    const table = tableWith(
      [
        { name: "by_org", fields: ["organizationId"] },
        { name: "by_org_status", fields: ["organizationId", "status", "createdAt"] },
      ],
      ["createdAt"],
    );
    // Provided order should not matter; consumed fields come back in index order.
    // The next index field (createdAt) is a declared time field → legal range target.
    const plan = planQuery(table, ["status", "organizationId"]);
    expect(plan).toEqual({
      ok: true,
      index: "by_org_status",
      fields: ["organizationId", "status"],
      rangeField: "createdAt",
    });
  });

  it("time range with a partially-consumed non-time index → error, not an invalid range", () => {
    // by_org_agent's next field after the consumed prefix is agentId — Convex
    // would reject a _creationTime bound here, so the planner must too.
    const table = tableWith([
      { name: "by_org_agent", fields: ["organizationId", "agentId"] },
    ]);
    const plan = planQuery(table, ["organizationId"], { timeRange: true });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain("time-bounded");
  });

  it("prefers a range-capable index when a time bound is requested", () => {
    const table = tableWith([
      { name: "by_org_agent", fields: ["organizationId", "agentId"] },
      { name: "by_org", fields: ["organizationId"] },
    ]);
    const plan = planQuery(table, ["organizationId"], { timeRange: true });
    expect(plan).toEqual({
      ok: true,
      index: "by_org",
      fields: ["organizationId"],
      rangeField: "_creationTime",
    });
  });

  it("field only in position 2 of an index (never position 1) → error with validCombos", () => {
    const table = tableWith([
      { name: "by_org_role", fields: ["organizationId", "role"] },
      { name: "by_status", fields: ["status", "_creationTime"] },
    ]);
    const plan = planQuery(table, ["role"]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.message).toContain("role");
      expect(plan.message).toContain("index prefix");
      // _creationTime is stripped from the hint combos.
      expect(plan.validCombos).toEqual([["organizationId", "role"], ["status"]]);
    }
  });

  it("picks the covering index; a subset prefers the exact-length one", () => {
    const table = tableWith([
      { name: "by_a", fields: ["a"] },
      { name: "by_a_b", fields: ["a", "b"] },
    ]);
    const plan = planQuery(table, ["a", "b"]);
    expect(plan).toEqual({
      ok: true,
      index: "by_a_b",
      fields: ["a", "b"],
      rangeField: "_creationTime",
    });
    // A subset of the composite plans on the exact-length index, which keeps
    // the implicit _creationTime range available.
    const sub = planQuery(table, ["a"]);
    expect(sub.ok).toBe(true);
    if (sub.ok) {
      expect(sub.index).toBe("by_a");
      expect(sub.fields).toEqual(["a"]);
      expect(sub.rangeField).toBe("_creationTime");
    }
  });

  it("rejects a partial cover: a matching prefix must consume ALL provided filters", () => {
    const table = tableWith([{ name: "by_a", fields: ["a"] }]);
    const plan = planQuery(table, ["a", "b"]);
    expect(plan.ok).toBe(false);
  });

  it("rejects a completely unknown field", () => {
    const plan = planQuery(tableWith([{ name: "by_a", fields: ["a"] }]), ["nope"]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.validCombos).toEqual([["a"]]);
  });

  it("no indexes at all → any filter errors with empty combos", () => {
    const plan = planQuery(tableWith([]), ["x"]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.validCombos).toEqual([]);
  });
});
