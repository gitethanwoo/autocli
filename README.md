# autocli

Generate a progressive-disclosure, agent-first data-exploration CLI from a
Convex schema — deterministically.

Agents are only as good as their access to project data. MCP servers put tens
of thousands of schema tokens in the context window before the first call;
generic SQL runners make agents rediscover the data model every session and
dump unbounded output when they get it wrong. The alternative that works —
hand-built admin CLIs with workflow help, real-id "next steps" footers, and
bounded output — costs real engineering time per project.

autocli generates that CLI from schema introspection.

```
npx autocli init        # in a Convex project root
```

The generated CLI takes your project's name — in a repo named `faithbase` it
answers to `./faithbase`, not `autocli`. The model using it should read what
it is from every command. Rename via `cliName` in the spec.

`init` emits:

1. **`autocli.spec.json`** — the committed, human/agent-editable spec that
   drives everything: CLI name, identity projections, index-backed filters,
   FK relations, redactions, workflow groups. Re-running `regen` after a
   schema change merges structure refreshes without clobbering your edits.
2. **`convex/autocli.ts`** — a generated, read-only `internalQuery` surface
   (unreachable from clients; callable only with deployment credentials).
   Redaction, table allowlisting, and row caps enforce server-side.
3. **`./<cliName>`** — an executable shim at the project root, so every
   rendered command is copy-pasteable verbatim.
4. **`AUTOCLI-INTERVIEW.md`** — six questions whose answers turn a correct
   CLI into a great one (name, real workflows, cost hints, redaction review).
5. **`.claude/skills/<cliName>/SKILL.md`** — agents discover the CLI without
   any prompting; usage docs are served by the binary so they can't drift.

## Design principles

- **Any datum in ≤3 hops, each hop ~100–200 tokens, near-zero standing cost.**
  One line in AGENTS.md ("start with `./yourproject --help`") replaces
  persistent tool schemas.
- **Output is the next prompt.** Every list/detail ends with copy-pasteable
  "Next steps" commands pre-filled with real ids from the data just fetched.
- **Filters are index-backed or they don't exist.** No flag can trigger a full
  table scan. Rejected combinations print the valid ones.
- **Counts before rows.** `./fb jobs count --by status --since 24h` answers
  most "what happened" questions in ~30 output tokens.
- **Bounded everything.** Row caps, output token budget with
  trimming-that-teaches, blob elision with `--full` opt-in, count caps shown
  as `1000+`.
- **Errors teach.** Wrong table → suggestions; missing id → `whois`; invalid
  filter combo → the list of valid ones. Non-zero exit codes always.
- **Safety by construction, not convention.** Read-only internal functions,
  dev deployment by default (`--prod` is explicit), secrets/PII stripped
  before leaving the deployment, audited allowlist.

## Command surface (generated per project)

Shown for a project named `fb`:

```
./fb <table>                  bounded list, newest first, identity columns
./fb <table> <id>             full record + labels for FK ids + linked-record counts
./fb <table> count [--by f]   count or distribution — never dumps rows
./fb <table> search "query"   full-text (only tables with a search index)
./fb whois <id>               resolve any document id to its table + record
./fb tables | guide | --help  progressive disclosure, written for agents
```

## Status

Early. Convex adapter only. Postgres/Drizzle adapters are the obvious next
targets — the spec format and runtime are adapter-agnostic by design.
