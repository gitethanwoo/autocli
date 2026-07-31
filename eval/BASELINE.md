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

## Round 2: 60k rows, exactness demanded

Seeded the deployment to 60,003 conversations (realistic customer scale) and
asked both arms for an exact status distribution, an exact filtered
time-bounded count, and a newest-failed drill-down.

| | Raw Convex | autocli (pre-fix) |
|---|---|---|
| Correctness | 3/3 exact | 3/3 exact |
| Tokens | 42,104 | 46,428 |
| Tool calls | 12 | 22 |
| Wall time | 3.5 min | 4.6 min |
| Temp code deployed | yes (add + cleanup) | yes (add + cleanup) |

**Both arms converged on writing temp paginated-aggregation code**, because a
single Convex query cannot scan a 60k table and the CLI's counts capped at a
1,000-row sample. The CLI arm cost *more* — it paid for CLI exploration and
then did the same engineering, plus cross-verification. On production (no
auto-pushing dev process) the temp-code maneuver means **two deploys of
untested code to answer a read-only question** — operationally disqualifying,
which makes the missing CLI primitive the whole ballgame.

Two fixes came straight out of this round:

1. **`count --exact`** — the CLI drives the generated `countPage` function in
   a cursor loop; every query reads one bounded page (index-backed,
   read-only), aggregation happens client-side. The 60k distribution is now
   one command: exact 51,001/6,001/3,001 in 61 bounded queries, ~80 output
   tokens, 49s, zero deploys. The filtered count (3,113) took 4 queries. This
   is the "one-shot aggregate fetch" pattern Convex's own performance-audit
   skill recommends over reactive global counts.
2. **Half-open time windows** — the CLI arm's windowed cross-check
   double-counted a boundary row because `--until` was inclusive. Ranges are
   now `[since, until)`, so windowed sums compose.

Post-fix, the scale questions stop being an engineering task at all; the
remaining honest caveat is wall-time (a cursor loop pays ~0.7s of `convex run`
process overhead per page) and a 1,000-page safety cap that reports itself.

Checked against Convex's official agent skills (get-convex/agent-skills)
afterward: their guidance — "only withIndex/withSearchIndex actually reduce
documents scanned," read amplification as a first-class problem, prefer
one-shot aggregates or precomputed summary rows over reactive global counts —
matches autocli's construction. Their "precomputed summary rows" advice is
also exactly what FaithBase later built (`orgUsageDaily`, rollups), and what
the oracle predicted. A future adapter could detect the official
@convex-dev/aggregate component and use O(log n) counts when installed.

## Verdict

"Fewer tokens" is the wrong headline for autocli against a strong agent on
small data — call that near-parity. At scale the pre-fix rounds showed the
real fault line: whoever lacks a bounded aggregation primitive ends up
deploying untested code to answer read-only questions. With `count --exact`,
autocli answers the same questions in one command with zero deploys — the
defensible claims are equal correctness with no write access, no deploy, no
scans, no unredacted exposure, and a marginal cost per question of a few
hundred tokens. Remaining unmeasured: weaker-model arms and single-question
(non-batched) runs.
