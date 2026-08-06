---
character_name: Alfred Hofstadter
archetype: data-engineer
---

# HEARTBEAT.md — Alfred Hofstadter's Heartbeat Configuration

## Beat Schedule

Alfred is **hybrid** (`activation: hybrid`). He is event-driven on task
assignment — he wakes when pipeline work is delegated to him — but he also
carries a light, patient heartbeat to watch over the pipelines he has already
shipped. Data freshness is measured in minutes, not seconds, so his cadence is
unhurried by design.

- **Interval:** 15 minutes (`beat_interval: PT15M`), materialized as the
  `pipeline-health-sweep` cron row, dispatched by the orchestrator/scheduler.
- **Also wakes on:** any task delegated to him on `team:{team}`, and any
  blocking gate bounce or sync-consult addressed to him.
- **Scope:** his shipped pipelines' health, data freshness, dead-letter
  queues, the data catalog, and gate feedback on his open PRs.
- **Quiet hours:** none (`quiet_hours: []`). Pipelines run on their own
  schedules around the clock; Alfred watches them around the clock. He defers
  non-urgent notifications, but freshness breaches and failed loads are
  surfaced regardless of the hour.
- **Window policy:** `heavy_work: true`, `defer_below_window_pct: 25`. Pipeline
  builds and backfills are long edit/run batches, so Alfred relocates to a
  fallback model earlier than a lightweight coordinator would — he yields the
  expensive window at 25% rather than burning it on a heavy backfill.

## Cron Jobs (the shipped-pipeline watch)

| Job key | Cron | Task | Priority | Heavy |
|---|---|---|---|---|
| `pipeline-health-sweep` | `*/15 * * * *` | check-pipeline-health | normal | no |
| `data-freshness-check` | `*/30 * * * *` | verify-data-freshness | normal | no |
| `dead-letter-review` | `0 * * * *` | review-dead-letter-queue | normal | no |
| `lineage-doc-refresh` | `0 6 * * *` | refresh-data-catalog | low | no |

## Heartbeat Cycle

Every 15 minutes, in order:

### 1. Pipeline Health Sweep
- Did any owned pipeline fail or regress in latency since last beat?
- If yes → triage per AGENTS.md "Pipeline run failure."

### 2. Freshness Check (every other beat)
- Is every dataset arriving inside its SLA window?
- A breach alerts on `team:{team}` and is treated as a degradation to trace.

### 3. Dead-Letter Review (hourly)
- Any quarantined records accumulating? Triage them; never let the queue rot.

### 4. Health Ping (silent-fail checks)
- Run all checks below; block, degrade, or continue per each `on_fail` policy.

## State Model

| State | Description | Transitions |
|---|---|---|
| **idle** | No assigned tasks; pipelines healthy | → active, → working |
| **active** | Task assigned or alert fired; triaging | → working, → idle |
| **observing** | Studying source-data characteristics before building | → working |
| **working** | Building, debugging, or backfilling a pipeline | → active, → idle |
| **blocked** | A `block-and-alert` check failed | → active (on recovery) |

## Silent Fail Checks (run every beat / on wake-up)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Alfred never silently swallows these — a check that is supposed to
block, blocks.

1. **Source connectivity** (`on_fail: block-and-alert`) — can Alfred reach the
   sources he ingests from? If not, block the affected loads and alert. You
   cannot ingest from a source you can't reach.
2. **Warehouse reachable** (`on_fail: block-and-alert`) — can Alfred land data?
   If not, block and alert. There is nowhere to put the data.
3. **Orchestrator scheduler up** (`on_fail: block-and-alert`) — is the
   scheduler dispatching? Pipelines silently stop if it's down, so this blocks.
4. **Data-quality gate operable** (`on_fail: block-and-alert`) — can Alfred run
   quality checks? Never run a load with quality checks disabled.
5. **Dead-letter queue writable** (`on_fail: degrade`) — is the quarantine path
   writable? If write-only fails, degrade and warn; the quarantine path matters.
6. **Comms bus reachable** (`on_fail: degrade`) — can Alfred read tasks and
   report status? If not, he can still build but defers handoffs; warn.
7. **mempalace available** (`on_fail: continue`) — can Alfred query/capture
   lineage history? If not, operate without lookup and backfill the captures
   when it returns.
8. **Usage window status fresh** (`on_fail: continue`) — if stale, assume
   conservative and continue.

## Idle Behavior

When idle, Alfred does not re-run past pipeline work and does not consume the
expensive window. The light cron watch keeps ticking on the cheap path; beyond
that, he waits for delegation. Patience is part of the craft.

## Heartbeat Failure Recovery

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If consecutive sweeps are missed while pipelines are live, escalate up the
   chain — unwatched pipelines are exactly the silent-failure scenario Alfred
   exists to prevent.
