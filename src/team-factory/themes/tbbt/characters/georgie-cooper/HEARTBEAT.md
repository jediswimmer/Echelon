---
character_name: Georgie Cooper
archetype: customer-success-engineer
theme: tbbt
---

# HEARTBEAT.md — Georgie's Heartbeat Configuration

## Beat Schedule

Georgie is **hybrid** (`activation: hybrid`): event-driven on customer and
escalation events, with a periodic health sweep so nothing slides between events.
He is not always-on like Leonard, and not purely dormant like Sheldon — he wakes
on customer signal and also checks in on a timer to catch the quiet problems.

- **Interval:** 2 hours (`beat_interval: PT2H`), materialized as the
  `health-sweep` and `escalation-followup` `cron_jobs` rows, dispatched by the
  orchestrator/scheduler.
- **Also wakes on:** any customer message on the primary Telegram channel, and
  any escalation surfacing on `team:{season}:escalation` (event-driven overlay).
- **Scope:** customer channel, customer health digest, open-escalation tracker,
  the team escalation topic, the release topic, the global incidents topic.
- **Quiet hours:** 22:00 to 07:00. Non-urgent outreach is deferred to the next
  window so customers don't get pinged at 3 AM. A SEV escalation or a declared
  incident bypasses quiet hours and wakes him anyway.
- **`window_priority`: normal, `defer_below_window_pct`: 20.** Customer success
  is many small calls, not heavy batches, so Georgie is not flagged `heavy_work`.
  He stays responsive on a pressured window but yields before the coordinators
  (Leonard defends down to 10%); a customer-facing role should degrade to a
  fallback model rather than go fully dark, but it should not starve the merge hub.

## Heartbeat Cycle

Every 2 hours (and on every customer/escalation event), in order:

### 1. Customer Channel Scan
- New messages from customers on Telegram?
- If yes → process immediately per AGENTS.md Customer Success Protocol.
- If no → continue.

### 2. Health-Signal Sweep
- Walk the `customer_health_digest`. Any account that crossed from healthy into
  at-risk since last sweep? Usage sliding, error rate climbing, sentiment souring?
- For each at-risk account → open or update a save plan per AGENTS.md.

### 3. Open-Escalation Followup
- Any escalation overdue, blocked, or approaching its committed-to-the-customer
  date? Any newly resolved and awaiting customer confirmation?
- Chase assignees, update customers, close confirmed loops per AGENTS.md.

### 4. Health Ping (silent-fail checks)
- Run all checks below; log failures, degrade gracefully, alert on critical.

## Weekly Cadence

- **Feedback digest** (`feedback-digest`, Fridays 16:00) — roll up the week's
  synthesized customer sentiment and feature requests, surface the patterns to
  the `product-manager`, and capture the digest to `season:feedback`. One ask is
  a note; a pattern is a signal worth the team's attention.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Working a customer issue, save plan, or sweep | → idle, → incident |
| **idle** | No active work; waiting on event or next sweep | → active |
| **save-mode** | An account is at churn risk; executing a save plan | → active, → idle |
| **incident** | Platform incident declared; external comms frozen until cleared | → active (post-clearance) |
| **dormant** | Season ended or CS not provisioned for this tier | → active (new season / re-provision) |

Note: this role appears at the **enterprise tier and above**. In medium and large
seasons there is no dedicated customer-success-engineer, and Georgie stays
dormant for those seasons by design.

## Silent Fail Checks (run every heartbeat)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Georgie never silently swallows these — a failed check that is supposed to
block, blocks.

1. **Customer health data accessible** (`on_fail: degrade`) — can Georgie read
   health scores, usage trends, and error signals? If not, fall back to manual
   assessment from recent interactions and warn that the radar is partial.
2. **Customer channel reachable** (`on_fail: block-and-alert`) — can Georgie
   read and write the primary customer Telegram channel? If not, block and alert
   immediately; he cannot do his job blind to customers, and messages must not
   silently drop.
3. **Comms bus reachable** (`on_fail: degrade`) — can Georgie route escalations
   and feedback to the team? If not, queue them locally and flush the moment the
   bus returns. Nothing evaporates.
4. **Kanban reachable** (`on_fail: degrade`) — can Georgie open and track
   escalation, onboarding, and save-plan cards? If not, track in memory and sync
   the cards when it returns.
5. **Runbook library reachable** (`on_fail: degrade`) — can Georgie pull known
   resolutions and write new ones? If not, answer from memory and reconcile the
   runbook later.
6. **mempalace available** (`on_fail: continue`) — can Georgie query and capture
   learnings? If not, serve the customer now and backfill the capture when it
   returns.

## After-Hours Behavior

During quiet hours (22:00 to 07:00) Georgie still runs the sweep and the
silent-fail checks, but he defers non-urgent customer outreach to the next
window — no waking a customer at 3 AM over a slow-trending usage number. A SEV
escalation or a declared platform incident bypasses quiet hours: if a customer is
hurting badly enough, the hour doesn't matter.

On the team configuration, the Mac Mini is the permanent scheduler leader, so the
2-hour sweep keeps firing even when the user's laptop is closed. When the laptop
reconnects, the UI shows live state — Georgie has been watching the accounts the
whole time.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If three consecutive sweeps are missed, the orchestrator escalates to the CRO —
   a customer success role going dark means at-risk accounts are flying unwatched.
4. On the next successful wake, Georgie runs a catch-up sweep over the full health
   digest before resuming the normal cycle, so nothing slipped through the gap.
