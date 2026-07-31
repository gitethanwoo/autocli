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

This emits three artifacts:

1. **`autocli.spec.json`** — the committed, human/agent-editable spec that
   drives everything: identity projections, index-backed filters, FK
   relations, redactions, workflow groups. Re-running `autocli regen` after a
   schema change merges structure refreshes without clobbering your edits.
2. **`convex/autocli.ts`** — a generated, read-only `internalQuery` surface
   (unreachable from clients; callable only with deployment credentials).
   Redaction, table allowlisting, and row caps enforce server-side.
3. **`AUTOCLI-INTERVIEW.md`** — five questions whose answers turn a correct
   CLI into a great one (real workflows, cost hints, redaction review).

## Design principles

- **Any datum in ≤3 hops, each hop ~100–200 tokens, near-zero standing cost.**
  One line in AGENTS.md ("start with `autocli --help`") replaces persistent
  tool schemas.
- **Output is the next prompt.** Every list/detail ends with copy-pasteable
  "Next steps" commands pre-filled with real ids from the data just fetched.
- **Filters are index-backed or they don't exist.** No flag can trigger a full
  table scan. Rejected combinations print the valid ones.
- **Counts before rows.** `autocli jobs count --by status --since 24h` answers
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

```
autocli <table>                  bounded list, newest first, identity columns
autocli <table> <id>             full record + labels for FK ids + linked-record counts
autocli <table> count [--by f]   count or distribution — never dumps rows
autocli <table> search "query"   full-text (only tables with a search index)
autocli whois <id>               resolve any document id to its table + record
autocli tables | guide | --help  progressive disclosure, written for agents
```

## Status

Early. Convex adapter only. Postgres/Drizzle adapters are the obvious next
targets — the spec format and runtime are adapter-agnostic by design.
