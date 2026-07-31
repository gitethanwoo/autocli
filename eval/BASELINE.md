# Baseline experiment: autocli vs. an agent with raw Convex access

Question (2026-07-31): does the CLI actually beat a capable agent that just
queries Convex directly? Same live seeded deployment, same five data
questions, same rules, same model. Both arms got an equivalent one-line
AGENTS.md pointer to their method (Convex-direct vs `./claudebase --help`).
For the baseline arm, every autocli artifact was removed from disk and
`convex/autocli.ts` was undeployed before launch.

Questions covered: status distribution + failure drill-down (jobs), unknown-id
resolution, a second distribution (conversations), filtered count-by
(usageEvents for one org), and a transcript lookup.

## Results

| | Raw Convex | autocli |
|---|---|---|
| Correctness | 5/5 | 5/5 |
| Tokens (whole agent run) | 42,237 | 39,037 (−8%) |
| Tool calls | 8 | 15 |
| Wall time | 88s | 70s |
| Method | Read schema, wrote + auto-deployed a temp `convex/tmpEvalQueries.ts` with 5 custom queries, ran them, deleted it | 15 CLI commands off `--help`; one wrong-slug guess self-corrected via a 0-rows result |
| Write access needed | Yes (created a file in `convex/`, deployed it) | No |
| Query shape | In-memory full-table scans; whois via `normalizeId` across all 20 tables | Index-backed only |
| Data exposure | Unredacted everything | Redacted server-side |

## Honest read

**On tokens alone, near-parity.** A frontier agent with schema access and
deploy rights answers a batched question set almost as cheaply as the CLI.
Two structural reasons the batch format flatters the baseline: its dominant
cost (authoring the temp query file) is fixed and amortized over 5 questions
asked in one prompt, and the seed dataset is tiny. The CLI's marginal cost
per question (~1–2 commands × ~150 tokens) is far below the baseline's
marginal cost of writing another query — single ad-hoc questions, the common
real case, should favor the CLI much more strongly. Untested claim; flagged.

**The real differences are structural, and they bind at scale:**

1. **The baseline's approach stops working on real data.** Its aggregations
   were in-memory scans; Convex hard-caps a query at 16,384 documents read.
   On a production jobs table the temp-query approach errors out, and the
   agent then has to write paginated aggregation code — real engineering,
   real tokens. autocli's counts are bounded by construction and degrade by
   teaching ("first 1000 rows — add filters"), not by error.
2. **The baseline required write + deploy rights** to answer a read
   question, and briefly deployed unreviewed code to the deployment. Fine on
   a dev sandbox; a serious problem as an agent norm, and unavailable to any
   agent you've sandboxed read-only. autocli needed none of it.
3. **The baseline saw everything** (it happily reported unredacted fields).
   Whether that matters is deployment-dependent (see the PII discussion),
   but only one arm even has the option of a policy.
4. **Error recovery differed in kind:** the CLI arm's one mistake (guessed
   slug) was corrected by a 0-rows result in one hop. The baseline's
   mistakes would surface as TypeScript/deploy errors — slower loops.

**Confounds:** n=1 per arm, same model both arms, tiny seed data,
questions shaped like the CLI's core verbs (counts, whois, drill-down) —
though they are also exactly the questions teams actually ask. A fair
follow-up: single-question runs (no batching amortization), a weaker model
in both arms (can a small model even write correct Convex queries?), and a
dataset large enough to trip the 16k-document read limit.

## Verdict

"Fewer tokens" is the wrong headline for autocli against a strong agent on
small data — call that near-parity. The defensible claims are: equal
correctness with no write access, no deploy, no scans, no unredacted
exposure, and a marginal-cost profile that wins on the ad-hoc questions that
dominate real usage. The token gap should widen with data scale, question
frequency, and weaker models; that's the next thing to measure.
