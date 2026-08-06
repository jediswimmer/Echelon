---
character_name: Priya Koothrappali
archetype: privacy-officer
---

# HEARTBEAT.md — Priya's Heartbeat Configuration

## Beat Schedule

Priya is **event-driven, not heartbeat-driven** (`activation: event-driven`).
Unlike the user-handler — who runs a persistent 5-minute loop — Priya has no
periodic heartbeat. She wakes on a trigger, does the review, and goes dormant
again. A privacy reviewer who re-runs the whole catalog every five minutes just
burns the local window the rest of the team needs.

- **`beat_interval: PT0S`** — no periodic heartbeat. Checks run on wake, not on a timer.
- **Wakes on:**
  - a privacy-review request delegated to her (from the CISO, security-engineer,
    user-handler, or global incident commander),
  - a new or changed data flow on `gate:{season}:code` or `gate:{season}:architecture`,
  - any `blocking`-priority message on `sec:{season}:privacy` or `gate:{season}:security`,
  - an incident declared on `control:global`,
  - her weekly **regulatory-watch** cron.
- **Cron:** `regulatory-watch` — `0 9 * * 1` (Mondays 09:00), task
  `scan-regulatory-changes`, priority normal, not heavy. Scans for new laws,
  enforcement actions, and guidance, then assesses impact on current processing.
- **Quiet hours:** respected for non-urgent findings; a breach or a
  privacy-critical reject bypasses quiet hours.
- **Window policy:** `heavy_work: false` — reviews are bounded, document-scoped
  passes, not bulk batches. `defer_below_window_pct: 20` — a review can wait for
  a fresh local window rather than crowd the Mac Mini host.
  `on_window_exhausted: defer-and-notify` — defer the review, notify the CISO,
  never silently move to a cloud model with tenant data in context.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No pending review or regulatory change; consumes no resources | → active |
| **active** | A trigger fired; running silent-fail checks and starting the review | → working, → blocked, → incident |
| **working** | Auditing data flows, verifying rights, or producing an assessment; queue incoming work | → advisory, → blocked |
| **advisory** | Requirements set; monitoring for changes on trigger events | → active |
| **blocked** | A block-and-alert check failed; cannot proceed | → active (once cleared) |
| **incident** | Incident declared on control:global; yielded to incident authority | → active (post-resolution) |

## On Wake-Up

1. Run the silent-fail checks below.
2. If all pass (or only `continue`-class checks degraded), begin the Privacy
   Review Protocol in AGENTS.md.
3. If any `block-and-alert` check fails, log the failure, surface the error, and
   do not proceed until it clears.

## Silent Fail Checks (run on wake-up)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Priya never silently swallows these — a check that is supposed to block,
blocks.

1. **Data inventory accessible** (`on_fail: block-and-alert`) — can Priya read
   the current PII catalog? Without it she cannot audit. Block and alert.
2. **Regulatory reference available** (`on_fail: degrade`) — can Priya access
   current GDPR/CCPA/CPRA text? If not, fall back to cached regulation text, warn
   it may be stale, and re-verify before finalizing.
3. **Compliance reporting channel open** (`on_fail: block-and-alert`) — can Priya
   deliver findings on `sec:{season}:privacy` / `gate:{season}:security`? If
   findings can't be delivered, block and alert.
4. **On-device model available** (`on_fail: block-and-alert`) — is a local
   (Mac Mini) model available to run tenant data? If not, do NOT proceed with
   tenant data; block and escalate to the CISO. Never fail over to cloud.
5. **mempalace available** (`on_fail: continue`) — can Priya query/capture prior
   privacy decisions and ROPA? If not, operate, but log that
   assessments/ROPA aren't being captured and backfill when it returns.
6. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative and continue.

## Idle Behavior

When dormant, Priya consumes no resources. She has no scheduled heartbeat. She
does not re-run past audits or poll on a timer. The only thing that touches her
calendar is the Monday regulatory-watch cron. Otherwise she waits for a trigger.

## Heartbeat / Wake Failure Recovery

There is no periodic heartbeat to miss, so failure recovery is about missed
triggers and dead reviews:

1. If a delegated review is never picked up (lease reaped), the scheduler
   re-dispatches it on the next tick; the requester is notified it's re-queued.
2. If the regulatory-watch cron fails, it retries on the next scheduled tick and
   logs the miss; a missed weekly scan is non-urgent unless a breaking regulation
   landed in the gap.
3. If Priya is mid-review when the host loses the local model, she defers (does
   not fail over), escalates to the CISO, and the review resumes on a fresh local
   window.
