# Eval: generated CLI vs. the real first fb CLI

Ground truth: `ground-truth/fb-v1.mjs` + `ground-truth/admin-v1.ts` — the
actual first admin CLI written for this codebase (commit 2d2f1af, 2026-03-08),
extracted from git history. The snapshot in `faithbase-pre-cli/` is the parent
commit: the exact codebase state the fb author faced, with no CLI and no git
history (exported via `git archive`).

## Protocol

1. **Deterministic round** (no LLM): run `autocli init` on the snapshot.
   Score the generated CLI alone.
2. **Finishing round**: give an agent the snapshot + generated artifacts +
   AUTOCLI-INTERVIEW.md and let it enrich the spec (and optionally add custom
   commands). The agent must never see fb-v1, today's faithbase, or git
   history. Score the finished CLI.
3. Compare both against fb-v1 on the rubric. Also score fb-v1 itself —
   the generated CLI can win dimensions (e.g. fb-v1 had no time filters,
   no counts, no whois, no redaction).

## Rubric (score each 0–2: missing / present / better than ground truth)

**Coverage**
- C1. Can it answer fb-v1's five core tasks? (list orgs w/ source counts;
  list sources for an org; inspect a source's chunks+questions; anything
  approximating dry-run/regenerate is out of scope for read-only v1)
- C2. Can it answer questions fb-v1 could NOT? (conversations for an agent,
  job failures in last 24h, message volume by org, resolve unknown id)

**Agent UX**
- U1. Workflow-map help (numbered, dependency-ordered, real commands)
- U2. Next-steps footers with real ids from live output
- U3. Errors that teach (bad filter → valid combos; bad id → whois; bad
  table → suggestions; non-zero exit codes)
- U4. Hints encode cost/safety, not just mechanics

**Token economy** (measure with chars/4 on live output)
- T1. Org list ≤ 300 tokens; detail view ≤ 500 tokens
- T2. "Distribution" question answerable without fetching rows (count --by)
- T3. Blob/content fields elided by default, expandable deliberately
- T4. Standing cost: one AGENTS.md line vs fb's (also one line — tie)

**Safety**
- S1. Read-only by construction (internalQuery)
- S2. Secrets/PII redacted server-side (fb-v1: none — generated CLI should win)
- S3. All queries index-backed; no scan-capable flag exists (fb-v1: handwritten
  queries, safe by authorship; generated must be safe by construction)
- S4. Dev-default, explicit --prod (fb-v1 has this — parity expected)

**Composite views (the "last 30%")**
- V1. Aggregated counts in list views (fb: sourceCount per org, chunkCount
  per source). Generated detail view has linked-record counts; list views
  do not — expected gap for deterministic round.
- V2. Task-specific composite view (fb inspect = source + org + chunks +
  questions in one round-trip). Expected gap; finishing agent may close it.

## Success criteria

- Deterministic round: wins Safety + Token economy, ties Agent UX, loses
  Composite views. Coverage: C2 win offsets partial C1.
- Finishing round: closes C1 fully and V1/V2 partially, without regressing
  determinism (enrichments live in the spec, custom commands clearly marked).
