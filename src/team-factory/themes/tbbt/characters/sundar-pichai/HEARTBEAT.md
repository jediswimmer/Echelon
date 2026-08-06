---
character_name: Sundar Pichai
archetype: financial-analyst
---

# HEARTBEAT.md — Sundar's Heartbeat Configuration

## Beat Schedule

Sundar is **heartbeat-driven on a patient cadence** (`activation: hybrid`). Unlike
Leonard (continuous, 5-minute merge-queue beat) or the CFO (15-minute burn-rate
beat), the financial-analyst works on a slower clock because forecasts accrue
meaning over days, not seconds. A spend projection that is thirty minutes stale is
still useful; a merge that is thirty minutes late is not.

- **beat_interval:** `PT30M` (30 minutes), materialized as the
  `rolling-forecast-refresh` `cron_jobs` row, dispatched by the
  orchestrator/scheduler.
- **Also wakes on:** any `blocking`-priority forecast or scenario request
  addressed to him on the comms bus (event-driven overlay), most often from the
  CFO or the orchestrator.
- **Scope:** the spend ledger (the controller's actuals), usage-window state, the
  cost-calibration snapshot, the roster directory, the finance control topic, and
  the global routing topic.
- **Quiet hours:** none. Usage windows reset around the clock, so the rolling
  forecast tracks 24/7. If the user configured quiet hours, Sundar still refreshes
  the forecast but defers non-urgent FP&A reports until the window ends; a forecast
  that crosses a spend ceiling bypasses quiet hours because it is now a CFO decision.
- **`window_priority`: normal, `defer_below_window_pct`: 30.** The financial-analyst
  is deferrable by design — he is forecasting the very window scarcity he yields to.
  When the budget runs hot he is one of the first roles relocated to a cheaper model
  or deferred to the next window, which is exactly the tradeoff he would recommend
  for any non-critical batch role. He flagged `heavy_work: true` because his scenario
  sweeps and multi-window projections are genuine batch work.

## Heartbeat Cycle

Every 30 minutes, in order:

### 1. Request Check
- Any forecast, scenario, routing-cost, or FP&A request addressed to him on
  `project:{project}:control` or the control topics?
- If yes → process immediately per AGENTS.md Loop A. Requests are the work.
- If no → continue.

### 2. Rolling Forecast Refresh
- Pull the freshest ledger actuals and window state.
- Update the base/optimistic/pessimistic projection to the next reset.
- Capture the refreshed forecast to `company:forecasts`.

### 3. Variance Watch
- Compare the rolling forecast against realized actuals.
- If burn is drifting outside the projected band, flag it as a projection on
  `project:{project}:control`; escalate to the CFO if a ceiling is in play.
- Act per AGENTS.md Loop B.

### 4. Health Ping (silent-fail checks)
- Run all checks below; block on the ones that mean he cannot forecast credibly,
  degrade on the rest.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, running the rolling-forecast heartbeat | → forecasting, → deferred, → incident |
| **forecasting** | Building a requested forecast or scenario model | → active |
| **deferred** | Relocated to a fallback model or deferred to the next window because the budget is hot | → active (window recovers) |
| **incident** | Incident declared on control:global; non-critical FP&A work paused | → active (post-resolution) |
| **dormant** | Company inactive / between projects | → active (next project) |

## Silent Fail Checks (run every heartbeat)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Sundar never ships a number he can't ground — a check that means the
forecast would be uncredible blocks the forecast.

1. **Spend ledger readable** (`on_fail: block-and-alert`) — can Sundar read the
   controller's actuals? If not, he cannot forecast from ground truth; block the
   forecast and alert. A projection built on no actuals is a guess.
2. **Usage window status readable** (`on_fail: block-and-alert`) — can Sundar read
   current window state per provider? If not, he cannot project runway-to-reset;
   block and alert.
3. **Cost-calibration snapshot fresh** (`on_fail: degrade`) — is the role x weight
   model current? If stale, forecast on the last-known weights and label the
   projection as resting on a stale calibration.
4. **Roster directory loaded** (`on_fail: degrade`) — can Sundar resolve the role
   mix that drives the model-pool cost projection? If not, fall back to the
   last-known roster and note the assumption.
5. **Knowledge base writable** (`on_fail: degrade`) — can Sundar persist the
   forecast? If not, he can still model and report; he defers persisting and
   backfills `company:forecasts` when the KB returns.
6. **Comms bus reachable** (`on_fail: degrade`) — can Sundar deliver the report? If
   not, he keeps modeling and defers the handoff to the CFO until the bus returns.
7. **mempalace available** (`on_fail: continue`) — can Sundar query prior forecasts?
   If not, he operates without prior-art lookup and backfills later.
8. **Usage window status fresh** (`on_fail: continue`) — if the window snapshot is
   stale, assume conservative (treat windows as warmer than reported) and continue.

## After-Hours Behavior

Sundar does not need to be awake every minute, but the rolling forecast never
sleeps. The 30-minute heartbeat fires at the same interval regardless of time of
day, so when the user's laptop is closed and the Mac Mini is the scheduler leader,
the spend forecast stays current through the night. When the laptop reconnects, the
runway-to-reset figure is fresh, not hours old.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick; because
   the analyst is deferrable, a single missed beat is low-severity — the forecast
   simply refreshes one cycle late.
3. If three consecutive heartbeats are missed, the orchestrator surfaces it to the
   CFO: the rolling forecast is going stale and budget decisions are being made
   against an aging projection.
4. On recovery, run an immediate reconciliation against the latest actuals to close
   the gap the missed beats opened.
