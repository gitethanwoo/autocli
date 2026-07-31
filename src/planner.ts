import type { TableSpec } from "./types.js";

export interface PlanOk {
  ok: true;
  /** index to query with; undefined → built-in by_creation_time */
  index?: string;
  /** index prefix fields consumed, in index order */
  fields: string[];
  /**
   * Field a --since/--until range may legally target. Convex requires ranges
   * on the NEXT field in index order after the eq chain: that is the implicit
   * trailing _creationTime when the declared fields are fully consumed, or a
   * declared time field sitting right after the consumed prefix.
   */
  rangeField?: string;
}

export interface PlanError {
  ok: false;
  message: string;
  /** valid flag combinations, for the error hint */
  validCombos: string[][];
}

export interface PlanOptions {
  /** a --since/--until bound was requested */
  timeRange?: boolean;
}

/**
 * Pick an index whose prefix covers ALL provided equality filters. Leftover
 * un-indexed filters are an error, not a post-filter — post-filtering after
 * pagination silently lies about completeness, and unbounded scans are the
 * failure mode this tool exists to prevent.
 */
export function planQuery(
  table: TableSpec,
  providedFields: string[],
  opts: PlanOptions = {},
): PlanOk | PlanError {
  if (providedFields.length === 0) {
    // Built-in by_creation_time index; its only field is _creationTime.
    return { ok: true, fields: [], rangeField: "_creationTime" };
  }

  const provided = new Set(providedFields);
  const covering: { index: string; fields: string[]; rangeField?: string }[] = [];
  for (const idx of table.indexes) {
    let k = 0;
    while (k < idx.fields.length) {
      const f = idx.fields[k];
      if (f === undefined || !provided.has(f)) break;
      k++;
    }
    if (k !== provided.size) continue;
    const next = idx.fields[k];
    let rangeField: string | undefined;
    if (next === undefined) {
      rangeField = "_creationTime"; // implicit trailing index field
    } else if (table.timeFields.includes(next)) {
      rangeField = next;
    }
    covering.push({
      index: idx.name,
      fields: idx.fields.slice(0, k),
      ...(rangeField !== undefined ? { rangeField } : {}),
    });
  }

  if (covering.length > 0) {
    // Prefer an index that supports a time range (exact-length first, so the
    // range lands on _creationTime when possible), then the shortest index.
    const ranked = [...covering].sort((a, b) => {
      const ar = a.rangeField !== undefined ? 0 : 1;
      const br = b.rangeField !== undefined ? 0 : 1;
      if (ar !== br) return ar - br;
      return a.fields.length - b.fields.length;
    });
    const best = ranked[0];
    if (best) {
      if (opts.timeRange === true && best.rangeField === undefined) {
        return {
          ok: false,
          message:
            "This filter combination cannot be time-bounded: no index puts a time field right after it.",
          validCombos: combosOf(table),
        };
      }
      return {
        ok: true,
        index: best.index,
        fields: best.fields,
        ...(best.rangeField !== undefined ? { rangeField: best.rangeField } : {}),
      };
    }
  }

  return {
    ok: false,
    message: `No index covers filters: ${providedFields.join(", ")}. Filters must match an index prefix.`,
    validCombos: combosOf(table),
  };
}

function combosOf(table: TableSpec): string[][] {
  return table.indexes.map((i) => i.fields.filter((f) => f !== "_creationTime"));
}

/**
 * Human/agent-facing rendering of every valid filter combination — the ONE
 * source of truth used by both table help and planner error messages.
 * Time fields render as "--since/--until" since they have no eq flag.
 */
export function describeCombos(table: TableSpec): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const idx of table.indexes) {
    const parts: string[] = [];
    for (const field of idx.fields) {
      if (field === "_creationTime") continue;
      if (table.timeFields.includes(field)) {
        parts.push("--since/--until");
        continue;
      }
      const flag = table.filters.find((f) => f.field === field)?.flag;
      parts.push(`--${flag ?? field}`);
    }
    const rendered = parts.join(" ");
    if (rendered.length === 0 || seen.has(rendered)) continue;
    seen.add(rendered);
    out.push(rendered);
  }
  return out;
}
