import type { AutocliSpec, TableSpec } from "./types.js";
import { cliRef, kebab } from "./spec.js";

const CELL_MAX = 40;
const BLOB_DETAIL_MAX = 400;

/** chars/4 heuristic — close enough for budget enforcement. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function isEpochMs(n: number): boolean {
  return n > 1_000_000_000_000 && n < 4_102_444_800_000; // 2001..2100
}

export function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "—";
  if (typeof v === "number") {
    if (isEpochMs(v)) return new Date(v).toISOString().replace(".000Z", "Z");
    return Number.isInteger(v) ? String(v) : v.toFixed(4);
  }
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function cell(v: unknown, max = CELL_MAX): string {
  const s = formatValue(v).replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Fixed-width table, id column last so ids stay greppable at line ends. */
export function renderRows(rows: Record<string, unknown>[], columns: string[]): string {
  const cols = [...columns.filter((c) => c !== "_id"), "_id"];
  const widths = cols.map((c) =>
    Math.min(
      CELL_MAX,
      Math.max(c.length, ...rows.map((r) => cell(r[c]).length)),
    ),
  );
  const line = (cells: string[]) =>
    cells.map((s, i) => s.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out = [line(cols)];
  for (const r of rows) out.push(line(cols.map((c) => cell(r[c]))));
  return out.join("\n");
}

export interface ListRenderInput {
  spec: AutocliSpec;
  table: TableSpec;
  page: Record<string, unknown>[];
  isDone: boolean;
  cursor: string | null;
  activeFilters: string[];
}

export function renderList(input: ListRenderInput): string {
  const { spec, table, page, isDone, cursor, activeFilters } = input;
  const parts: string[] = [];
  const filterNote = activeFilters.length > 0 ? ` (${activeFilters.join(", ")})` : "";
  parts.push(`${table.name}${filterNote} — ${page.length} row${page.length === 1 ? "" : "s"}${isDone ? "" : ", more available"}`);
  if (page.length === 0) {
    parts.push("");
    parts.push(emptyListHint(spec, table, activeFilters));
    return parts.join("\n");
  }
  const columns = [...table.identityFields, "_creationTime"];
  parts.push("");

  // Token budget: drop rows from the bottom until the table fits, but always
  // keep at least 3 rows — an empty table under a "N rows" header is a lie.
  let rows = page;
  let trimmed = 0;
  let body = renderRows(rows, columns);
  const budget = spec.defaults.outputTokenBudget;
  while (rows.length > 3 && estimateTokens(body) > budget) {
    rows = rows.slice(0, Math.max(3, rows.length - 5));
    trimmed = page.length - rows.length;
    body = renderRows(rows, columns);
  }
  parts.push(body);
  if (trimmed > 0) {
    parts.push(`\n(${trimmed} rows hidden to fit output budget — narrow with filters or use count)`);
  }

  const cli = cliRef(spec);
  const first = rows[0];
  const firstId = first ? String(first["_id"] ?? "<id>") : "<id>";
  const next: string[] = [`  ${cli} ${table.name} ${firstId}     -- full record + linked data`];
  if (!isDone && cursor) {
    next.push(`  ${cli} ${table.name} --cursor '${cursor.slice(0, 24)}…'   -- next page (use full cursor from --json)`);
  }
  const enumFilter = table.filters.find((f) => f.enumValues && f.enumValues.length > 1);
  if (enumFilter) {
    next.push(`  ${cli} ${table.name} count --by ${enumFilter.field}   -- distribution instead of rows`);
  }
  parts.push("");
  parts.push("Next steps:");
  parts.push(...next);
  return parts.join("\n");
}

function emptyListHint(spec: AutocliSpec, table: TableSpec, activeFilters: string[]): string {
  if (activeFilters.length > 0) {
    return `No rows match. Try dropping a filter, or: ${cliRef(spec)} ${table.name} count`;
  }
  return `Table is empty.`;
}

export interface DetailRenderInput {
  spec: AutocliSpec;
  table: TableSpec;
  doc: Record<string, unknown>;
  labels: Record<string, string | null>;
  related: { table: string; field: string; count: number; capped: boolean }[];
  full: boolean;
}

export function renderDetail(input: DetailRenderInput): string {
  const { spec, table, doc, labels, related, full } = input;
  const parts: string[] = [];
  const label = table.labelField ? doc[table.labelField] : undefined;
  parts.push(`${table.name} ${String(doc["_id"] ?? "")}${typeof label === "string" ? ` — ${label}` : ""}`);
  parts.push("");

  const blobs = new Set(table.blobFields);
  const keys = Object.keys(doc).filter((k) => k !== "_id");
  const pad = Math.min(34, Math.max(...keys.map((k) => k.length)) + 1);
  for (const k of keys) {
    const v = doc[k];
    let rendered: string;
    if (blobs.has(k) && !full) {
      const s = formatValue(v);
      rendered =
        s.length > BLOB_DETAIL_MAX
          ? `${s.slice(0, BLOB_DETAIL_MAX)}… [${s.length} chars — use --full]`
          : s;
    } else {
      rendered = formatValue(v);
    }
    if (rendered.includes("\n")) rendered = rendered.split("\n").join(`\n${" ".repeat(pad + 2)}`);
    const labelSuffix = labels[k] ? `  (${labels[k]})` : "";
    parts.push(`${k.padEnd(pad)} ${rendered}${labelSuffix}`);
  }

  const nonZero = related.filter((r) => r.count > 0);
  const zero = related.filter((r) => r.count === 0);
  if (related.length > 0) {
    parts.push("");
    parts.push("Linked records:");
    for (const r of nonZero) {
      const relSpec = spec.tables[r.table];
      const flagName = relSpec?.filters.find((f) => f.field === r.field)?.flag ?? kebab(r.field);
      const countLabel = r.capped ? `${r.count}+` : String(r.count);
      parts.push(
        `  ${r.table.padEnd(24)} ${countLabel.padStart(4)}   ${cliRef(spec)} ${r.table} --${flagName} ${String(doc["_id"] ?? "")}`,
      );
    }
  }
  if (zero.length > 0) {
    parts.push(`  (none: ${zero.map((r) => r.table).join(", ")})`);
  }
  return parts.join("\n");
}

export function renderCount(
  table: TableSpec,
  result: { count?: number; capped?: boolean; counts?: Record<string, number>; scanned?: number },
  by: string | undefined,
  activeFilters: string[],
): string {
  const filterNote = activeFilters.length > 0 ? ` (${activeFilters.join(", ")})` : "";
  if (by && result.counts) {
    const entries = Object.entries(result.counts).sort((a, b) => b[1] - a[1]);
    const lines = entries.map(([k, n]) => `  ${String(n).padStart(6)}  ${k}`);
    const cappedNote = result.capped
      ? `\n(first ${result.scanned} rows only — add filters or --since to narrow)`
      : "";
    return `${table.name}${filterNote} by ${by}:\n${lines.join("\n")}${cappedNote}`;
  }
  const suffix = result.capped ? "+" : "";
  return `${table.name}${filterNote}: ${result.count}${suffix}`;
}

export function renderWhois(
  spec: AutocliSpec,
  id: string,
  result: { table: string | null; doc: Record<string, unknown> | null },
): string {
  if (!result.table) {
    return `✗ ${id} does not match any table in this deployment. Ids look like "jd7f8..." — check for truncation.`;
  }
  if (!result.doc) {
    return `${id} belongs to table "${result.table}" but the document no longer exists (deleted).`;
  }
  const table = spec.tables[result.table];
  if (!table) return JSON.stringify(result.doc, null, 2);
  return renderDetail({
    spec,
    table,
    doc: result.doc,
    labels: {},
    related: [],
    full: false,
  });
}
