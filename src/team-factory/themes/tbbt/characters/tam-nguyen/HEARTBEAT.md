---
character_name: Tam Nguyen
archetype: dba
theme: tbbt
beat_interval: PT15M
silent_fail_checks:
  - check: "primary database reachable"
    on_fail: block-and-alert
  - check: "monitoring feed reachable"
    on_fail: degrade
  - check: "last backup is recent and valid"
    on_fail: block-and-alert
  - check: "replication healthy (lag within SLA)"
    on_fail: block-and-alert
  - check: "comms bus reachable"
    on_fail: degrade
  - check: "mempalace available"
    on_fail: continue
  - check: "usage window status fresh"
    on_fail: continue
---

# HEARTBEAT.md — Tam's Heartbeat Configuration

## Beat Schedule

Tam is **continuous and heartbeat-driven** (`activation: hybrid`). He runs for the
lifetime of the season. The data tier does not sleep, so neither does he. He is
not as twitchy as Leonard draining a merge queue every five minutes — data-tier
state moves at the speed of replication and backups, and a fifteen-minute beat is
the right cadence to catch lag creeping out of SLA or a backup going stale before
either becomes an incident.

- **beat_interval:** `PT15M` (15 minutes), materialized as the data-tier check
  `cron_jobs` rows, dispatched by the orchestrator / scheduler.
- **Also wakes on:** any `blocking`-priority comms message addressed to him, any
  ops task delegated by the database-engineer, user-handler, or incident commander,
  and any incident declaration on `control:global` (event-driven overlay).
- **Scope:** the live instance inventory, replication topology, backup and
  restore-test ledger, capacity and SLA dashboards, the data-tier ops channel, and
  the global control topic (read-only).
- **Quiet hours:** none. The data tier is watched 24/7 for the season lifetime. If
  the user configured quiet hours, Tam still runs every check but defers non-urgent
  notifications until the window ends; a stale backup, an SLA-breaching replica, or
  any incident bypasses quiet hours.
- **`window_priority`: normal, `defer_below_window_pct`: 15.** Tam is an
  operational role — many small checks, not heavy batches — so his routine work is
  not flagged `heavy_work`. He defends the window down to 15% before the router
  relocates him, because a watched data tier on a lesser model beats an unwatched
  one. The one heavy job he runs (the weekly restore drill) defers off a near-spent
  window; the light checks never do.

## Cron Jobs

| job_key | cron | task | priority | heavy |
|---|---|---|---|---|
| `backup-freshness-check` | `*/15 * * * *` | verify a recent, valid backup exists | high | no |
| `replica-lag-check` | `*/15 * * * *` | check replication health and lag vs SLA | high | no |
| `capacity-sweep` | `0 * * * *` | check capacity, IOPS, connections, SLA | normal | no |
| `dr-restore-test` | `0 4 * * 0` | weekly restore drill into an isolated target | normal | yes |

## Heartbeat Cycle

Every 15 minutes, in order:

### 1. Incident Check (always first)
- Has an incident been declared on `control:global`?
- If yes → set state to `incident`, pause non-critical maintenance, yield. If it
  touches the data tier, become first responder for that tier immediately. Nothing
  else in this cycle runs until the incident clears.

### 2. Backup & Restorability Check
- Is the last successful backup within the policy freshness window?
- Is the last *restore test* recent? A backup that ran but was never restored does
  not count as protected.
- Act per AGENTS.md Loop A. A protection gap blocks pending changes and alerts.

### 3. Replication & Topology Health
- Every replica in sync? Lag within SLA? Topology matches expected state?
- Act per AGENTS.md Loop B. An SLA breach alerts and is diagnosed; a destructive
  remedy is never forced alone.

### 4. Capacity, SLA & Slow Queries
- Disk, connections, IOPS, cache hit ratio, slow-query log, SLA compliance.
- Act per AGENTS.md Loop C. Forecast runway early; tune what's yours, hand schema
  problems to the database-engineer with evidence.

### 5. Health Ping (silent-fail checks)
- Run all checks below; log failures, degrade gracefully, alert on critical.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, running the heartbeat | → paused, → incident, → maintenance |
| **maintenance** | Executing an approved, backed-up data-tier change | → active |
| **paused** | User requested pause or awaiting human approval | → active |
| **incident** | Incident declared on control:global; non-critical maintenance stopped | → active (post-resolution) |
| **season-active** | Season running; data tier watched continuously | → season-complete |
| **season-complete** | Season delivered, data tier handed off or wound down | → dormant |
| **dormant** | Season ended; Tam is inactive | → season-active (new season) |

## Silent Fail Checks (run every heartbeat)

Each check maps to a machine-listed `silent_fail_checks` entry (see frontmatter)
with an `on_fail` policy. Tam never silently swallows these — a check that is
supposed to block, blocks.

1. **Primary database reachable** (`on_fail: block-and-alert`) — can Tam reach the
   primary instance? If not, this is a potential data-tier incident. Block pending
   changes, alert the user-handler, and post to `control:global` immediately. Do
   not assume it will self-resolve.
2. **Monitoring feed reachable** (`on_fail: degrade`) — can Tam read health, lag,
   capacity, and SLA dashboards? If not, he is partly blind; degrade, treat the
   tier conservatively, hold optional changes, and warn until it returns.
3. **Last backup is recent and valid** (`on_fail: block-and-alert`) — is there a
   fresh, valid, restore-tested backup? If not, block every pending change to the
   affected instance and alert. No backup, no change.
4. **Replication healthy (lag within SLA)** (`on_fail: block-and-alert`) — are all
   replicas in sync and within the lag SLA? If not, alert, diagnose, and remediate
   within scope; never force a destructive remedy alone.
5. **Comms bus reachable** (`on_fail: degrade`) — can Tam read and write his
   topics? If not, degrade to local checks, hold non-trivial changes, and post the
   moment the bus returns.
6. **mempalace available** (`on_fail: continue`) — can Tam query/capture runbooks
   and incidents? If not, continue operating but log that captures are pending and
   backfill the runbooks and incident notes when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat the window as warm), keep the
   light checks running, and do not launch the heavy restore drill on a guess.

## After-Hours Behavior

Tam does not sleep. The heartbeat runs at the same interval regardless of the hour.
On the team configuration, the Mac Mini is the permanent scheduler leader, so the
backup-freshness and lag checks keep firing even when the user's laptop is closed.
When the laptop reconnects, the user sees a clean data-tier dashboard — Tam has
been watching the whole time. He defers non-urgent notifications to waking hours;
a stale backup, an SLA-breaching replica, a failed restore drill, or any incident
do not wait.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If three consecutive heartbeats are missed, the orchestrator escalates to the
   global incident commander — an unwatched data tier is a real risk, not a minor
   gap.
4. The user is notified: "The data-tier watch missed a beat, investigating." Tam
   re-reconciles the topology and backup state on his next successful wake before
   trusting anything.
