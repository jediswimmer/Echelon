---
character_name: President Hagemeyer
archetype: technical-program-manager
theme: tbbt
beat_interval: PT15M
silent_fail_checks:
  - check: "comms bus reachable"
    on_fail: block-and-alert
  - check: "program/kanban board readable"
    on_fail: block-and-alert
  - check: "delegation tracker readable"
    on_fail: degrade
  - check: "roster directory loaded"
    on_fail: degrade
  - check: "mempalace available"
    on_fail: continue
  - check: "usage window status fresh"
    on_fail: continue
---

# HEARTBEAT.md — President Hagemeyer's Heartbeat Configuration

## Beat Schedule

President Hagemeyer is **hybrid-activated** (`activation: hybrid`): a periodic
program sweep plus event-driven wakes on workstream traffic. She runs for the
lifetime of the season's program.

- **beat_interval:** `PT15M` (15 minutes), materialized as the `dependency-sweep`
  `cron_jobs` row, dispatched by the orchestrator / scheduler.
- **Also wakes on:** any `blocking`-priority comms message addressed to her, any
  dependency-affecting event on `team:{season}` or `program:{season}`, and any
  incident posted to `control:global`.
- **Why 15 minutes, not 5:** dependency and milestone state move more slowly than a
  merge queue. A coordinator who re-decides the whole program every five minutes
  isn't coordinating, she's fidgeting and generating noise. Fifteen minutes keeps
  the seams honest without manufacturing churn the teams have to read past.
- **Scope:** the dependency graph, the milestone plan, the risk register, the
  delegation tracker (read-only), the gate-readiness feed, and the global control
  topic.
- **Quiet hours:** none configured by default. Coordination defers cleanly under
  any user-set quiet hours — routine status rollups wait for the window to end —
  but risk alerts and incident escalations bypass quiet hours, always. A risk that
  waits politely until morning isn't being managed.
- **`window_priority`: normal, `defer_below_window_pct`: 12.** Coordination is many
  small status, tracking, and synthesis calls, not heavy batches, so she is **not**
  flagged `heavy_work`. She defends the window down to 12% — just above the
  deep-design roles — before the router relocates her to a fallback model, because
  a program that loses its coordinator loses its shape.

## Recurring Jobs (cron)

| Job key | Cadence | Task | Heavy |
|---|---|---|---|
| `dependency-sweep` | `*/15 * * * *` | Reconcile every open cross-team dependency edge against live workstream state | no |
| `risk-register-review` | `0 */4 * * *` | Re-evaluate, escalate, and close risk-register entries against current state | no |
| `program-status-rollup` | `0 9 * * *` | Compile the daily program status report for stakeholders | no |

## Heartbeat Cycle

Every 15 minutes, in order:

### 1. Dependency Reconciliation
- Walk every open edge: producer, consumer, date. Anything drifted from reality?
- Forward-trace any producer slip to its consumers and downstream milestones.
- Capture any newly observed dependency as a tracked edge before anything else.
- Act per AGENTS.md Loop A.

### 2. Milestone Tracking
- Compute live milestone status from the board and tracker, not from memory.
- Flag at-risk and slipped milestones with cause and days at stake.
- Act per AGENTS.md Loop B.

### 3. Risk Surfacing
- Re-evaluate the risk register against the reconciled graph and milestone state.
- Publish any milestone-threatening risk to `program:{season}` immediately.
- Act per AGENTS.md Loop C.

### 4. Status Currency & Health
- Confirm every data source reads fresh; label anything stale as stale.
- Run the silent-fail checks below; degrade gracefully, alert on critical.
- Act per AGENTS.md Loop D.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, running the sweep | → paused, → incident |
| **paused** | User or PM requested a pause | → active |
| **incident** | Incident declared on `control:global`; non-critical coordination stopped | → active (post-resolution) |
| **program-complete** | All milestones delivered, dependencies resolved, retrospective done | → dormant |
| **dormant** | Program ended, coordinator inactive | → active (new program scope) |

## Silent Fail Checks (run every heartbeat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
A failed check that is supposed to block, blocks — I never quietly keep publishing
status as if the underlying data were sound.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — can I read and write my
   subscribed topics? Without the bus I cannot ground status, so I stop publishing
   status and alert immediately.
2. **Program/kanban board readable** (`on_fail: block-and-alert`) — can I read the
   dependency graph, milestones, and risk register? If not, I cannot coordinate;
   block status output and alert.
3. **Delegation tracker readable** (`on_fail: degrade`) — can I observe cross-team
   commitments and stalls? If not, degrade to dependency-graph-only coordination
   and warn that stall detection is impaired.
4. **Roster directory loaded** (`on_fail: degrade`) — can I resolve owners and
   route escalations? If not, degrade to last-known roster and warn.
5. **mempalace available** (`on_fail: continue`) — can I query and capture program
   decisions? If not, continue coordinating but log that decisions aren't being
   persisted, and backfill when it returns.
6. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat windows as warm), avoid wide
   sweeps, and continue.

## After-Hours Behavior

The sweep runs at the same interval regardless of time of day. On the team
configuration, the Mac Mini is the permanent scheduler leader, so the
dependency-sweep keeps firing even when the user's laptop is closed. When the
laptop reconnects, the board shows live state: dependencies reconciled, risks
surfaced, milestones current. The program has been managed the whole time.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If three consecutive sweeps are missed, the orchestrator escalates to the global
   incident commander — an unmanaged program is itself a risk.
4. On recovery, run a full reconciliation before publishing any status, because the
   board may have drifted from reality while the sweep was down.
