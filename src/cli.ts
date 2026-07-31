import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convexRun, ConvexRunError } from "./convex-run.js";
import { renderCount, renderDetail, renderList, renderWhois } from "./format.js";
import { renderGuide, renderSkill, renderTableHelp, renderTablesOverview, renderTopHelp } from "./help.js";
import { introspectConvexProject, IntrospectError } from "./introspect.js";
import { describeCombos, planQuery } from "./planner.js";
import { generateConvexModule } from "./gen-convex.js";
import { cliRef, generateSpec } from "./spec.js";
import type { AutocliSpec, FilterSpec, TableSpec } from "./types.js";

const SPEC_FILE = "autocli.spec.json";

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const eq = name.indexOf("=");
      if (eq >= 0) {
        flags.set(name.slice(0, eq), name.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Flags accepted by every command. */
const GLOBAL_FLAGS = ["help", "json", "prod"];
const LIST_FLAGS = ["limit", "since", "until", "order", "cursor", "fields", "full"];

/**
 * A silently ignored flag returns unfiltered data that looks filtered — the
 * worst failure mode for an agent-first tool. Every flag must be known.
 */
export function validateFlags(
  flags: Map<string, string | true>,
  allowed: string[],
  context: string,
): void {
  const allow = new Set([...GLOBAL_FLAGS, ...allowed]);
  for (const name of flags.keys()) {
    if (allow.has(name)) continue;
    const guess = [...allow].filter(
      (a) => a.includes(name) || name.includes(a) || levenshteinLte2(a, name),
    );
    fail(
      `Unknown flag --${name} for ${context}.${guess.length > 0 ? ` Did you mean: ${guess.map((g) => `--${g}`).join(", ")}?` : ""}\nValid flags: ${[...allow].map((a) => `--${a}`).join(" ")}`,
    );
  }
}

function levenshteinLte2(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false;
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return (prev[b.length] ?? 3) <= 2;
}

function findProjectRoot(start: string): { root: string; specPath: string } | null {
  let dir = resolve(start);
  for (;;) {
    const specPath = join(dir, SPEC_FILE);
    if (existsSync(specPath)) return { root: dir, specPath };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadSpec(): { spec: AutocliSpec; root: string } {
  const found = findProjectRoot(process.cwd());
  if (!found) {
    fail(`No ${SPEC_FILE} found in this directory or any parent. Run \`autocli init\` in a Convex project root first.`);
  }
  const spec = JSON.parse(readFileSync(found.specPath, "utf8")) as AutocliSpec;
  return { spec, root: found.root };
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

function coerceFilterValue(f: FilterSpec, raw: string): unknown {
  if (f.enumValues) {
    const match = f.enumValues.find((v) => String(v) === raw);
    if (match === undefined) {
      fail(`--${f.flag} must be one of: ${f.enumValues.join(", ")} (got "${raw}")`);
    }
    return match;
  }
  switch (f.kind) {
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) fail(`--${f.flag} expects a number (got "${raw}")`);
      return n;
    }
    case "boolean": {
      if (raw !== "true" && raw !== "false") fail(`--${f.flag} expects true|false (got "${raw}")`);
      return raw === "true";
    }
    default:
      return raw;
  }
}

/** Accepts ISO dates, epoch ms, and durations like 90m / 24h / 7d / 2w. */
export function parseTime(raw: string, now: number): number {
  const dur = /^(\d+)([smhdw])$/.exec(raw);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2];
    const ms =
      unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
    return now - n * ms;
  }
  if (/^\d{12,14}$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    fail(`Could not parse time "${raw}". Use ISO (2026-07-01), epoch ms, or a duration (30m, 24h, 7d).`);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Table commands
// ---------------------------------------------------------------------------

interface CommonOpts {
  root: string;
  prod: boolean;
  json: boolean;
}

interface QueryArgs {
  eqFields: string[];
  eqValues: unknown[];
  activeFilters: string[];
  since?: number;
  until?: number;
  index?: string;
  rangeField?: string;
}

function buildQueryArgs(table: TableSpec, flags: Map<string, string | true>): QueryArgs {
  const providedFilters: { f: FilterSpec; value: unknown }[] = [];
  for (const f of table.filters) {
    const raw = flags.get(f.flag) ?? flags.get(f.field);
    if (raw === undefined) continue;
    if (raw === true) fail(`--${f.flag} needs a value`);
    providedFilters.push({ f, value: coerceFilterValue(f, raw) });
  }

  const wantsTimeRange = flags.get("since") !== undefined || flags.get("until") !== undefined;
  const plan = planQuery(
    table,
    providedFilters.map((p) => p.f.field),
    { timeRange: wantsTimeRange },
  );
  if (!plan.ok) {
    const combos = describeCombos(table)
      .map((c) => `  ${c}`)
      .join("\n");
    fail(`${plan.message}\nValid filter combinations for ${table.name}:\n${combos || "  (none — this table has no indexed filters)"}`);
  }

  const byField = new Map(providedFilters.map((p) => [p.f.field, p.value]));
  const eqValues = plan.fields.map((field) => byField.get(field));
  const args: QueryArgs = {
    eqFields: plan.fields,
    eqValues,
    activeFilters: providedFilters.map((p) => `${p.f.field}=${String(p.value)}`),
  };
  if (plan.index !== undefined) args.index = plan.index;
  if (wantsTimeRange && plan.rangeField !== undefined) args.rangeField = plan.rangeField;

  const now = Date.now();
  const since = flags.get("since");
  if (since !== undefined) {
    if (since === true) fail("--since needs a value");
    args.since = parseTime(since, now);
    args.activeFilters.push(`since ${since}`);
  }
  const until = flags.get("until");
  if (until !== undefined) {
    if (until === true) fail("--until needs a value");
    args.until = parseTime(until, now);
    args.activeFilters.push(`until ${until}`);
  }
  return args;
}

function getLimit(flags: Map<string, string | true>, spec: AutocliSpec): number | undefined {
  const raw = flags.get("limit");
  if (raw === undefined) return undefined;
  if (raw === true) fail("--limit needs a number");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`--limit expects a positive integer (got "${raw}")`);
  if (n > spec.defaults.maxRowLimit) {
    console.error(`(--limit capped at ${spec.defaults.maxRowLimit})`);
    return spec.defaults.maxRowLimit;
  }
  return n;
}

/**
 * Deployed functions echo the schema hash they were generated from; if it
 * differs from the local spec, one side is stale.
 */
function warnOnDrift(spec: AutocliSpec, result: { schemaHash?: string }): void {
  if (result.schemaHash !== undefined && result.schemaHash !== spec.schemaHash) {
    console.error(
      "⚠ schema drift: deployed autocli functions were generated from a different schema than autocli.spec.json. Run `autocli regen` and redeploy.",
    );
  }
  delete result.schemaHash;
}

function runList(spec: AutocliSpec, table: TableSpec, flags: Map<string, string | true>, opts: CommonOpts): void {
  const q = buildQueryArgs(table, flags);
  const payload: Record<string, unknown> = {
    table: table.name,
    eqFields: q.eqFields,
    eqValues: q.eqValues,
  };
  if (q.index !== undefined) payload["index"] = q.index;
  if (q.since !== undefined) payload["since"] = q.since;
  if (q.until !== undefined) payload["until"] = q.until;
  if (q.rangeField !== undefined) payload["rangeField"] = q.rangeField;
  const limit = getLimit(flags, spec);
  if (limit !== undefined) payload["limit"] = limit;
  const order = flags.get("order");
  if (order === "asc" || order === "desc") payload["order"] = order;
  const cursor = flags.get("cursor");
  if (typeof cursor === "string") payload["cursor"] = cursor;
  const fields = flags.get("fields");
  if (typeof fields === "string") payload["fields"] = fields.split(",").map((s) => s.trim());
  if (flags.get("full") === true) payload["full"] = true;

  const result = convexRun("list", payload, { projectDir: opts.root, prod: opts.prod }) as {
    page: Record<string, unknown>[];
    isDone: boolean;
    cursor: string | null;
    schemaHash?: string;
  };
  warnOnDrift(spec, result);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    renderList({
      spec,
      table,
      page: result.page,
      isDone: result.isDone,
      cursor: result.cursor,
      activeFilters: q.activeFilters,
    }),
  );
}

function runDetail(spec: AutocliSpec, table: TableSpec, id: string, flags: Map<string, string | true>, opts: CommonOpts): void {
  const result = convexRun("get", { table: table.name, id }, { projectDir: opts.root, prod: opts.prod }) as {
    doc: Record<string, unknown> | null;
    labels?: Record<string, string | null>;
    related?: { table: string; field: string; count: number; capped: boolean }[];
    error: string | null;
    schemaHash?: string;
  };
  warnOnDrift(spec, result);
  if (result.error) fail(`${result.error}\nHint: ${cliRef(spec)} whois ${id} resolves an id of unknown table.`);
  if (!result.doc) {
    fail(`No ${table.name} document with id ${id}. It may have been deleted.\nHint: ${cliRef(spec)} ${table.name} lists current rows.`);
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    renderDetail({
      spec,
      table,
      doc: result.doc,
      labels: result.labels ?? {},
      related: result.related ?? [],
      full: flags.get("full") === true,
    }),
  );
}

function runCount(spec: AutocliSpec, table: TableSpec, flags: Map<string, string | true>, opts: CommonOpts): void {
  const q = buildQueryArgs(table, flags);
  const by = flags.get("by");
  const payload: Record<string, unknown> = {
    table: table.name,
    eqFields: q.eqFields,
    eqValues: q.eqValues,
  };
  if (q.index !== undefined) payload["index"] = q.index;
  if (q.since !== undefined) payload["since"] = q.since;
  if (q.until !== undefined) payload["until"] = q.until;
  if (q.rangeField !== undefined) payload["rangeField"] = q.rangeField;
  if (flags.get("exact") === true) {
    runExactCount(spec, table, payload, typeof by === "string" ? by : undefined, q.activeFilters, opts);
    return;
  }
  let result: unknown;
  if (typeof by === "string") {
    payload["by"] = by;
    result = convexRun("countBy", payload, { projectDir: opts.root, prod: opts.prod });
  } else {
    result = convexRun("count", payload, { projectDir: opts.root, prod: opts.prod });
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    renderCount(
      table,
      result as { count?: number; capped?: boolean; counts?: Record<string, number>; scanned?: number },
      typeof by === "string" ? by : undefined,
      q.activeFilters,
    ),
  );
}

/**
 * Exact counts at any scale: drive the server's bounded countPage in a cursor
 * loop. Each Convex query reads at most one page, so this stays inside the
 * per-query read limits that make one-shot scans impossible on large tables —
 * and it needs no temp code and no deploy.
 */
const EXACT_MAX_PAGES = 1000;

function runExactCount(
  spec: AutocliSpec,
  table: TableSpec,
  payload: Record<string, unknown>,
  by: string | undefined,
  activeFilters: string[],
  opts: CommonOpts,
): void {
  if (by !== undefined) payload["by"] = by;
  const counts: Record<string, number> = {};
  let total = 0;
  let pages = 0;
  let cursor: string | null = null;
  let truncated = false;
  for (;;) {
    if (cursor !== null) payload["cursor"] = cursor;
    const res = convexRun("countPage", payload, { projectDir: opts.root, prod: opts.prod }) as {
      pageCount: number;
      counts: Record<string, number>;
      isDone: boolean;
      cursor: string | null;
    };
    total += res.pageCount;
    for (const [k, n] of Object.entries(res.counts)) counts[k] = (counts[k] ?? 0) + n;
    pages += 1;
    if (res.isDone || res.cursor === null) break;
    if (pages >= EXACT_MAX_PAGES) {
      truncated = true;
      break;
    }
    cursor = res.cursor;
    if (pages % 20 === 0) process.stderr.write(`…${total} rows scanned\n`);
  }
  if (opts.json) {
    console.log(JSON.stringify({ exact: !truncated, count: total, ...(by ? { counts } : {}), pages, truncated }, null, 2));
    if (truncated) process.exit(1);
    return;
  }
  console.log(
    renderCount(
      table,
      by ? { counts, scanned: total, capped: false } : { count: total, capped: false },
      by,
      activeFilters,
    ),
  );
  console.log(`(exact: ${total} rows aggregated across ${pages} bounded queries)`);
  if (truncated) {
    fail(`Stopped after ${EXACT_MAX_PAGES} pages (~${total} rows). Narrow with filters or --since/--until.`);
  }
}

function runSearch(spec: AutocliSpec, table: TableSpec, query: string, flags: Map<string, string | true>, opts: CommonOpts): void {
  const s = table.search[0];
  if (!s) {
    fail(`${table.name} has no search index.\nTables with search: ${
      Object.values(spec.tables)
        .filter((t) => t.search.length > 0)
        .map((t) => t.name)
        .join(", ") || "(none)"
    }`);
  }
  const filterFields: string[] = [];
  const filterValues: unknown[] = [];
  for (const field of s.filterFields) {
    const filter = table.filters.find((f) => f.field === field);
    const flagName = filter?.flag ?? field;
    const raw = flags.get(flagName) ?? flags.get(field);
    if (raw === undefined || raw === true) continue;
    filterFields.push(field);
    filterValues.push(filter ? coerceFilterValue(filter, raw) : raw);
  }
  const payload: Record<string, unknown> = { table: table.name, query, filterFields, filterValues };
  const limit = getLimit(flags, spec);
  if (limit !== undefined) payload["limit"] = limit;
  const result = convexRun("search", payload, { projectDir: opts.root, prod: opts.prod }) as {
    results: Record<string, unknown>[];
    schemaHash?: string;
  };
  warnOnDrift(spec, result);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    renderList({
      spec,
      table,
      page: result.results,
      isDone: true,
      cursor: null,
      activeFilters: [`search "${query}"`],
    }),
  );
}

// ---------------------------------------------------------------------------
// init / regen
// ---------------------------------------------------------------------------

function interviewQuestions(spec: AutocliSpec): string {
  const cli = cliRef(spec);
  return `## Finishing interview — 6 questions for a human (or an agent who knows the product)

The generated spec is a correct skeleton. These answers make it great. Record
them by editing ${SPEC_FILE} (fields: cliName, workflows, tables.<name>.hint,
tables.<name>.description, tables.<name>.redactedFields), then re-run
\`${cli} regen\` any time — schema changes merge in without clobbering your edits.

1. Name: this CLI currently answers to \`${cli}\`. Is that the name people and
   agents will recognize as "${spec.projectName}'s data tool"? Edit "cliName"
   in the spec and re-run regen to rename (the old shim is cleaned up).
   Workflow step commands may keep the canonical \`autocli\` prefix — it
   renders as the current name.
2. Sensitive data: these fields were auto-redacted by name heuristics — review
   the "redactedFields" of each table. Anything to un-redact? Anything missed?
3. Workflows: what are the top 2-3 recurring questions you (or agents) ask of
   this data? ("why is customer X broken", "what did agent Y retrieve", ...)
   Replace the generated seed workflow with numbered real ones.
4. Cost/danger hints: which tables are huge, expensive, or misleading without
   context? Add a "hint" to those tables.
5. Descriptions: skim the generated one-liners in \`${cli} tables\` — fix any
   that describe the schema but miss the intent.
6. Prod policy: is read-only prod access via --prod acceptable, or should this
   CLI stay dev-only? (If dev-only, say so in your agent instructions.)

Spec edits to redactedFields/identityFields only take effect server-side after
\`${cli} regen\` and a deploy (\`npx convex dev\` picks it up automatically).
`;
}

function detectProjectName(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
    if (pkg.name) return pkg.name;
  } catch {
    // fall through
  }
  return resolve(root).split("/").pop() ?? "project";
}

/** Preserve human-editable enrichments across regeneration. */
function mergeSpecs(old: AutocliSpec, fresh: AutocliSpec): AutocliSpec {
  const merged: AutocliSpec = { ...fresh };
  if (old.cliName) merged.cliName = old.cliName;
  const keptWorkflows = old.workflows.filter((w) => w.todo !== true);
  if (keptWorkflows.length > 0) merged.workflows = keptWorkflows;
  for (const [name, freshTable] of Object.entries(fresh.tables)) {
    const oldTable = old.tables[name];
    if (!oldTable) continue;
    merged.tables[name] = {
      ...freshTable,
      description: oldTable.description,
      // Display preferences are human-owned; the server-side projection
      // silently skips fields that no longer exist after a schema change.
      identityFields: oldTable.identityFields,
      redactedFields: oldTable.redactedFields,
      blobFields: oldTable.blobFields,
      ...(oldTable.hint ? { hint: oldTable.hint } : {}),
      ...(oldTable.labelField ? { labelField: oldTable.labelField } : {}),
    };
  }
  return merged;
}

const SHIM_MARKER = "Generated by autocli";

/**
 * Root-level executable named after the project, so every rendered command
 * (`./fb jobs --status failed`) is copy-pasteable verbatim. Resolves the
 * installed autocli package first, falling back to the absolute path of the
 * generator that wrote it (regen refreshes the path).
 */
function shimSource(): string {
  const selfPath = fileURLToPath(import.meta.url);
  return `#!/usr/bin/env node
// ${SHIM_MARKER} — this project's data CLI. Rename via "cliName" in ${SPEC_FILE} + regen.
import("autocli/cli")
  .catch(() => import(${JSON.stringify(selfPath)}))
  .then((m) => m.main(process.argv.slice(2)));
`;
}

/** Remove a previous name's shim + skill dir (only artifacts we created). */
function cleanupRenamedArtifacts(root: string, oldName: string): void {
  const shim = join(root, oldName);
  try {
    if (existsSync(shim) && readFileSync(shim, "utf8").includes(SHIM_MARKER)) rmSync(shim);
  } catch {
    // never let cleanup block regen
  }
  const skillDir = join(root, ".claude", "skills", oldName);
  if (existsSync(join(skillDir, "SKILL.md"))) rmSync(skillDir, { recursive: true, force: true });
}

function runInit(regen: boolean): void {
  const root = process.cwd();
  if (!existsSync(join(root, "convex"))) {
    fail("No convex/ directory here. Run autocli init from your Convex project root.");
  }
  console.error(`Introspecting Convex schema in ${root}…`);
  let ir;
  try {
    ir = introspectConvexProject(root);
  } catch (e) {
    if (e instanceof IntrospectError) fail(e.message);
    throw e;
  }
  console.error(`Found ${ir.tables.length} tables.`);

  let spec = generateSpec(ir, { projectName: detectProjectName(root) });
  const specPath = join(root, SPEC_FILE);
  let oldName: string | undefined;
  if (existsSync(specPath)) {
    if (!regen) {
      fail(`${SPEC_FILE} already exists. Use \`autocli regen\` to refresh it (your edits are preserved).`);
    }
    const old = JSON.parse(readFileSync(specPath, "utf8")) as AutocliSpec;
    // Pre-cliName specs shipped their skill under the generic name.
    oldName = old.cliName ?? "autocli";
    spec = mergeSpecs(old, spec);
    console.error("Merged existing spec enrichments (name, descriptions, hints, workflows, redactions).");
  }
  const name = spec.cliName;
  const cli = cliRef(spec);

  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const convexModulePath = join(root, "convex", "autocli.ts");
  writeFileSync(convexModulePath, generateConvexModule(spec));
  writeFileSync(join(root, "AUTOCLI-INTERVIEW.md"), interviewQuestions(spec));
  if (oldName && oldName !== name) cleanupRenamedArtifacts(root, oldName);
  const shimPath = join(root, name);
  writeFileSync(shimPath, shimSource());
  chmodSync(shimPath, 0o755);
  mkdirSync(join(root, ".claude", "skills", name), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", name, "SKILL.md"), renderSkill(spec));

  const tableCount = Object.keys(spec.tables).length;
  const searchCount = Object.values(spec.tables).filter((t) => t.search.length > 0).length;
  const redactedCount = Object.values(spec.tables).reduce((n, t) => n + t.redactedFields.length, 0);
  console.log(`✓ ${SPEC_FILE} — ${tableCount} tables, ${searchCount} searchable, ${redactedCount} fields auto-redacted`);
  console.log(`✓ convex/autocli.ts — read-only internal query surface (deploys with \`npx convex dev\`)`);
  console.log(`✓ ${name} — executable shim; this project's CLI answers to \`${cli}\``);
  console.log(`✓ AUTOCLI-INTERVIEW.md — 6 questions to finish the CLI (or hand to an agent)`);
  console.log(`✓ .claude/skills/${name}/SKILL.md — agents discover the CLI without prompting`);
  console.log("");
  console.log("Add to AGENTS.md / CLAUDE.md:");
  console.log(`  For data questions, start with \`${cli} --help\`; do not guess flags from memory.`);
  console.log("");
  console.log(`Try: ${cli} --help   |   ${cli} tables   |   ${cli} guide`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function main(argv: string[]): void {
  const { positional, flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  const prod = flags.get("prod") === true;
  const wantHelp = flags.get("help") === true || positional.includes("help");

  const cmd = positional[0];

  if (cmd === "init" || cmd === "regen") {
    runInit(cmd === "regen");
    return;
  }

  if (cmd === undefined || (wantHelp && cmd === undefined)) {
    const { spec } = loadSpec();
    console.log(renderTopHelp(spec));
    return;
  }

  const { spec, root } = loadSpec();
  const opts: CommonOpts = { root, prod, json };

  if (cmd === "guide") {
    validateFlags(flags, [], "guide");
    console.log(renderGuide(spec));
    return;
  }
  if (cmd === "tables") {
    validateFlags(flags, [], "tables");
    console.log(renderTablesOverview(spec));
    return;
  }
  if (wantHelp && positional.length === 1 && !spec.tables[cmd]) {
    console.log(renderTopHelp(spec));
    return;
  }
  if (cmd === "whois") {
    validateFlags(flags, [], "whois");
    const id = positional[1];
    if (!id) fail(`Usage: ${cliRef(spec)} whois <id>`);
    const result = convexRun("whois", { id }, { projectDir: root, prod }) as {
      table: string | null;
      doc: Record<string, unknown> | null;
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.table) process.exit(1);
      return;
    }
    if (!result.table) {
      fail(`${id} does not match any table in this deployment. Ids look like "jd7f8..." — check for truncation.`);
    }
    console.log(renderWhois(spec, id, result));
    if (result.table && result.doc) {
      console.log("");
      console.log("Next steps:");
      console.log(`  ${cliRef(spec)} ${result.table} ${id}     -- linked records + labels`);
    }
    return;
  }

  const table = spec.tables[cmd];
  if (!table) {
    const names = Object.keys(spec.tables);
    const guess = names.filter((n) => n.toLowerCase().includes(cmd.toLowerCase())).slice(0, 5);
    fail(
      `Unknown command or table "${cmd}".${guess.length > 0 ? ` Did you mean: ${guess.join(", ")}?` : ""}\nRun \`${cliRef(spec)} tables\` for the full list, or \`${cliRef(spec)} --help\` for usage.`,
    );
  }

  if (wantHelp) {
    console.log(renderTableHelp(spec, table));
    return;
  }

  const sub = positional[1];
  const filterFlags = table.filters.flatMap((f) => [f.flag, f.field]);
  try {
    if (sub === "count") {
      validateFlags(flags, [...LIST_FLAGS, ...filterFlags, "by", "exact"], `${table.name} count`);
      runCount(spec, table, flags, opts);
    } else if (sub === "search") {
      const query = positional[2];
      if (!query) fail(`Usage: ${cliRef(spec)} ${table.name} search "query"`);
      const searchFlags = (table.search[0]?.filterFields ?? []).flatMap((field) => {
        const f = table.filters.find((x) => x.field === field);
        return f ? [f.flag, f.field] : [field];
      });
      validateFlags(flags, ["limit", ...searchFlags], `${table.name} search`);
      runSearch(spec, table, query, flags, opts);
    } else if (sub !== undefined) {
      validateFlags(flags, ["full", "fields"], `${table.name} detail`);
      runDetail(spec, table, sub, flags, opts);
    } else {
      validateFlags(flags, [...LIST_FLAGS, ...filterFlags], table.name);
      runList(spec, table, flags, opts);
    }
  } catch (e) {
    if (e instanceof ConvexRunError) fail(e.message);
    throw e;
  }
}
