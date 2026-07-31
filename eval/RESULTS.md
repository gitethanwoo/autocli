# Eval results: autocli vs. the real first fb CLI

Protocol per RUBRIC.md. Snapshot: faithbase at the commit before its CLI existed
(20 tables, exported via `git archive`, no git history), running on a local
anonymous Convex deployment with seeded data. Three contestants:

- **fb-v1** — the actual first admin CLI written for this codebase (ground truth)
- **Deterministic** — `autocli init`, zero LLM involvement
- **Finished** — deterministic output + a finishing agent given ONLY the snapshot,
  the generated artifacts (spec, interview file, skill), and the instruction
  "improve this project's autocli setup". It never saw fb-v1, git history,
  the rubric, or any hint of what we'd score.

All token numbers are live measurements (chars/4) against the seeded deployment.

## Scores (0 = missing, 1 = present, 2 = better than ground truth)

| Dim | What | fb-v1 | Determ. | Finished | Notes |
|-----|------|:-:|:-:|:-:|-------|
| C1 | fb-v1's core tasks | 2 | 1 | 1 | All read tasks answerable; fb's `inspect` composite takes 2–3 autocli calls (~380 tokens total). dry-run/regenerate are actions, out of scope for read-only v1. |
| C2 | Tasks fb-v1 could NOT do | 0 | 2 | 2 | `jobs count --by status --since 24h` (25 tokens), `whois <id>`, per-org message volume, analytics backlog — none possible in fb-v1. |
| U1 | Workflow-map help | 1 | 1 | 2 | Deterministic round ships one FK-derived seed workflow (marked todo). Finished ships 4 real, command-verified workflows (debug bad answer, stuck ingestion, analytics health, org billing snapshot). |
| U2 | Next-steps footers w/ real ids | 1 | 2 | 2 | autocli interpolates real ids from the rows just fetched; copy-paste continues the investigation. |
| U3 | Errors that teach | 1 | 2 | 2 | Bad filter → valid index-prefix combos; unknown flag → levenshtein suggestion; bad id → whois hint; all exit 1. |
| U4 | Hints encode cost/safety | 0 | 0 | 2 | Hints are enrichments, so deterministic scores 0 by design. Finisher added 12 (embedding blobs, soft-delete `deletedAt`, filter-combo gotchas, pastoral-content sensitivity). |
| T1 | List ≤300 / detail ≤500 tokens | 1 | 2 | 2 | Org list ~140, org detail ~376, sources list ~100. fb-v1 had no output caps at all. |
| T2 | Distributions without rows | 0 | 2 | 2 | `count --by` answers in ~25 tokens; hard cap "1000+". |
| T3 | Blob elision | 0 | 2 | 2 | fb `inspect` dumped chunk content. autocli truncates blobs, `--full` expands deliberately. |
| T4 | Standing context cost | 1 | 2 | 2 | fb: one AGENTS.md line. autocli: generated Claude skill — zero prompt cost until invoked, and docs are served by the binary so they can't drift. |
| S1 | Read-only by construction | 1 | 2 | 2 | fb was read-only by authorship (and shipped mutation-adjacent `regenerate`). Every autocli function is an `internalQuery`. |
| S2 | Server-side redaction | 0 | 2 | 2 | fb: none. Deterministic: 12 fields auto-redacted. Finisher reviewed: un-redacted a false positive (`jobs.stageKey`), added `prayerRequests.requesterName` + `leads.customFields`. |
| S3 | Index-backed only, no scan flag | 1 | 2 | 2 | fb safe by authorship; autocli safe by construction — no flag exists that can cause a table scan, including `--since` (planner requires a range-capable index or rejects with teaching). |
| S4 | Dev-default, explicit --prod | 1 | 1 | 1 | Parity, as expected. |
| V1 | Aggregated counts in LIST views | 2 | 0 | 0 | fb's org list showed sourceCount per row. autocli only counts in detail views. Known product gap. |
| V2 | Task composite view (fb `inspect`) | 2 | 0 | 1 | No single-command composite. Finisher's workflow chains the 3 calls (~380 tokens, bounded — vs fb's 1 call, unbounded), a partial substitute. |
| **Total** | | **14** | **23** | **27** | |

## Verdict

- **Deterministic round beat the human-written ground truth 23–14** on this
  rubric, winning Safety, Token economy, and breadth outright — with zero LLM
  tokens spent. It loses exactly where predicted: composite views and
  instance knowledge (hints, real workflows).
- **The finishing round closed most of the remaining gap (27)** — and did so
  from a deliberately minimal, uncontaminated prompt. Every workflow, hint,
  and redaction judgment came from the shipped artifacts (SKILL.md, interview
  file, `autocli guide`) plus reading the codebase. That's the generalization
  property we required: the guidance lives in generated artifacts, not in
  anyone's prompt.
- **Residual gaps are product features, not eval failures:** V1 (aggregated
  counts in list rows) and V2 (spec-declared composite views) need spec-level
  support; the finisher also surfaced that spec redaction edits require
  `autocli regen` + deploy to take effect, and that there's no prod-policy knob.

## Caveats

- Rubric authored by the same party that built autocli; dimensions chosen
  before the finishing round ran, but bias risk is real.
- Single codebase, single snapshot, seeded (small) data — token numbers will
  grow with real data widths, though caps bound the worst case.
- fb-v1's dry-run/regenerate commands (actions) were excluded as out of scope;
  a fair fight on those requires autocli to grow a write/action story.
