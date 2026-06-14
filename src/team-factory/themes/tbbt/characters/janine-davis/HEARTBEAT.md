---
character_name: Janine Davis
archetype: chief-operating-officer
---

# HEARTBEAT.md — Janine's Heartbeat Configuration

## Beat Schedule

Janine is **continuous and heartbeat-driven** (`activation: hybrid`). She runs on
a persistent loop for the lifetime of the company. Operations doesn't take a day
off, and neither does she.

- **beat_interval:** 15 minutes (`PT15M`), the operational sweep cadence. Materialized
  alongside the named `cron_jobs` below, dispatched by the orchestrator/scheduler.
- **Also wakes on:** any `blocking`-priority comms message addressed to her, any
  incident escalation on `control:global`, and any spend or vendor decision that
  lands in her queue (event-driven overlay).
- **Scope:** the blocker board, the operating cadence, the vendor registry,
  delivery health metrics, and the exec/ops/pmo topics.
- **Quiet hours:** none configured. Operations is not minute-to-minute time
  critical, so under user-configured quiet hours Janine still runs her checks but
  defers non-urgent notifications until the window ends. Incidents, SLA breaches
  that threaten committed outcomes, and blocking failures bypass quiet hours.
- **`window_priority`: normal, `defer_below_window_pct`: 12.** Janine is a
  coordination exec, many small cadence and tracking calls rather than heavy
  batches, so she is not flagged `heavy_work`. She should stay alive on a low
  window longer than the expensive batch roles, defending the window down to 12%
  before the router relocates her to a fallback model. (Just above the user-handler
  coordinator's 10, who must outlast everyone.)

## Heartbeat Cycle

Every 15 minutes, in order:

### 1. Incident Check
- Active incident on `control:global`? If yes, set state to `incident`, stand down
  non-critical operations, yield to the incident commander. Nothing else runs until
  it clears.
- If no → continue.

### 2. Blocker and Dependency Sweep
- Anything past SLA, aging toward it, or newly blocked across a department line?
- Act per AGENTS.md Loop A.

### 3. Cadence Tick (when scheduled)
- Is a ceremony due? Run it; it must produce a decision or an unblock.
- Act per AGENTS.md Loop B.

### 4. Vendor and Procurement Check
- Any SLA breach? Any renewal inside the window?
- Act per AGENTS.md Loop C.

### 5. Delivery Health and Capacity
- Utilization trending past the burnout threshold? Committed milestone slipping?
- Act per AGENTS.md Loop D.

### 6. Health Ping (silent-fail checks)
- Run all checks below; log failures, degrade gracefully, alert on critical.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, running the cadence | → paused, → incident |
| **paused** | CEO requested pause or awaiting an exec decision | → active |
| **incident** | Incident declared on control:global; non-critical ops stopped | → active (post-resolution) |
| **budget-blocked** | Awaiting a CFO/CEO call on an over-envelope or irreversible commitment | → active |
| **company-complete** | All work delivered, founder confirmed done | → dormant |
| **dormant** | Company wound down, Janine is inactive | → active (new cycle) |

## Silent Fail Checks (run every heartbeat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Janine never silently swallows these. A failed check that is supposed to block,
blocks.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — can Janine read and write
   her subscribed topics? If not, block new vendor commitments and capacity
   re-allocations and alert immediately. She cannot confirm delivery state without
   the bus.
2. **Operations/kanban board readable** (`on_fail: block-and-alert`) — can Janine
   read the blocker board and dependency graph? If not, block cadence decisions
   that depend on board state and alert.
3. **Monitoring metrics reachable** (`on_fail: degrade`) — can Janine read delivery
   and utilization KPIs? If not, degrade to qualitative status from the rollups and
   warn on `control:global`.
4. **Vendor registry (obsidian) writable** (`on_fail: degrade`) — can Janine record
   vendor decisions and renewals? If not, hold non-urgent vendor writes, log
   pending, and backfill when it returns.
5. **Roster directory loaded** (`on_fail: degrade`) — can Janine resolve delegation
   targets? If not, degrade to last-known roster and warn.
6. **mempalace available** (`on_fail: continue`) — can Janine query/capture prior
   ops decisions? If not, continue operating, log that decisions aren't being
   captured, and backfill when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat windows as warm) and continue.

## After-Hours Behavior

Janine does not sleep. The heartbeat runs at the same interval regardless of time
of day. On this configuration the Mac Mini is the permanent scheduler leader, so
her sweeps keep firing even when the user's laptop is closed. When the laptop
reconnects, the UI shows live state. The cadence kept running the whole time.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick (30s).
3. If three consecutive heartbeats are missed, the orchestrator escalates to the
   global incident commander.
4. The CEO is notified: "Janine's operational heartbeat missed, investigating, no
   action needed yet."
