import { describeCombos } from "./planner.js";
import { cliRef, normalizeStepCmd, normalizeStepNote } from "./spec.js";
import type { AutocliSpec, TableSpec } from "./types.js";

export function renderTopHelp(spec: AutocliSpec): string {
  const cli = cliRef(spec);
  const parts: string[] = [];
  parts.push(`${spec.cliName ?? "autocli"} — data exploration CLI for ${spec.projectName} (generated from its Convex schema)`);
  parts.push("");
  parts.push("An agent-first tool. Read-only. Targets the dev deployment unless --prod is passed.");
  parts.push("");
  parts.push(`Usage: ${cli} <table> [id] [flags]   |   ${cli} <command>`);

  for (const wf of spec.workflows) {
    parts.push("");
    parts.push(`${wf.title}:`);
    wf.steps.forEach((s, i) => {
      parts.push(`  ${i + 1}. ${normalizeStepCmd(s.cmd, cli).padEnd(44)} -- ${normalizeStepNote(s.note, cli)}`);
    });
  }

  parts.push("");
  parts.push("Tables:");
  const names = Object.keys(spec.tables).sort();
  for (const name of names) {
    const t = spec.tables[name];
    if (!t) continue;
    const extras: string[] = [];
    if (t.search.length > 0) extras.push("search");
    const flags = t.filters.slice(0, 3).map((f) => `--${f.flag}`);
    if (t.filters.length > 3) flags.push(`(+${t.filters.length - 3} more)`);
    if (flags.length > 0) extras.push(flags.join(" "));
    parts.push(`  ${name.padEnd(32)} ${extras.join("  ")}`);
  }

  parts.push("");
  parts.push("Per-table commands:");
  parts.push(`  ${cli} <table>                    -- list rows (newest first, capped)`);
  parts.push(`  ${cli} <table> <id>               -- full record + linked-record counts`);
  parts.push(`  ${cli} <table> count [--by f]     -- count or distribution, never dumps rows`);
  parts.push(`  ${cli} <table> search "query"     -- full-text search (tables marked "search")`);
  parts.push("");
  parts.push("Global commands:");
  parts.push(`  ${cli} whois <id>                 -- resolve any document id to its table + record`);
  parts.push(`  ${cli} tables                     -- table overview with row-level detail`);
  parts.push(`  ${cli} guide                      -- how to use this CLI well (for agents: start here)`);
  parts.push(`  ${cli} regen                      -- re-introspect schema, regenerate spec + functions`);
  parts.push("");
  parts.push("Common flags: --limit N  --since <iso|ms>  --until <iso|ms>  --order asc|desc");
  parts.push("              --fields a,b,c  --full  --json  --cursor <c>  --prod");
  parts.push("");
  parts.push(`Run \`${cli} <table> --help\` for that table's filters and relations.`);
  return parts.join("\n");
}

export function renderTableHelp(spec: AutocliSpec, t: TableSpec): string {
  const cli = cliRef(spec);
  const parts: string[] = [];
  parts.push(`${cli} ${t.name} — ${t.description}`);
  if (t.hint) {
    parts.push("");
    parts.push(`Hint: ${t.hint}`);
  }
  parts.push("");
  parts.push(`Usage:`);
  parts.push(`  ${cli} ${t.name} [flags]              -- list (columns: ${t.identityFields.join(", ")})`);
  parts.push(`  ${cli} ${t.name} <id>                 -- full record`);
  parts.push(`  ${cli} ${t.name} count [--by field]`);
  if (t.search.length > 0) {
    const s = t.search[0];
    if (s) {
      const filterNote = s.filterFields.length > 0 ? ` (filters: ${s.filterFields.join(", ")})` : "";
      parts.push(`  ${cli} ${t.name} search "query"       -- full-text over ${s.searchField}${filterNote}`);
    }
  }

  if (t.filters.length > 0) {
    parts.push("");
    parts.push("Filters (each backed by an index — arbitrary combinations may be rejected):");
    for (const f of t.filters) {
      let type: string = f.kind;
      if (f.refTable) type = `id of ${f.refTable}`;
      if (f.enumValues) type = f.enumValues.slice(0, 6).join("|");
      parts.push(`  --${f.flag.padEnd(28)} ${type}`);
    }
    const combos = describeCombos(t);
    if (combos.length > 0) {
      parts.push("");
      parts.push("Valid filter combinations (index prefixes; any prefix of one works):");
      for (const c of combos) parts.push(`  ${c}`);
    }
  }

  if (t.belongsTo.length > 0) {
    parts.push("");
    parts.push("Belongs to: " + t.belongsTo.map((b) => `${b.table} (via ${b.field})`).join(", "));
  }
  if (t.hasMany.length > 0) {
    parts.push("Has many:");
    for (const r of t.hasMany) {
      parts.push(`  ${r.table.padEnd(28)} ${cli} ${r.table} --${r.flag} <${t.name} id>`);
    }
  }
  if (t.redactedFields.length > 0) {
    parts.push("");
    parts.push(`Redacted fields (never returned): ${t.redactedFields.join(", ")}`);
  }
  return parts.join("\n");
}

export function renderTablesOverview(spec: AutocliSpec): string {
  const parts: string[] = [];
  parts.push(`Tables in ${spec.projectName} (${Object.keys(spec.tables).length}):`);
  parts.push("");
  for (const name of Object.keys(spec.tables).sort()) {
    const t = spec.tables[name];
    if (!t) continue;
    parts.push(`${name}`);
    parts.push(`  ${t.description}`);
    const rel: string[] = [];
    if (t.belongsTo.length > 0) rel.push(`→ ${t.belongsTo.map((b) => b.table).join(", ")}`);
    if (t.hasMany.length > 0) rel.push(`← ${t.hasMany.map((r) => r.table).join(", ")}`);
    if (rel.length > 0) parts.push(`  ${rel.join("   ")}`);
  }
  return parts.join("\n");
}

/**
 * Generated Claude Code skill: makes the CLI discoverable without any prompt.
 * Kept thin — `<cli> guide` and `--help` are served by the binary itself and
 * can never drift from it.
 */
export function renderSkill(spec: AutocliSpec): string {
  const cli = cliRef(spec);
  const name = spec.cliName ?? "autocli";
  const tables = Object.keys(spec.tables).sort();
  const preview = tables.slice(0, 6).join(", ");
  const hasTodoWorkflows = spec.workflows.some((w) => w.todo === true);
  return `---
name: ${name}
description: Query and explore ${spec.projectName}'s live Convex data (${preview}${tables.length > 6 ? ", …" : ""}). Use for any question about what's in the database — "what happened here", debugging data state, tracing a record by id, counting/segmenting rows. Read-only and token-lean. Start with \`${cli} --help\`.
---

# ${name} — ${spec.projectName} data exploration

Generated from this project's Convex schema. Read-only, index-backed, bounded
output. Run \`${cli}\` from the project root; targets the dev deployment
unless --prod.

## Core loop

1. \`${cli} --help\`        — workflows, tables, filters (the map)
2. \`${cli} <table>\`       — bounded list, newest first
3. \`${cli} <table> <id>\`  — full record + linked-record counts
4. Copy the "Next steps" commands printed under every output — they contain
   real ids from the data you just fetched.

## High-leverage commands

- \`${cli} <table> count --by <field> --since 24h\` — answer distribution
  questions in ~30 tokens without fetching rows
- \`${cli} whois <id>\` — resolve an id from a log/error to its record
- \`${cli} tables\` — every table with its relations
- \`${cli} guide\` — full usage guide, served by the binary (version-matched)

## Rules

- Never guess flags — on a filter error, use a combination the error lists.
- Prefer counts over lists, filters over paging, --json only when parsing.
${hasTodoWorkflows ? "\n## Note\n\nThe spec still contains generated seed workflows (marked todo) — see\nAUTOCLI-INTERVIEW.md in the project root to finish the CLI for this project.\n" : ""}`;
}

export function renderGuide(spec: AutocliSpec): string {
  const cli = cliRef(spec);
  const tableNames = Object.keys(spec.tables).sort();
  const searchable = tableNames.filter((n) => (spec.tables[n]?.search.length ?? 0) > 0);
  return `# Using ${spec.cliName ?? "autocli"} (${spec.projectName})

This CLI was generated from the project's Convex schema. It is read-only,
index-backed (no query can trigger a full table scan), and caps every output.
Secrets and PII are stripped server-side before anything reaches you.

## The core loop

1. ${cli} --help              # the map: workflows, tables, filters
2. ${cli} <table>             # bounded list, newest first
3. ${cli} <table> <id>        # one record + counts of linked records
4. Follow the "Next steps" lines printed under every output — they contain
   real ids from the data you just fetched. Copy them verbatim.

## Answering "what happened?"

- Prefer counts over rows: ${cli} <table> count --by <field> --since 24h
- Time-bound everything: --since accepts ISO dates, epoch ms, or durations (24h, 7d).
- If you hold an id from a log/error and don't know its table: ${cli} whois <id>.
${searchable.length > 0 ? `- Full-text search: ${searchable.map((n) => `${cli} ${n} search "..."`).join("; ")}.` : ""}

## Filters are index-backed

Each table only exposes filters its indexes can serve. If a combination is
rejected, the error lists valid combinations — pick one, don't retry blindly.

## Token economy

- Lists show identity columns only. --fields a,b,c to choose, --full for everything.
- Blob fields are truncated in detail views; --full expands.
- --json gives the raw envelope when you need to parse (includes full cursor).
- Outputs are trimmed to ~${spec.defaults.outputTokenBudget} tokens; narrow instead of paging when trimmed.

## Safety

- Dev deployment by default; --prod is explicit and should stay rare.
- Read-only by construction: every backing function is an internalQuery.
- Row caps: lists max ${spec.defaults.maxRowLimit}, counts cap at ${spec.defaults.countCap} ("${spec.defaults.countCap}+").
`;
}
