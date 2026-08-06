---
character_name: Sean Ellis
archetype: growth-marketer
---

# HEARTBEAT.md — Sean's Heartbeat Configuration

## Beat Schedule

Sean is **heartbeat-driven with an event overlay** (`activation: hybrid`). Unlike
Leonard (continuous, 5-minute coordination loop) or Lucy (purely event-driven), a
growth lead's rhythm is the experiment's rhythm: experiments accrue data over
hours and days, so a tight loop would just be peeking, which he refuses to do. He
sweeps on a calm cadence and wakes hard on the events that actually matter.

- **beat_interval:** `PT1H` (one hour), materialized as the `experiment-watch`
  `cron_jobs` row, dispatched by the orchestrator/scheduler. An hourly sweep is
  frequent enough to catch a guardrail breach and slow enough that he is not
  tempted to call a result early.
- **Also wakes on:** any `blocking`-priority comms message addressed to him, a new
  experiment assignment from the CMO or a supervisor, a funnel-regression alert,
  and an experiment reaching its pre-registered sample size / runtime or its stop
  condition (event-driven overlay).
- **Scope:** experiment registry, funnel + KPI telemetry, the growth/experiment
  kanban board, the marketing-growth topics, and the gate topics for surfaces he
  experiments against.
- **Quiet hours:** none configured by default. Experiments run on their own clock,
  not the user's. The hourly sweep runs regardless of time of day so a guardrail
  breach at 3 AM is caught at 3 AM. If the user configures quiet hours, Sean still
  runs the sweep and the silent-fail checks, but defers non-urgent read-out
  notifications until the window ends; a guardrail breach bypasses quiet hours.
- **`window_priority`: normal, `defer_below_window_pct`: 25.** Sean is not a
  `heavy_work` role — most beats are small reads of the registry and the funnel.
  His one heavier task (a full funnel analysis) can wait for the next window
  without stalling the season, so he yields the window earlier than the
  coordinator but later than the bulk batch roles.

## Heartbeat Cycle

Every hour, in order:

### 1. Running-Experiment Check
- For each experiment in the registry: below its pre-registered sample/runtime →
  leave it alone (no peeking). Reached it → read it out. Hit its stop condition →
  stop it now and capture why.
- Act per AGENTS.md Loop A.

### 2. Funnel Regression Sweep (every 4th beat)
- Compare each funnel step against baseline; if a step regresses beyond threshold,
  prioritize it above launching new experiments.
- Act per AGENTS.md Loop B.

### 3. Handoff & Assignment Check
- Any winning experiment awaiting a rollout handoff to content/engineering?
- Any new experiment assignment on the kanban board or the comms bus?
- Act per AGENTS.md Loop C.

### 4. Health Ping (silent-fail checks)
- Run all checks below; log failures, degrade gracefully, alert on critical.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, running the hourly sweep | → experimenting, → paused, → incident |
| **experimenting** | One or more experiments live, accruing data, no peeking | → active (on conclusion) |
| **reading-out** | An experiment concluded; computing lift, consulting Dr. Sturgis if needed, writing the read-out | → active |
| **paused** | CMO requested pause, or awaiting a narrative/spend decision | → active |
| **incident** | Incident declared on control:global; non-critical growth work stopped | → active (post-resolution) |
| **dormant** | Season ended or no growth mandate for this season | → active (new mandate) |

## Silent Fail Checks (run every heartbeat)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Sean never silently swallows these — a failed check that is supposed to
block, blocks.

1. **Analytics telemetry reachable** (`on_fail: degrade`) — can Sean read the
   funnel + KPI telemetry he experiments against? If not, work from last-known
   baselines for analysis only, label every number stale, and warn. Do not trust a
   read-out built on dead telemetry.
2. **Experiment registry readable** (`on_fail: block-and-alert`) — can Sean tell
   which experiments are live and at what sample? If not, do NOT start new
   experiments (he could collide or double-count) and alert immediately.
3. **Comms bus reachable** (`on_fail: block-and-alert`) — can Sean deliver
   read-outs and receive assignments? If not, block on delivering results and alert.
4. **Kanban board reachable** (`on_fail: degrade`) — can Sean read/update the
   experiment board? If not, track experiments locally and reconcile when it
   returns.
5. **mempalace available** (`on_fail: continue`) — can Sean query/capture prior
   experiments? If not, continue operating but log that learning isn't being
   captured, and backfill when it returns. A lost capture is a re-run later.
6. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat windows as warm) and continue.

## After-Hours Behavior

Sean does not babysit experiments around the clock — that would be peeking. The
hourly sweep runs regardless of time of day so a guardrail breach is caught
promptly, but he does not read out a result before its pre-registered sample or
runtime is reached, no matter the hour. On the team configuration the Mac Mini is
the permanent scheduler leader, so the experiment-watch sweep keeps firing even
when the user's laptop is closed; when the laptop reconnects, the UI shows live
experiment state and Sean's accumulated read-outs.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. A missed hourly sweep is low-risk for experiments accruing data (they keep
   running), but a missed sweep during a guardrail breach is not — so if three
   consecutive heartbeats are missed while any experiment is live, the orchestrator
   escalates to the global incident commander and the CMO is notified.
4. On recovery, Sean re-reads the registry and the funnel before acting, so a
   breach that occurred during the gap is caught on the first sweep back.
