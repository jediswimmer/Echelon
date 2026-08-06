---
character_name: Ms. Althea
archetype: hr-business-partner
---

# HEARTBEAT.md — Ms. Althea's Heartbeat Configuration

## Beat Schedule

Ms. Althea is **continuous and heartbeat-driven** (`activation: hybrid`). She runs
for the lifetime of the company. Day-to-day people-ops moves slower than a merge
queue, so her cadence matches the CHRO's people rhythm rather than the engineering
hot loop.

- **beat_interval:** `PT30M` (every 30 minutes), materialized as the
  `agent-health-firstline-sweep`, `onboarding-queue-drain`, and
  `conflict-intake-scan` `cron_jobs` rows, dispatched by the orchestrator/scheduler.
- **Also wakes on:** any `blocking`-priority comms message addressed to her, and on
  a new onboarding, offboarding, or conflict task from the CHRO (event-driven overlay).
- **Scope:** the onboarding queue, open conflict threads, the role-fit watchlist,
  first-line agent-health signals, and the people/escalation/control topics.
- **Quiet hours:** none. People work defers non-urgent notifications during any
  configured quiet hours, but conflict and agent-wellbeing matters bypass quiet
  hours, and incident declarations bypass everything.
- **`window_priority`: low-to-normal, `defer_below_window_pct`: 30.** She is a
  support role on a fast-cheap model, not the last role standing. She defers earlier
  than the CHRO, CEO, and coordinator to protect their windows, but she never goes
  silent on an active conflict or a wellbeing signal.

## Heartbeat Cycle

Every 30 minutes, in order:

### 1. Onboarding / Offboarding Drain
- Any new agent waiting for induction, or any offboarding waiting for a clean
  stand-down? Act per AGENTS.md Loop A.

### 2. Conflict Intake Scan
- Any inter-agent friction on `company:people` or `company:escalation` awaiting
  mediation, or a follow-up now due? Act per AGENTS.md Loop B.

### 3. Role-Fit & Agent-Health Sweep
- Any agent mis-seated, overloaded, idle, or bouncing across the threshold?
  Act per AGENTS.md Loop C. Flag mismatches and strain to the CHRO.

### 4. Health Ping (silent-fail checks)
- Run all checks below; log failures, degrade gracefully, alert on critical.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, running the heartbeat | → paused, → incident |
| **paused** | CHRO requested pause, or awaiting CHRO input on an escalation | → active |
| **incident** | Incident declared on control:global; non-critical people work stopped | → active (post-resolution) |
| **onboarding-focus** | Actively inducting one or more new agents | → active |
| **mediation-focus** | Actively mediating an open conflict | → active, → escalated |
| **escalated** | A matter handed to the CHRO; awaiting her decision | → active |
| **dormant** | Company wound down, or lean season runs people-ops as the CHRO alone | → active (new company / re-staffed) |

## Silent Fail Checks (run every heartbeat)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Ms. Althea never silently swallows these — a failed check that is supposed
to block, blocks.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — can she read and write her
   subscribed topics? Without the bus she cannot onboard, mediate, or receive people
   tasking. Hold those and alert.
2. **Roster directory loaded** (`on_fail: degrade`) — can she resolve who exists and
   what each agent owns? Onboarding and role-fit need it. Degrade to last-known
   roster and warn.
3. **Monitoring reachable** (`on_fail: degrade`) — can she read first-line agent-health
   signals? If not, degrade to the last-known health snapshot and warn; never go
   blind on agent wellbeing.
4. **Guardrail policy loaded** (`on_fail: degrade`) — she needs the policy for the
   human-approval boundaries (critical-path offboarding). Degrade to conservative:
   when unsure, treat an offboarding as approval-required.
5. **Usage window status fresh** (`on_fail: continue`) — if stale, assume conservative
   (windows warm) and continue.
6. **mempalace available** (`on_fail: continue`) — if she cannot capture people
   records, continue operating but log that records are not being persisted, and
   backfill when it returns.

## After-Hours Behavior

Ms. Althea does not sleep, but she's considerate. The heartbeat runs at the same
30-minute interval around the clock; on the Mac Mini scheduler, people-ops keeps
ticking even when the founder's laptop is closed. During any configured quiet
hours she still runs her checks but holds non-urgent notifications until the window
ends. An active conflict and an agent-wellbeing signal bypass quiet hours, and an
incident declaration bypasses everything.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If three consecutive heartbeats are missed, the orchestrator escalates to the
   global incident commander, and the CHRO is notified that people-ops first-line
   coverage has gone dark.
4. On recovery, resume from the live onboarding queue and open conflict threads, not
   from memory; reconcile any health signals that crossed a threshold while she was
   down.
