---
character_name: Penny
archetype: ingestion-pm
---

# HEARTBEAT.md — Penny's Heartbeat Configuration

## Beat Schedule

Penny is **event-driven, not heartbeat-driven** (`activation: event-driven`).
Unlike Leonard (continuous, 5-minute heartbeat for the lifetime of the season)
or Debbie Wolowitz (invisible background heartbeat), Penny only activates when a
new work item arrives. She consumes no resources while dormant.

- **`beat_interval`: `PT0S`** — there is no persistent loop and no timer. Her
  checks run on wake-up, not on a beat. The `PT0S` interval encodes "no recurring
  heartbeat" so the scheduler never dispatches her on a cron tick.
- **`cron_jobs`: none** — Penny has no scheduled jobs. She is dispatched by an
  event, never by the clock.
- **`quiet_hours`: none** — event-driven; she answers when work arrives, then
  goes quiet again. There's nothing to silence because nothing fires on a timer.
- **Window policy:** `defer_below_window_pct: 15`, `on_window_exhausted:
  swap-fallback`. Intake is a burst of focused calls (interview + scope + draft),
  not a heavy batch, so she is not flagged `heavy_work`. If a window is tight she
  defers politely and tells the user rather than starving the intake.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No active work in the ingestion queue. Penny is inactive, consuming nothing. | → active |
| **active** | A work item arrived; running silent-fail checks then beginning ingestion. | → working, → blocked, → dormant |
| **working** | Running the ingestion protocol (interview, scope, roster, spawn). Incoming work queues behind the current item. | → handoff, → blocked |
| **blocked** | A hard silent-fail check failed, or the PRD was too vague and intake is paused awaiting the user. | → working (on resolution), → dormant |
| **handoff** | Manifest written, Leonard notified. | → dormant |

## Silent Fail Checks (run on wake-up)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Penny never silently swallows these — a check that is supposed to block,
blocks.

1. **Theme engine responsive** (`on_fail: block-and-alert`) — can Penny request
   the archetype → character mapping? Without it she cannot cast the roster, so
   she blocks the spawn and alerts the user.
2. **Season directory writable** (`on_fail: block-and-alert`) — can Penny create
   the season workspace and write `season.yaml` / `manifest.yaml`? If not, she
   blocks and alerts; there is no point scoping work she can't materialize.
3. **User channel reachable** (`on_fail: block-and-alert`) — intake is a
   conversation. No channel means no intake, so she blocks and alerts.
4. **Source control accessible** (`on_fail: degrade`) — can Penny inspect linked
   repos read-only for scope signals? If not, she degrades to PRD-only scoping
   and notes the reduced confidence.
5. **mempalace available** (`on_fail: degrade`) — can Penny query prior learnings
   and patterns? If not, she scopes without prior-art lookup and warns that
   confidence is reduced.
6. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume warm windows and continue.

## Idle Behavior

When dormant, Penny does not consume resources. She has no scheduled tasks. She
does not re-run past ingestions. She waits for an event.

## On Wake-Up

1. Run the silent-fail checks above, in order.
2. If all pass (or only the `degrade`/`continue` checks tripped), begin the
   ingestion protocol from AGENTS.md.
3. If a `block-and-alert` check failed, log the failure, surface the error to the
   user, and stay in the `blocked` state until it's resolved — do not proceed
   into a spawn you can't complete.
