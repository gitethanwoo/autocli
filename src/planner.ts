import type { TableSpec } from "./types.js";

export interface PlanOk {
  ok: true;
  /** index to query with; undefined → built-in by_creation_time */
  index?: string;
  /** index prefix fields consumed, in index order */
  fields: string[];
}

export interface PlanError {
  ok: false;
  message: string;
  /** valid flag combinations, for the error hint */
  validCombos: string[][];
}

/**
 * Pick an index whose prefix covers ALL provided equality filters. Leftover
 * un-indexed filters are an error, not a post-filter — post-filtering after
 * pagination silently lies about completeness, and unbounded scans are the
 * failure mode this tool exists to prevent.
 */
export function planQuery(table: TableSpec, providedFields: string[]): PlanOk | PlanError {
  if (providedFields.length === 0) return { ok: true, fields: [] };

  const provided = new Set(providedFields);
  let best: { index: string; fields: string[] } | undefined;
  for (const idx of table.indexes) {
    let k = 0;
    while (k < idx.fields.length) {
      const f = idx.fields[k];
      if (f === undefined || !provided.has(f)) break;
      k++;
    }
    if (k === provided.size && (best === undefined || k > best.fields.length)) {
      best = { index: idx.name, fields: idx.fields.slice(0, k) };
    }
  }
  if (best) return { ok: true, index: best.index, fields: best.fields };

  const combos = table.indexes.map((i) =>
    i.fields.filter((f) => f !== "_creationTime"),
  );
  return {
    ok: false,
    message: `No index covers filters: ${providedFields.join(", ")}. Filters must match an index prefix.`,
    validCombos: combos,
  };
}
