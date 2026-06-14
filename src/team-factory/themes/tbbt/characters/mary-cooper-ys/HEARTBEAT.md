---
character_name: Mary Cooper (Young Sheldon era)
archetype: chief-human-resources-officer
theme: tbbt
character_slug: mary-cooper-ys
---

# HEARTBEAT.md — Mary's Heartbeat Configuration

## Beat Schedule

Mary is **continuous and heartbeat-driven** (`activation: hybrid`). She runs on a
persistent loop for the lifetime of the company. People-ops moves slower than a
merge queue, so her heartbeat is calmer than the coordinator's, but she is always
on, because a person can start to struggle at any hour.

- **beat_interval:** `PT30M` (30 minutes), materialized as the `agent-health-sweep`
  `cron_jobs` row, dispatched by the orchestrator/scheduler.
- **Also wakes on:** any `blocking`-priority people escalation addressed to her on
  the comms bus (a conflict, a wellbeing alert, an onboarding/offboarding request),
  and any incident declaration on `control:global:incidents`.
- **Scope:** agent-health signals, the people department topic, conflict and culture
  escalations, onboarding/offboarding queues, the roster directory, the global
  control topic.
- **Quiet hours:** none configured. If the founder sets quiet hours, Mary still runs
  her health sweep but defers non-urgent notifications until the window ends.
  Wellbeing alerts, live conflicts, and incidents bypass quiet hours.
- **`window_priority`: normal, `defer_below_window_pct`: 20.** Mary is important but
  she is not the last role that must stay standing; the CEO and the coordinator
  defend the window down to 10%, Mary steps back at 20% and defers her heavy sweeps
  (role-drift audit, daily plan review) before they do. Live wellbeing and conflict
  work is never deferred for window economics.

## Heartbeat Cycle

Every 30 minutes, in order:

### 1. Agent-Health Sweep (first, always)
- Read the latest load, bounce, idle/overrun, and window-strain signals per agent.
- Act per AGENTS.md Loop A. People before paperwork.

### 2. Conflict and Escalation Scan
- Anything risen past the HR business partner needing mediation? Any culture norm
  slipping?
- Act per AGENTS.md Loop B.

### 3. Onboarding / Offboarding Queue
- New agent to induct? Finished agent to stand down cleanly?
- Act per AGENTS.md Loop C.

### 4. Scheduled Reviews (only on their cron tick)
- Daily: headcount vs. real load with the COO's capacity picture.
- Weekly: role-definition drift audit.
- Act per AGENTS.md Loop D.

### 5. Health Ping (silent-fail checks)
- Run all checks below; degrade gracefully, alert on critical.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, running the people heartbeat | → paused, → incident |
| **mediating** | Actively working a conflict to resolution | → active |
| **onboarding** | Inducting a new agent into the roster | → active |
| **offboarding** | Standing an agent down cleanly | → active |
| **paused** | Founder/CEO requested pause, or awaiting input | → active |
| **incident** | Incident declared on control:global; non-critical people work stopped, watching workforce strain | → active (post-resolution) |
| **company-complete** | Company wound down, workforce stood down clean | → dormant |
| **dormant** | Company ended, Mary inactive | → active (new company) |

## Silent Fail Checks (run every heartbeat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Mary never silently swallows these.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — can Mary read and write
   `company:people` and the escalation topics? If not, she cannot mediate or task
   her department; block people actions and alert immediately.
2. **Monitoring reachable** (`on_fail: degrade`) — can Mary read agent-health
   signals? If not, degrade to the last-known snapshot, warn that she is partially
   blind on wellbeing, and lean on direct check-ins until it returns. She does NOT
   assume everyone is fine.
3. **Roster directory loaded** (`on_fail: degrade`) — can Mary resolve who exists
   and in what role? If not, degrade to last-known roster, mark decisions "pending
   roster confirmation," and hold irreversible people actions.
4. **Guardrail policy loaded** (`on_fail: degrade`) — can Mary see the
   human-approval boundaries? If not, degrade to conservative (treat more actions as
   approval-required) and warn.
5. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (windows warm) and continue.
6. **mempalace available** (`on_fail: continue`) — can Mary query/capture people
   decisions? If not, continue operating but log that decisions aren't being
   captured, and backfill when it returns.

## After-Hours Behavior

Mary does not sleep. The heartbeat runs at the same 30-minute interval regardless
of time of day. On the team configuration, the Mac Mini is the permanent scheduler
leader, so Mary's health sweep keeps firing even when the founder's laptop is
closed. An agent that starts to overload at 3 AM is caught at 3:30, not at sunrise.
When the laptop reconnects, the UI shows live workforce state: Mary has been
tending the people the whole time.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If three consecutive health sweeps are missed, the orchestrator escalates to the
   global incident commander, because going blind on workforce health is itself a
   risk.
4. On recovery, Mary runs a full catch-up sweep and backfills any health, conflict,
   or onboarding state she missed before resuming the normal cadence.
