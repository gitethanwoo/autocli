import type {
  AutocliSpec,
  FieldIR,
  FilterSpec,
  RelationSpec,
  SchemaIR,
  SearchSpec,
  SpecDefaults,
  TableIR,
  TableSpec,
  WorkflowSpec,
} from "./types.js";

export const DEFAULTS: SpecDefaults = {
  rowLimit: 20,
  maxRowLimit: 100,
  outputTokenBudget: 2000,
  countCap: 1000,
};

/** Always redacted: values that grant access. Substring match for hard words… */
const SECRET_RE = /(secret|password|passwd|apikey|api_key|credential|signature|ssn)/i;
/**
 * …suffix match for the ambiguous ones: `accessToken`/`webhookKey` are
 * credentials, but `tokensPrompt`/`rateLimitTokens`/`promptTokens` are usage
 * counters and must stay visible.
 */
const SECRET_SUFFIX_RE = /(token|key|secret|password)$/i;
/** Redacted by default, flagged for the finishing interview: PII. */
const PII_RE = /(email|phone|address|firstname|first_name|lastname|last_name|fullname|full_name|birthdate|dob)/i;
/** Epoch-ms timestamp fields: served by --since/--until, never by eq flags. */
const TIME_FIELD_RE = /(At|Time|Timestamp|Date)$/;
/** Long-text fields elided in list views, truncated in detail views. */
const BLOB_NAME_RE =
  /(prompt|text|content|body|html|markdown|transcript|message|description|summary|notes|raw|payload|snippet|chunk)/i;
/** Fields preferred as a human label for a row. */
const LABEL_CANDIDATES = ["name", "title", "slug", "label", "displayName"];
/** Fallback label: short descriptive strings like firstMessagePreview. */
const LABEL_FALLBACK_RE = /(preview|subject|title)$/i;
/** Fields that make good list columns, in priority order. */
const IDENTITY_CANDIDATES = [
  ...LABEL_CANDIDATES,
  "status",
  "state",
  "type",
  "kind",
  "role",
  "model",
  "provider",
  "createdAt",
  "updatedAt",
];
/** Suffix-matched identity candidates: jobType, syncState, reviewStatus, … */
const IDENTITY_SUFFIX_RE = /(type|kind|status|state)$/i;

export interface GenerateSpecOptions {
  projectName: string;
  cliName?: string;
}

/**
 * Default CLI name for a project: the package name, kebab-cased, scope
 * stripped. The interview invites a human (or finishing agent) to rename it —
 * the name is instance knowledge, like workflows.
 */
export function deriveCliName(projectName: string): string {
  const bare = projectName.replace(/^@[^/]+\//, "");
  const name = kebab(bare).replace(/[^a-z0-9-]/g, "");
  return name.length > 0 ? name : "autocli";
}

/**
 * How rendered commands refer to the CLI: the project shim, invocable verbatim
 * from the project root. Falls back for specs generated before cliName existed.
 */
export function cliRef(spec: Pick<AutocliSpec, "cliName">): string {
  return spec.cliName ? `./${spec.cliName}` : "autocli";
}

/**
 * Workflow steps are stored with whatever CLI name was current when written
 * (the seed uses the canonical `autocli` prefix). Substitute the current name
 * at render time so renaming the CLI never strands stale commands.
 */
export function normalizeStepCmd(cmd: string, cli: string): string {
  return cmd.replace(/^(autocli|\.\/[a-z0-9_-]+)(?=\s|$)/, cli);
}

/**
 * Step notes are prose and may mention commands inline ("then `autocli foo
 * <id>`"). Rewrite the canonical name when it's used as a command (followed
 * by whitespace) — `autocli.spec.json` and the like are left alone.
 */
export function normalizeStepNote(note: string, cli: string): string {
  return note.replace(/\bautocli(?=\s)/g, cli);
}

export function generateSpec(ir: SchemaIR, opts: GenerateSpecOptions): AutocliSpec {
  const tables: Record<string, TableSpec> = {};
  for (const t of ir.tables) {
    tables[t.name] = generateTableSpec(t, ir);
  }
  return {
    specVersion: 1,
    adapter: "convex",
    projectName: opts.projectName,
    cliName: opts.cliName ?? deriveCliName(opts.projectName),
    schemaHash: ir.schemaHash,
    defaults: { ...DEFAULTS },
    workflows: generateWorkflows(ir),
    tables,
  };
}

function generateTableSpec(t: TableIR, ir: SchemaIR): TableSpec {
  const redactedFields = t.fields
    .filter((f) => SECRET_RE.test(f.name) || SECRET_SUFFIX_RE.test(f.name) || PII_RE.test(f.name))
    .map((f) => f.name);
  // "name" is a label on entity tables (organizations, agents) but PII on
  // person tables. Signal: a table that also stores email/phone is about
  // people, so its "name" is someone's name.
  const piiCount = t.fields.filter((f) => /(email|phone)/i.test(f.name)).length;
  if (piiCount >= 2 && t.fields.some((f) => f.name === "name" && f.kind === "string")) {
    redactedFields.push("name");
  }
  const redacted = new Set(redactedFields);

  const blobFields = t.fields
    .filter(
      (f) =>
        !redacted.has(f.name) &&
        ((f.kind === "string" && BLOB_NAME_RE.test(f.name)) ||
          f.kind === "array" ||
          f.kind === "object" ||
          f.kind === "record" ||
          f.kind === "any"),
    )
    .map((f) => f.name);
  const blobs = new Set(blobFields);

  const identityFields = pickIdentityFields(t.fields, redacted, blobs);
  const labelField =
    LABEL_CANDIDATES.find(
      (c) => !redacted.has(c) && t.fields.some((f) => f.name === c && f.kind === "string"),
    ) ??
    t.fields.find(
      (f) => f.kind === "string" && !redacted.has(f.name) && LABEL_FALLBACK_RE.test(f.name),
    )?.name;

  const filters = deriveFilters(t, redacted);
  const belongsTo = t.fields
    .filter((f) => f.kind === "id" && f.refTable)
    .map((f) => ({ field: f.name, table: f.refTable as string }));
  const search: SearchSpec[] = t.searchIndexes.map((s) => ({
    index: s.name,
    searchField: s.searchField,
    filterFields: s.filterFields,
  }));

  return {
    name: t.name,
    description: describeTable(t),
    identityFields,
    redactedFields,
    blobFields,
    filters,
    indexes: t.indexes,
    belongsTo,
    hasMany: deriveHasMany(t.name, ir),
    search,
    timeFields: t.fields
      .filter((f) => f.kind === "number" && TIME_FIELD_RE.test(f.name))
      .map((f) => f.name),
    ...(labelField ? { labelField } : {}),
  };
}

function pickIdentityFields(
  fields: FieldIR[],
  redacted: Set<string>,
  blobs: Set<string>,
): string[] {
  const usable = (f: FieldIR) =>
    !redacted.has(f.name) &&
    !blobs.has(f.name) &&
    (f.kind === "string" || f.kind === "number" || f.kind === "boolean" || f.kind === "enum" || f.kind === "id");

  const byName = new Map(fields.map((f) => [f.name, f]));
  const picked: string[] = [];
  for (const c of IDENTITY_CANDIDATES) {
    const f = byName.get(c);
    if (f && usable(f) && !picked.includes(c)) picked.push(c);
    if (picked.length >= 4) break;
  }
  // Suffix-matched candidates (jobType, reviewStatus, …) before generic backfill.
  if (picked.length < 4) {
    for (const f of fields) {
      if (usable(f) && IDENTITY_SUFFIX_RE.test(f.name) && !picked.includes(f.name)) {
        picked.push(f.name);
        if (picked.length >= 4) break;
      }
    }
  }
  // Backfill with remaining scalar fields (enums and short strings first)
  if (picked.length < 4) {
    const rest = fields
      .filter((f) => usable(f) && !picked.includes(f.name) && f.kind !== "id")
      .sort((a, b) => rankKind(a) - rankKind(b));
    for (const f of rest) {
      picked.push(f.name);
      if (picked.length >= 4) break;
    }
  }
  return picked;
}

function rankKind(f: FieldIR): number {
  switch (f.kind) {
    case "enum":
      return 0;
    case "boolean":
      return 1;
    case "number":
      return 2;
    case "string":
      return 3;
    default:
      return 4;
  }
}

/**
 * A field is filterable iff some index has it in its prefix — this makes
 * accidental full scans structurally impossible. One flag per distinct field;
 * the runtime planner picks the best index for whichever flags are provided.
 */
function deriveFilters(t: TableIR, redacted: Set<string>): FilterSpec[] {
  const indexed = new Set<string>();
  for (const idx of t.indexes) for (const f of idx.fields) indexed.add(f);

  const byName = new Map(t.fields.map((f) => [f.name, f]));
  const filters: FilterSpec[] = [];
  for (const fieldName of indexed) {
    if (fieldName === "_creationTime" || redacted.has(fieldName)) continue;
    const f = byName.get(fieldName);
    if (!f) continue;
    if (f.kind === "array" || f.kind === "object" || f.kind === "record") continue;
    // Timestamps get --since/--until, not a useless millisecond eq flag.
    if (f.kind === "number" && TIME_FIELD_RE.test(f.name)) continue;
    filters.push({
      flag: kebab(fieldName),
      field: fieldName,
      kind: f.kind,
      ...(f.refTable ? { refTable: f.refTable } : {}),
      ...(f.enumValues ? { enumValues: f.enumValues } : {}),
    });
  }
  return filters.sort((a, b) => a.flag.localeCompare(b.flag));
}

/** Reverse FK edges that have an index making the lookup cheap. */
function deriveHasMany(parent: string, ir: SchemaIR): RelationSpec[] {
  const out: RelationSpec[] = [];
  for (const child of ir.tables) {
    for (const f of child.fields) {
      if (f.kind !== "id" || f.refTable !== parent) continue;
      const idx = child.indexes.find((i) => i.fields[0] === f.name);
      if (!idx) continue;
      out.push({ table: child.name, field: f.name, index: idx.name, flag: kebab(f.name) });
    }
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

function describeTable(t: TableIR): string {
  const fks = t.fields.filter((f) => f.kind === "id" && f.refTable).map((f) => f.refTable);
  const enums = t.fields.filter((f) => f.kind === "enum" && (f.enumValues?.length ?? 0) > 1);
  const bits: string[] = [];
  if (fks.length > 0) bits.push(`linked to ${[...new Set(fks)].slice(0, 3).join(", ")}`);
  const status = enums.find((e) => /status|state/i.test(e.name));
  if (status?.enumValues) {
    bits.push(`${status.name}: ${status.enumValues.slice(0, 4).join("|")}`);
  }
  if (t.searchIndexes.length > 0) bits.push("searchable");
  return bits.length > 0 ? `${t.name} records (${bits.join("; ")})` : `${t.name} records`;
}

/**
 * Seed workflows from the FK graph: the most-referenced tables are the roots
 * agents will start from. Marked todo — the finishing interview replaces these
 * with real operator workflows.
 */
function generateWorkflows(ir: SchemaIR): WorkflowSpec[] {
  const inDegree = new Map<string, number>();
  for (const t of ir.tables) {
    for (const f of t.fields) {
      if (f.kind === "id" && f.refTable) {
        inDegree.set(f.refTable, (inDegree.get(f.refTable) ?? 0) + 1);
      }
    }
  }
  const roots = [...inDegree.entries()]
    .filter(([name]) => ir.tables.some((t) => t.name === name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  const steps: WorkflowSpec["steps"] = [];
  const root = roots[0];
  if (root) {
    steps.push({ cmd: `autocli ${root}`, note: `list ${root} — the most-referenced table` });
    steps.push({ cmd: `autocli ${root} <id>`, note: "detail view with linked records" });
    const rootTable = ir.tables.find((t) => t.name === root);
    const child = rootTable
      ? ir.tables.find((t) => t.fields.some((f) => f.refTable === root && f.kind === "id"))
      : undefined;
    if (child) {
      const fk = child.fields.find((f) => f.refTable === root && f.kind === "id");
      if (fk) {
        steps.push({
          cmd: `autocli ${child.name} --${kebab(fk.name)} <id>`,
          note: `drill into ${child.name} for one ${singular(root)}`,
        });
      }
    }
  }
  steps.push({ cmd: "autocli whois <id>", note: "resolve any document id to its record" });

  return [
    {
      title: "Explore data (generated seed — replace with real workflows in the interview)",
      steps,
      todo: true,
    },
  ];
}

export function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

export function singular(s: string): string {
  if (s.endsWith("ies")) return `${s.slice(0, -3)}y`;
  if (s.endsWith("ses")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}
