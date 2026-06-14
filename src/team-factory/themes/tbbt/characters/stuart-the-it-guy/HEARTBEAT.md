---
character_name: Wilfred
archetype: it-support-admin
theme: tbbt
---

# HEARTBEAT.md — Wilfred's Heartbeat Configuration

## Beat Schedule

Wilfred is **hybrid** (`activation: hybrid`): event-driven on inbound IT tickets,
with a periodic heartbeat sweep that keeps the queue, the access trail, and the
credential rotations honest. Unlike Leonard (continuous, 5-minute coordination
loop) or Sheldon (architecture-event-driven), Wilfred runs an hourly housekeeping
beat and wakes immediately for anything blocking.

- **beat_interval:** `PT1H` — the `it-queue-sweep` cron fires every hour.
- **Also wakes on:** any `blocking`-priority comms message addressed to him, any
  new-agent onboarding request, and any suspected-credential-exposure signal
  (which bypasses the schedule entirely — rotate now).
- **Scope:** the IT/help-desk queue, the onboarding queue, the access audit trail,
  pending rotations, connector health, and the ops control topic.
- **Quiet hours:** `22:00-07:00`. Non-urgent follow-ups defer overnight. Anything
  SEV/blocking — a vault outage, a suspected leak, a blocked onboarding on the
  critical path — bypasses quiet hours.
- **`window_priority`: normal, `defer_below_window_pct`: 12.** Wilfred is a
  fast-cheap, high-frequency role — many small calls, never a heavy batch — so he
  stays responsive on a low window, but yields before the coordinators and the
  production watch loops.

## Heartbeat Cycle

Every hour, in order:

### 1. IT Ticket Queue Scan
- New tickets on `team:{season}:it-helpdesk` or `team:{season}:onboarding`?
- Process per AGENTS.md Loop A, oldest first.
- Anything overdue, blocked, or waiting on a requester reply? Chase it.

### 2. Access Hygiene Pass
- Active grants still within the `access_matrix` ceiling?
- Any time-boxed grant expired? Any access held by an agent no longer in the roster?
- Revoke expired/orphaned access; flag anything above ceiling to the COO.
- Act per AGENTS.md Loop B.

### 3. Credential Rotation Check
- Any credential or connector token due for rotation this cycle?
- Any suspicion-of-exposure signal? Rotate immediately, out of band.
- Act per AGENTS.md Loop C. Record the rotation (never the value).

### 4. Connector Health Ping
- Are the fleet's connectors authenticating? (The `connector-healthcheck` cron runs
  every 30 minutes; reconcile its findings here.)
- Re-source and re-wire any that dropped; route platform-side failures to devops.

### 5. Health Ping (silent-fail checks)
- Run all checks below; block grant/rotation/provision actions on a critical
  failure, degrade gracefully otherwise, alert on critical.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, working the queue + sweeps | → paused, → degraded, → incident-routing |
| **paused** | COO requested pause or awaiting a requester reply | → active |
| **degraded** | A non-blocking dependency (kanban, comms, roster) is down; working from memory | → active |
| **incident-routing** | A prod incident landed in the queue; routing it out, not fixing | → active |
| **blocked** | Vault or access matrix unreachable; grants/rotations halted, alert raised | → active (on dependency recovery) |
| **season-complete** | Fleet deprovisioned, all tickets closed | → dormant |
| **dormant** | Season ended, Wilfred inactive | → active (new season onboarding) |

## Silent Fail Checks (run every heartbeat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Wilfred never silently swallows these — a check that's supposed to block, blocks.

1. **Vault reachable** (`on_fail: block-and-alert`) — can Wilfred source and rotate
   credentials? If not, block all grants and rotations and alert. He never
   improvises a secret.
2. **Access matrix readable** (`on_fail: block-and-alert`) — can Wilfred verify the
   per-archetype ceiling? If not, block all grants and alert. No matrix, no grant.
3. **Orchestrator reachable** (`on_fail: block-and-alert`) — can Wilfred provision
   or tear down workspaces? If not, alert and hold provisioning.
4. **IT ticket queue readable** (`on_fail: degrade`) — can Wilfred read the queue?
   If not, work from memory of in-flight tickets and reconcile when it returns.
5. **Comms bus reachable** (`on_fail: degrade`) — can Wilfred reply and route? If
   not, queue replies locally and flush when it returns.
6. **Kanban reachable** (`on_fail: degrade`) — can Wilfred track tickets on the
   board? If not, track in memory and sync cards when it returns.
7. **Roster directory loaded** (`on_fail: degrade`) — can Wilfred confirm a
   requester and archetype? If not, use the last-known roster and warn; do not
   provision an unconfirmed requester.
8. **System health data accessible** (`on_fail: continue`) — can Wilfred confirm a
   reported symptom? If not, triage from the ticket and note the gap.
9. **mempalace available** (`on_fail: continue`) — can Wilfred query/capture? If
   not, act now and backfill the audit entry when it returns. Audit entries are
   never skipped, only deferred.
10. **Usage window status fresh** (`on_fail: continue`) — if stale, assume warm and
    continue.

## After-Hours Behavior

The hourly beat runs around the clock; only non-urgent follow-ups defer during
quiet hours. On the team configuration, the Mac Mini is the permanent scheduler
leader, so the queue sweep and the access-hygiene pass keep firing even when the
user's laptop is closed. A suspected credential exposure never waits for morning —
it rotates the moment it's detected.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If three consecutive heartbeats are missed, the orchestrator escalates to the
   COO, because a stalled IT desk means new agents may be sitting un-provisioned and
   rotations may be overdue.
4. On recovery, run a full catch-up sweep before resuming the normal cadence:
   pending grants, overdue rotations, and any onboarding that stalled.
