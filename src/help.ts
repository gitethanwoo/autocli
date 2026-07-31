import type { AutocliSpec, TableSpec } from "./types.js";

export function renderTopHelp(spec: AutocliSpec): string {
  const parts: string[] = [];
  parts.push(`autocli — data exploration CLI for ${spec.projectName} (generated from its Convex schema)`);
  parts.push("");
  parts.push("An agent-first tool. Read-only. Targets the dev deployment unless --prod is passed.");
  parts.push("");
  parts.push("Usage: autocli <table> [id] [flags]   |   autocli <command>");

  for (const wf of spec.workflows) {
    parts.push("");
    parts.push(`${wf.title}:`);
    wf.steps.forEach((s, i) => {
      parts.push(`  ${i + 1}. ${s.cmd.padEnd(44)} -- ${s.note}`);
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
    if (flags.length > 0) extras.push(flags.join(" "));
    parts.push(`  ${name.padEnd(32)} ${extras.join("  ")}`);
  }

  parts.push("");
  parts.push("Per-table commands:");
  parts.push("  autocli <table>                    -- list rows (newest first, capped)");
  parts.push("  autocli <table> <id>               -- full record + linked-record counts");
  parts.push("  autocli <table> count [--by f]     -- count or distribution, never dumps rows");
  parts.push('  autocli <table> search "query"     -- full-text search (tables marked "search")');
  parts.push("");
  parts.push("Global commands:");
  parts.push("  autocli whois <id>                 -- resolve any document id to its table + record");
  parts.push("  autocli tables                     -- table overview with row-level detail");
  parts.push("  autocli guide                      -- how to use this CLI well (for agents: start here)");
  parts.push("  autocli regen                      -- re-introspect schema, regenerate spec + functions");
  parts.push("");
  parts.push("Common flags: --limit N  --since <iso|ms>  --until <iso|ms>  --order asc|desc");
  parts.push("              --fields a,b,c  --full  --json  --cursor <c>  --prod");
  parts.push("");
  parts.push("Run `autocli <table> --help` for that table's filters and relations.");
  return parts.join("\n");
}

export function renderTableHelp(spec: AutocliSpec, t: TableSpec): string {
  const parts: string[] = [];
  parts.push(`autocli ${t.name} — ${t.description}`);
  if (t.hint) {
    parts.push("");
    parts.push(`Hint: ${t.hint}`);
  }
  parts.push("");
  parts.push(`Usage:`);
  parts.push(`  autocli ${t.name} [flags]              -- list (columns: ${t.identityFields.join(", ")})`);
  parts.push(`  autocli ${t.name} <id>                 -- full record`);
  parts.push(`  autocli ${t.name} count [--by field]`);
  if (t.search.length > 0) {
    const s = t.search[0];
    if (s) {
      const filterNote = s.filterFields.length > 0 ? ` (filters: ${s.filterFields.join(", ")})` : "";
      parts.push(`  autocli ${t.name} search "query"       -- full-text over ${s.searchField}${filterNote}`);
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
    const combos = t.indexes
      .map((i) => i.fields.filter((f) => f !== "_creationTime"))
      .filter((f) => f.length > 1);
    if (combos.length > 0) {
      parts.push("");
      parts.push("Valid filter combinations (index prefixes):");
      for (const c of combos.slice(0, 8)) parts.push(`  ${c.join(" + ")}`);
    }
  }

  if (t.belongsTo.length > 0) {
    parts.push("");
    parts.push("Belongs to: " + t.belongsTo.map((b) => `${b.table} (via ${b.field})`).join(", "));
  }
  if (t.hasMany.length > 0) {
    parts.push("Has many:");
    for (const r of t.hasMany) {
      parts.push(`  ${r.table.padEnd(28)} autocli ${r.table} --${r.flag} <${t.name} id>`);
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

export function renderGuide(spec: AutocliSpec): string {
  const tableNames = Object.keys(spec.tables).sort();
  const searchable = tableNames.filter((n) => (spec.tables[n]?.search.length ?? 0) > 0);
  return `# Using autocli (${spec.projectName})

This CLI was generated from the project's Convex schema. It is read-only,
index-backed (no query can trigger a full table scan), and caps every output.
Secrets and PII are stripped server-side before anything reaches you.

## The core loop

1. autocli --help              # the map: workflows, tables, filters
2. autocli <table>             # bounded list, newest first
3. autocli <table> <id>        # one record + counts of linked records
4. Follow the "Next steps" lines printed under every output — they contain
   real ids from the data you just fetched. Copy them verbatim.

## Answering "what happened?"

- Prefer counts over rows: autocli <table> count --by <field> --since 24h
- Time-bound everything: --since accepts ISO dates, epoch ms, or durations (24h, 7d).
- If you hold an id from a log/error and don't know its table: autocli whois <id>.
${searchable.length > 0 ? `- Full-text search: ${searchable.map((n) => `autocli ${n} search "..."`).join("; ")}.` : ""}

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
