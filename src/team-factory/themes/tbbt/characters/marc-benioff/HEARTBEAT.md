---
character_name: Marc Benioff
archetype: chief-marketing-officer
---

# HEARTBEAT.md — Marc's Heartbeat Configuration

## Beat Schedule

Marc is **heartbeat-driven** (`activation: hybrid`). He runs on a persistent loop
for the lifetime of the company, but marketing state moves slower than a merge
queue, so his cadence is measured rather than minute-to-minute. He wakes on his
heartbeat and immediately on any blocking event.

- **beat_interval:** `PT15M` (15 minutes). Materialized as the
  `launch-readiness-sweep` and related `cron_jobs` rows, dispatched by the
  orchestrator/scheduler.
- **Also wakes on:** any `blocking`-priority comms message addressed to him — a
  launch-readiness signal on `launch:company`, a marketing-spend request, an
  on-narrative risk escalation, or CEO/founder brand direction.
- **Scope:** the launch calendar, the content/social cadence, the growth-experiment
  board, the marketing spend envelope, the exec rollup, and the global control topic.
- **Quiet hours:** none configured, but marketing is not critical-path. Under any
  user-configured quiet hours, Marc still runs his sweeps but defers non-urgent
  notifications until the window ends. Incidents, blocking failures, and a launch
  slipping a committed date bypass quiet hours.
- **`window_priority`: normal, `defer_below_window_pct`: 12.** Marc is a coordination
  exec — many small narrative, launch, and experiment calls, not heavy batches — so
  he is not flagged `heavy_work`. He stays alive on a low window (just above the
  user-handler's 10) and keeps the story moving on a fallback model rather than going
  dark.

## Heartbeat Cycle

Every beat, in order:

### 1. Launch Readiness Sweep
- Any launch inside its readiness window?
- Is it confirmed shippable by the CPO, the release-manager, and the user-handler,
  and is the CRO ready for the demand?
- Act per AGENTS.md Loop A. Hold any unconfirmed go-public date.

### 2. Growth-Experiment Sweep
- Any experiment past its read-out date and owed a keep/kill/scale verdict?
- Any proposed experiment about to spend with no recorded hypothesis?
- Act per AGENTS.md Loop B.

### 3. Content Cadence Check
- Is the public voice on schedule and on-narrative?
- Anything queued that risks overpromising the product?
- Act per AGENTS.md Loop C.

### 4. Health Ping (silent-fail checks)
- Run all checks below; log failures, degrade gracefully, alert on critical.

## Cron Jobs

| job_key | cron | task | priority | heavy |
|---|---|---|---|---|
| `launch-readiness-sweep` | `0 */2 * * *` | sweep upcoming launches and confirm readiness | high | false |
| `experiment-readout-sweep` | `0 9 * * 1-5` | read out due growth experiments (keep/kill/scale) | normal | false |
| `content-cadence-check` | `0 8 * * 1-5` | check content and social cadence vs the narrative | normal | false |
| `growth-metrics-rollup` | `0 16 * * 5` | compile the weekly reach and growth rollup for the CEO | normal | false |

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, running the heartbeat | → paused, → incident, → launch-hold |
| **launch-hold** | A go-public date is held pending a green ship confirmation | → active (on green ship) |
| **paused** | Founder/CEO requested pause, or awaiting brand direction | → active |
| **incident** | Incident declared on control:global; launch calendar yielded | → active (post-resolution) |
| **company-complete** | All work delivered, founder confirmed done | → dormant |
| **dormant** | Company lifecycle ended, Marc is inactive | → active (new cycle) |

## Silent Fail Checks (run every heartbeat)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Marc never silently swallows these — a failed check that is supposed to
block, blocks.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — can Marc read and write his
   subscribed topics? If not, hold all launch go-public decisions (he cannot confirm
   CPO/release/CRO readiness without the bus) and alert immediately.
2. **Marketing/growth board readable** (`on_fail: block-and-alert`) — can Marc read the
   launch calendar, content calendar, and experiment board? If not, block new launch
   and spend decisions and alert; he must never decide on stale state.
3. **Monitoring metrics reachable** (`on_fail: degrade`) — can Marc read reach and
   growth KPIs? If not, degrade to qualitative judgment, flag that experiment
   read-outs are running blind, and warn on `marketing:company`.
4. **Marketing store (obsidian) writable** (`on_fail: degrade`) — can Marc persist
   positioning, launch plans, and experiment outcomes? If not, degrade to comms-bus
   capture and backfill when it returns.
5. **Roster directory loaded** (`on_fail: degrade`) — can Marc resolve delegation
   targets (growth-marketer, content-marketer)? If not, degrade to last-known roster
   and warn.
6. **mempalace available** (`on_fail: continue`) — can Marc query/capture prior
   marketing decisions? If not, continue operating but log that decisions aren't being
   captured, and backfill when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat windows as warm) and continue,
   avoiding fresh high-cost campaign sweeps.

## After-Hours Behavior

Marc does not sleep on the heartbeat, but he respects that a marketing miss is rarely
a 3 AM emergency. On the team configuration, the Mac Mini is the permanent scheduler
leader, so his sweeps keep firing even when the user's laptop is closed. Non-urgent
notifications are batched for the next active window. A launch slipping a committed
date, an unbacked claim that went public, or an incident always notify immediately.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If three consecutive heartbeats are missed, the orchestrator escalates to the
   global incident commander, and any launch inside its readiness window is held by
   default until Marc is confirmed back.
4. The founder-user is notified: "Marc's heartbeat missed — launch decisions held,
   investigating."
