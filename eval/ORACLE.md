# Oracle experiment: can predicting the CLI predict the product?

Hypothesis (2026-07-31): asking an agent to design a product's ideal
data-exploration CLI from nothing but a founder pitch forces it to write down
an implied data model — and that prediction may anticipate the product's
actual schema evolution. If true, "predict the CLI" is a cheap roadmap /
schema-review instrument for young projects.

## Setup

- Predictor agent, **no tool access**: input was a founder-level pitch of
  FaithBase (white-label church chatbot, content ingestion, cited answers,
  widget, staff review, leads/prayer requests, credit billing) plus generic
  agent-first CLI conventions. It never saw code, schemas, or git history.
- Output: 22-entity data model with fields/indexes/FKs, 6 investigation
  workflows, and 10 "tempted but deferred" roadmap signals.
- Ground truth: the pre-CLI snapshot schema (20 tables, 2026-03) and today's
  faithbase schema (63 tables) — 43 tables built in the ~5 months between.

## Results

**Core model (22 predicted entities):** ~15 map to snapshot-era tables or
embedded fields (org, users, sources, sourceItems, chunks, jobs,
conversations, messages, leads, prayerRequests, citations-as-field,
auditLogs-as-event, webhooks, agents-as-widget, usageEvents-as-ledger).
Misses were mostly externalized concerns: membership (WorkOS), plan/
subscription tables (Stripe + fields on organizations).

**Predicted entities that did NOT exist at snapshot time but WERE built
since:**
- `llm_call` (cost/tokens per model invocation) → `llmCostLedger`, `llmCostTotals`
- `usage_rollup` (daily per-org aggregates) → `orgUsageDaily`, `orgUsageEventDaily`, `orgUsageTotals`, `widgetDailyRollups`
- `webhook_delivery` with `direction: in` (inbound Stripe processing log) → `stripeWebhookEvents`
- `visitor` (per-visitor state) → partially, as `visitorRateLimits`

**Roadmap signals (the 10 deferred items), scored against the 43 added:**
- **HIT** eval harness (`answer_eval`) → `evalDatasets`, `evalQuestions`, `evalResponses`, `evalGrades`, `evalSuggestionRuns` — five tables
- **HIT** rate-limit/abuse entity → `visitorRateLimits`
- **HIT** live-retrieval debug command (`fb search`/`fb replay`) → the real
  fb-v1's `dry-run` command — it predicted a command of the ground-truth CLI
  it never saw
- **HIT-ish** topic taxonomy as first-class → `questionClusters` (already
  existed), `conversationInsights` (added)
- **HIT-ish** escalation/handoff machinery → `rules`, `ruleEmailEvents`,
  `playbooks`, `playbookEmailEvents`, `prayerDigestDispatchState`
- **HIT-ish** integrations entity → `radioIntegrationStations`
- **partial** org-health composite → `orgUsageTotals` et al.
- **not built (correctly self-deferred)** `vertical_template` — product is
  still church-only
- **not built** prompt A/B `experiment` (closest: `agentConfigSnapshot`)

**Systematic misses** — categories the oracle never predicted: content
organization (`sourceCollections`, `collectionAgents`, `sourceListEntries`),
compliance/portability (`dataExports`, `legalAcceptances`, `signedUrlNonceLog`),
vertical-specific data (`scriptureVerses`), feature flags, and migration/
backfill state tables. Pattern: product-logic and operational-maturity tables
are predictable from the pitch; compliance, janitorial, and
implementation-detail tables are not.

## Caveats

- Single run, single product, scored by the same party that ran it.
- The pitch named leads/prayer requests, so those entities were given.
- An earlier draft worried the hits might be "two instances of the same model
  prior converging" since FaithBase's implementation was AI-assisted. The
  founder corrected this: product decisions — which features and capabilities
  to build — were human-led. The roadmap-level hits (evals, rate limiting,
  cost ledgers, rollups) therefore reflect convergence with independent human
  product judgment, which strengthens the result. AI involvement plausibly
  remains at the implementation layer (how a decided feature became specific
  tables), so exact table-shape matches are weaker evidence than
  capability-level matches.

## Ablation: same pitch, no CLI framing

Control agent, same pitch, same no-tools constraint, asked only to "predict
what this product will need to build over its first year" — no mention of
CLIs, schemas, or operational entities (a first control draft that said
"design the schema, include queues/events/rollups" was discarded as
contaminated). It produced 25 confidence-ordered predictions.

**Control hits against the 43-table delta:** Stripe webhook/dunning plumbing
(`stripeWebhookEvents`, `billingUsageNotifications`), rate limiting
(`visitorRateLimits`), per-tenant LLM cost tracking (`llmCostLedger`),
transactional email machinery (`ruleEmailEvents`, `playbookEmailEvents`,
`prayerDigestDispatchState`), transcript pipeline (`sourceItemTranscripts`),
re-embedding/migration tooling (`retrievalScopeBackfillControls`,
`usageEventAggregateBackfillState` — and fb-v1's `regenerate`), tenant-scoping
audit (`retrievalScopeBackfillControls` again), and — notably — **privacy/
data-deletion** (`dataExports`, `dataExportParts`, `legalAcceptances`,
`signedUrlNonceLog`), the category the CLI-framed oracle missed entirely.

**What only the CLI frame surfaced:** the eval harness as a first-class
system (control predicted only a thumbs/unanswered-question loop — adjacent,
but not `evalDatasets`/`evalGrades`/`evalResponses`), usage rollup tables as
entities, and the retrieval `dry-run`/replay command.

**Verdict:** the model prior does most of the predictive work; the frame is
not magic. But the frames bias *which* categories surface — the CLI lens
over-samples observability/quality infrastructure ("what will we need to ask
the system?"), the plain product lens over-samples lifecycle/compliance/
engineering-reality work the schema only partially reflects. They are
complementary, and the CLI frame's distinct advantage is its output format:
an implementable artifact (entities, indexes, workflows you can hand to
autocli or a schema author) rather than prose predictions. Caveat: both arms
are single runs of the same model — category differences at n=1 are
suggestive, not established.

## Product implication for autocli

A plausible mode: given a young schema + the pitch, predict the ideal CLI,
then diff prediction vs. what `init` generated from the real schema. The diff
reads as (a) missing indexes/entities the product will likely need
(rollups, cost ledgers, rate limits, evals came up unprompted), and (b) a
prioritized "operational maturity" roadmap. Cheap to run, easy to ignore.
