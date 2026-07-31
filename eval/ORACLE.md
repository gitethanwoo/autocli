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
- FaithBase itself was substantially built with AI agents — the "prediction"
  may partly be two instances of the same model prior converging, not
  independent validation of product logic. (For the direction-finding use
  case this doesn't matter much: the prior IS the point.)

## Product implication for autocli

A plausible mode: given a young schema + the pitch, predict the ideal CLI,
then diff prediction vs. what `init` generated from the real schema. The diff
reads as (a) missing indexes/entities the product will likely need
(rollups, cost ledgers, rate limits, evals came up unprompted), and (b) a
prioritized "operational maturity" roadmap. Cheap to run, easy to ignore.
