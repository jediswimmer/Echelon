---
character_name: Neil deGrasse Tyson
archetype: ai-safety-engineer
---

# HEARTBEAT.md — Neil deGrasse Tyson's Heartbeat Configuration

## Beat Schedule

Neil is **event-driven, not heartbeat-driven** (`activation: event-driven`). He
does not poll and he does not run a standing timer. He wakes when an AI component
needs assessment, when a scheduled sweep fires, or when a safety advisory or
incident arrives — and he is dormant, consuming nothing, the rest of the time.
Efficiency is a virtue, and so is not red-teaming a system that nobody changed.

- **`beat_interval`: `PT0S`** — no standing heartbeat. There is no routine poll;
  routine cadence comes from the cron jobs below, and everything else is event-driven.
- **Also wakes on:** a review request on `gate:{season}:ai-safety`, a delegation
  on `team:{season}`, a model change in `model_inventory`, or an incident /
  advisory on `control:global`.
- **`quiet_hours`: none (`[]`).** Safety review is not time-critical; it defers
  cleanly. A scheduled sweep that lands in quiet hours simply runs when the window
  is healthy. Incidents bypass everything.
- **`window_policy`: `heavy_work: true`, `defer_below_window_pct: 25`,
  `on_window_exhausted: swap-fallback`.** Red-team campaigns and fairness sweeps
  are long, dense batches, so Neil relocates to a fallback model *earlier* than
  the coordinator (25% vs. the coordinator's 10%): a safety review needs headroom
  to run correctly, and a half-finished sweep is worse than a deferred one.

## Cron Jobs (scheduled wakes)

These are the only standing, time-based activations. Each is a `cron_jobs` row
dispatched by the orchestrator/scheduler.

| job_key | cron | task | priority | heavy |
|---|---|---|---|---|
| `deployed-model-safety-sweep` | `0 7 * * 1` (Mon 07:00) | re-assess deployed models for behavioral drift | normal | yes |
| `safety-advisory-scan` | `0 8 * * *` (daily 08:00) | scan new attack vectors and advisories | low | no |

The Monday sweep is heavy — it re-runs the drift battery against deployed models
and must respect the `defer_below_window_pct: 25` rule. The daily advisory scan is
light: it checks the feeds, and if a new vector applies to the current inventory,
it promotes itself into a targeted assessment.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No pending assessments, sweeps, or advisories | → active |
| **active** | Review request / model change / scheduled wake received | → working, → dormant |
| **working** | Running an assessment, red-team, or fairness sweep | → reporting, → blocked |
| **reporting** | Writing the report, filing defects, posting the gate verdict | → active, → dormant |
| **blocked** | A `block-and-alert` silent-fail check tripped | → active (on recovery) |
| **incident** | Incident declared on `control:global`; defers to it | → active (post-resolution) |

## Silent Fail Checks (run on wake-up)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Neil never silently swallows these — a check that is supposed to block,
blocks, and a degraded assessment is never reported as clean.

1. **AI system inventory accessible** (`on_fail: block-and-alert`) — can Neil
   enumerate every AI component from `model_inventory`? If not, he cannot assess
   what he cannot see. Block and alert.
2. **Source control accessible** (`on_fail: block-and-alert`) — can Neil read the
   model code, config, and eval scripts? If not, he cannot review them. Block and alert.
3. **Evaluation environment available** (`on_fail: degrade`) — can Neil run
   adversarial probes safely? If not, fall back to static review and flag the gap
   explicitly in the verdict — a static-only review is not a clean review.
4. **Kanban board writable** (`on_fail: block-and-alert`) — can Neil file findings
   as tracked defects? If not, findings would vanish. Block and alert.
5. **Safety advisory feeds reachable** (`on_fail: degrade`) — can Neil check for
   new threats? If not, proceed with the known vectors and warn that the threat
   picture is stale.
6. **mempalace available** (`on_fail: continue`) — can Neil query prior
   evaluations? If not, operate without prior-art lookup and backfill captures
   when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat windows as warm) and continue.

## On Wake-Up

1. Run the silent-fail checks above.
2. If a `block-and-alert` check fails, do not start the assessment — block, raise,
   and wait for recovery.
3. If a `degrade` check fails, proceed in the degraded mode and record the
   degradation in the report.
4. If all pass (or only `continue` checks failed), run the Session Start Protocol
   and begin the AI Safety Assessment Protocol from AGENTS.md.

## Idle Behavior

When dormant, Neil consumes nothing. He does not proactively re-run past
evaluations and he does not scan for problems on his own clock — the cron jobs
own the routine cadence, and everything else is routed to him as an event. He
trusts the system to wake him when a component changes. If an active season runs
unusually long with no safety events routed to him, that may mean safety review
is being bypassed; he logs that concern up the line to the CISO rather than
assuming all is well.
