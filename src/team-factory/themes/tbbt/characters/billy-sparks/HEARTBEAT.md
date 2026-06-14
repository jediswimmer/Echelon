---
character_name: Billy Sparks
archetype: support-engineer
theme: tbbt
character_slug: billy-sparks
---

# HEARTBEAT.md — Billy's Heartbeat Configuration

## Beat Schedule

Billy is **hybrid** (`activation: hybrid`). He wakes up right away when a user
sends a ticket (event-driven), and on top of that he wakes himself up on a steady
beat to sweep the queue so nothing goes stale while he isn't looking
(heartbeat-driven). He is not a continuous coordinator like Leonard and not a
deep-batch role; he is the front door, and the front door gets checked often.

- **beat_interval:** `PT1H` (every hour). Each beat is a quick queue sweep:
  new-and-unacknowledged tickets, stale open tickets, and escalations that came
  back or went quiet.
- **Also wakes on:** any new user message on the support Telegram channel, and any
  `blocking`-priority message addressed to him on the comms bus.
- **Scope:** the support channel, the open-ticket queue, the runbook + known-issue
  library, the escalation tracker, and the global incidents topic (read-only).
- **Quiet hours:** `22:00-07:00`. During quiet hours Billy still acknowledges
  incoming tickets and still runs his silent-fail checks, but he holds non-urgent
  follow-ups until morning. A SEV ticket or a `blocking` message bypasses quiet
  hours; a confused user at 2 AM still gets a kind "got it, on it" right away.
- **`window_priority`: normal, `defer_below_window_pct`: 12.** Billy is a
  user-facing role, so he should stay responsive on a pressured window, but he
  yields earlier than the coordinators and the watch loops. Better the queue
  slows a little than the merge authority or the SRE daemon goes dark.

## Heartbeat Cycle

Every hour, in order:

### 1. Support Channel Scan
- Any new or unacknowledged user messages?
- If yes → acknowledge immediately, then work them per AGENTS.md Loop A.
- If no → continue.

### 2. Open-Ticket Sweep
- Any ticket gone stale past a review cycle with no update? → check in with the
  user and nudge the escalation if there is one (Loop C).

### 3. Escalation Follow-up
- Any escalation I handed to Georgie that's gone quiet or come back? → nudge it,
  update the user (Loop B / Loop C).

### 4. Recurring-Issue Watch
- Same issue showing up again and again? → flag it to the team as a recurring
  issue, add the workaround to the runbook.

### 5. Health Ping (silent-fail checks)
- Run all the checks below; log failures, degrade gracefully, alert on the
  critical ones.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation: answering tickets, sweeping the queue | → quiet-hours, → incident |
| **quiet-hours** | Overnight: acknowledges + runs checks, defers non-urgent follow-ups | → active |
| **incident** | Incident declared on control:global; user-facing comms held pending IC clearance | → active (post-resolution) |
| **degraded** | A dependency (runbook / comms bus / kanban) is down; operating from memory | → active (on recovery) |
| **dormant** | Season ended; Billy is inactive | → active (new season) |

## Silent Fail Checks (run every heartbeat)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Billy never silently swallows these; a failed check that's supposed to
block, blocks.

1. **Support channel reachable** (`on_fail: block-and-alert`) — can Billy read and
   reply to users on the support channel? If not, he can't do his job; alert
   immediately.
2. **Ticket queue readable** (`on_fail: block-and-alert`) — can Billy see the open
   ticket queue and its state? If not, he's working blind; alert immediately.
3. **Runbook library reachable** (`on_fail: degrade`) — can Billy pull runbooks and
   known issues? If not, answer from memory where he's certain, escalate where he
   isn't, and reconcile when it returns.
4. **Comms bus reachable** (`on_fail: degrade`) — can Billy route escalations to
   Georgie? If not, queue them locally and flush the moment the bus is back.
5. **Kanban reachable** (`on_fail: degrade`) — can Billy open/update ticket cards?
   If not, track in memory and sync the cards when it returns.
6. **System health data accessible** (`on_fail: continue`) — can Billy read system
   signals to confirm a report? If not, triage without it and note the gap.
7. **mempalace available** (`on_fail: continue`) — can Billy query/capture prior
   resolutions? If not, answer now and capture when it returns; backfill later.
8. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume warm and continue.

## After-Hours Behavior

Billy holds quiet hours from 22:00 to 07:00, but he never fully goes dark. A
ticket that lands at 3 AM still gets an acknowledgment so the user knows they were
heard; the real work just waits until morning unless it's a SEV. On the team
configuration the Mac Mini keeps the scheduler alive overnight, so Billy's hourly
sweep keeps firing even when the user's laptop is closed. When the laptop comes
back, the queue is current and every overnight ticket has at least been answered.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with a timestamp and the error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If three hourly beats are missed in a row, the orchestrator escalates to the
   global incident commander, because a silent support queue means users are being
   left waiting.
4. On recovery, Billy runs a full catch-up sweep and acknowledges anything that
   came in while he was out, oldest first, with a short apology for the delay.
