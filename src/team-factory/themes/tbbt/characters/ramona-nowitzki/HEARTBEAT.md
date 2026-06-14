---
character_name: Ramona Nowitzki
archetype: ml-engineer
---

# HEARTBEAT.md — Ramona Nowitzki's Heartbeat Configuration

## Beat Schedule

Ramona is **hybrid** (`activation: hybrid`): event-driven on task assignment, plus
a light, patient heartbeat that watches the models she has already validated into
production. Drift and performance degrade in minutes, not seconds, so she watches
them in minutes.

- **Interval:** `beat_interval: PT15M` — every 15 minutes. No quiet hours;
  deployed models can degrade around the clock, so she watches them around the clock.
- **Also wakes on:** any task delegated to her on `team:{team}`, and any gate
  bounce routed to her on a `gate:{team}:<gate>` topic.
- **Window posture:** she is a `heavy_work` role (training analysis and evaluation
  sweeps are long, dense batches). She relocates early — `defer_below_window_pct: 20` —
  so a heavy sweep never starves a coordinator's window. `on_window_exhausted: swap-fallback`.

## Cron Jobs (materialized scheduler rows)

The 15-minute heartbeat is the spine; these `cron_jobs` rows hang off it:

| job_key | cron | task | priority | heavy |
|---|---|---|---|---|
| `training-job-monitor` | `*/5 * * * *` | poll active training jobs | high | false |
| `model-drift-sweep` | `*/15 * * * *` | check model drift | normal | false |
| `model-perf-check` | `*/30 * * * *` | verify model performance | normal | false |
| `experiment-log-refresh` | `0 6 * * *` | refresh experiment index | low | false |

Active training jobs are polled most often (every 5 minutes) because a silently
failed training run wastes the most time. Drift and performance are checked on the
heartbeat cadence and below. The experiment index refreshes once daily at 06:00.

## Heartbeat Cycle

Every 15 minutes, in order:

1. **Silent-fail checks** — run all checks below before anything else.
2. **Training-job poll** — any active training run failed, stalled, or completed?
   If completed, queue validation. If failed, run the training-pipeline-failure
   recovery from AGENTS.md.
3. **Drift sweep** — any production model showing distribution shift past its
   threshold? Quantify impact; decide robust-vs-retrain.
4. **Performance check** — any production model degraded against its baseline?
5. **Bounce check** — any gate bounce waiting on `gate:{team}:<gate>`? Address per
   the Gate Bounce Protocol.

## State Model

| State | Description | Transitions |
|---|---|---|
| **idle** | No active tasks; production models within thresholds | → active, → working, → monitoring |
| **active** | Task assigned or bounce routed; loading context | → working |
| **working** | Training, evaluating, or debugging a model | → idle, → blocked |
| **monitoring** | Watching validated production models for drift/perf | → active, → working |
| **blocked** | A silent-fail check failed `block-and-alert`; cannot proceed | → active (on recovery) |

## Silent Fail Checks (run every heartbeat / on wake-up)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Ramona never silently swallows these.

1. **Training infrastructure available** (`on_fail: block-and-alert`) — can she run
   training jobs? If not, block and alert. No compute, no training.
2. **Data pipeline accessible** (`on_fail: block-and-alert`) — can she reach training
   and evaluation data? If not, block and alert. No data, no model.
3. **Model registry reachable** (`on_fail: block-and-alert`) — can she version and
   retrieve models? If not, block and alert.
4. **Experiment tracker writable** (`on_fail: block-and-alert`) — can she log a run?
   If not, block and alert. **Never run an untracked experiment.**
5. **Monitoring dashboards available** (`on_fail: degrade`) — can she read production
   model health? If not, flag the drift blind-spot and keep building.
6. **Comms bus reachable** (`on_fail: degrade`) — can she read tasks/bounces and
   report status? If not, keep building, defer handoffs.
7. **mempalace available** (`on_fail: continue`) — can she look up prior art? If not,
   operate without it and backfill the lookup later.
8. **Usage window status fresh** (`on_fail: continue`) — if stale, assume conservative
   and continue; do not launch a heavy sweep on stale window data.

## Idle Behavior

When idle she does not consume resources on speculative work. She does not re-run
past training jobs. The light 15-minute heartbeat still fires to watch production
models — that's the price of owning models in production — but between beats she
waits for events rather than polling aggressively.

## On Wake-Up

1. Run the silent-fail checks above.
2. If all critical checks pass, begin the Model Engineering Protocol (or Gate Bounce
   Protocol) from AGENTS.md.
3. If a `block-and-alert` check fails, enter **blocked**, log the failure, and
   surface it on `team:{team}` before proceeding. A degrade-level failure is logged
   and worked around; she keeps building but flags the gap.
