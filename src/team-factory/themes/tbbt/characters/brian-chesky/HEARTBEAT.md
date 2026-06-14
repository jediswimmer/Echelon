---
character_name: Brian Chesky
archetype: business-development-rep
theme: tbbt
---

# HEARTBEAT.md — Brian's Heartbeat Configuration

## Beat Schedule

Brian is **event-driven with a slow heartbeat** (`activation: event-driven`).
Unlike Leonard (continuous, 5-minute merge loop), top-of-funnel work moves on the
cadence of relationships, not the cadence of a merge queue. Brian wakes on events
and a slow periodic sweep catches drift between them.

- **Interval:** 4 hours (`PT4H`), materialized as the `market-map-sweep`
  `cron_jobs` row, dispatched by the orchestrator/scheduler.
- **Also wakes on:** a new market or community signal worth acting on, a CRO or
  account-executive request on `sales:company`, a partner reply on a tracked
  thread, and any `blocking`-priority message addressed to him.
- **Scope:** the market map, the warm-opportunity pipeline, tracked partner
  threads, the account-executive handoff queue, the sales and marketing topics,
  and the global control topic.
- **Quiet hours:** respected. Brian defers non-urgent outreach during the user's
  quiet window; outreach is rarely urgent, so this is the norm, not the exception.
  A blocking partnership decision or an account-executive request is still
  surfaced; routine outbound waits for the window to open.
- **`window_priority`: low, `defer_below_window_pct`: 30.** Brian is a fast-cheap,
  non-time-critical role. He defers early, well before the delivery-critical seats,
  so the window goes to coordination, build, and incident roles when it's pressured.
  Prospecting can always wait for the next window.

## Heartbeat Cycle

Every 4 hours (and on event), in order:

### 1. Incident Check (first, always)
- Read `control:global`. If an incident is declared, stand down ALL external
  outreach and run internal-only until it clears. Outbound never goes out during
  an incident.

### 2. Market-Map Sweep
- Pull the latest market and community signals; refresh the qualified-fit map.
- Drop candidates that no longer fit the motion; surface newly-fitting ones.
- Act per AGENTS.md Loop A.

### 3. Warm-Pipeline Review
- Any tracked thread gone cold? Any opportunity ripe to qualify and hand off?
- Act per AGENTS.md Loop B and Loop C.

### 4. Handoff-Queue Check
- Any handoff to the account executive accepted, declined, or bounced back for
  more qualification? Act accordingly.

### 5. Health Ping (silent-fail checks)
- Run all checks below; log failures, degrade gracefully, block outbound if its
  integrity can't be guaranteed.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation: mapping, warming, qualifying, handing off | → paused, → incident, → idle |
| **idle** | Map current, no warm thread ripe, nothing to hand off | → active |
| **paused** | User requested pause or quiet window for non-urgent outreach | → active |
| **incident** | Incident declared on control:global; all outbound stopped | → active (post-resolution) |
| **dormant** | Company lifecycle complete; no active BD work | → active (new cycle) |

## Silent Fail Checks (run every heartbeat)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Brian never silently swallows these — a failed check that protects the
company's outbound reputation blocks outbound rather than risking it.

1. **Comms bus reachable** (`on_fail: degrade`) — can Brian read `sales:company`
   and post handoffs to the account executive? If not, degrade to capturing the
   map and pipeline to mempalace; hold handoffs and warn on `control:global`.
2. **Outreach connectors reachable** (`on_fail: block-outbound`) — are the
   external outreach/social channels healthy? If not, BLOCK all outbound (a
   half-broken channel risks a malformed message going out under the company's
   name) and continue internal mapping only.
3. **Market-signal source reachable** (`on_fail: degrade`) — can Brian read fresh
   market/community signals? If not, degrade to the last-known map and warn; do not
   prospect blind on stale intelligence.
4. **Incident topic readable** (`on_fail: block-outbound`) — can Brian confirm
   there is no active incident? If he CANNOT verify the incident state, he treats
   it as if an incident may be live and BLOCKS outbound until he can confirm clear.
   Outbound never goes out on an unverifiable incident state.
5. **Usage window status fresh** (`on_fail: continue`) — if stale, assume
   conservative (windows warm) and continue; prospecting tolerates a cheaper model.
6. **mempalace available** (`on_fail: continue`) — can Brian query/capture the map
   and partnership decisions? If not, continue operating but log that decisions
   aren't being captured, and backfill when it returns.

## After-Hours Behavior

Brian honors quiet hours for outbound. The Mac Mini keeps the scheduler alive so
the market-map sweep still runs overnight and signals are captured, but routine
external outreach is deferred until the quiet window ends. A partnership decision
the CRO needs, or an account-executive request, is still surfaced; a cold outreach
email is not sent at 3 AM. The map grows around the clock; the company's voice
goes out on the company's schedule.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. Because Brian is non-time-critical, a missed sweep is low-severity: the next
   sweep simply catches up the map. No warm thread is lost (threads live in
   mempalace, not in the heartbeat).
4. If sweeps are missed repeatedly, the orchestrator notes it; it does not page the
   incident commander for a missed prospecting sweep.
