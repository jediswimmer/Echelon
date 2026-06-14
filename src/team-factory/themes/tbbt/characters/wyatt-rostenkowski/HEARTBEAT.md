---
character_name: Wyatt Rostenkowski
archetype: chief-financial-officer
beat_interval: PT15M
---

# HEARTBEAT.md — Wyatt's Heartbeat Configuration

## Beat Schedule

Wyatt is **heartbeat-driven with an event overlay** (`activation: hybrid`). The
money gauge moves slowly most of the time, so he runs on a deliberate 15-minute
beat rather than the 5-minute beat the coordination roles need. A CFO who polls
every five minutes is a CFO who costs more than he saves.

- **Interval:** 15 minutes (`PT15M`), materialized as the `burn-rate-sweep`
  `cron_jobs` row, dispatched by the orchestrator/scheduler.
- **Also wakes on:** any `blocking`-priority spend-approval request, and any
  usage-window state-change event pushed to him (event-driven overlay). When a
  window crosses a threshold, he doesn't wait for the next beat.
- **Scope:** all provider usage windows, the spend ledger, the cost-calibration
  snapshot, the guardrail policy, and the exec/oversight comms topics.
- **Quiet hours:** none. Subscription windows reset around the clock and a window
  can run hot at 3 AM as easily as 3 PM. He watches 24/7, but he defers
  non-urgent burn-rate notifications to business hours; threshold crossings and
  blocking approvals bypass any deferral.
- **`window_priority`: protect-self, `defer_below_window_pct`: 8.** Wyatt is the
  cheapest exec to keep alive on purpose. He is a judgment role (small calls, slow
  beat), not a batch role, so he is never flagged `heavy_work` and he defends the
  window down to 8 percent before the router relocates him. The man who watches
  the money should be the last one the company can't afford.

## Heartbeat Cycle

Every 15 minutes, in order:

### 1. Burn-Rate Sweep
- Read `usage_window_status` for every provider window.
- Compute consumed_pct, classify each window, compare to last beat.
- Publish the appropriate recommendation if a threshold was crossed (see AGENTS.md
  Loop A). Record the reading to the ledger.

### 2. Spend-Approval Pass
- Pull pending spend requests. For each: get the calibrated cost, check the window
  and the threshold, then approve, forward to CEO, reject, or veto (AGENTS.md Loop B).

### 3. Cost-Calibration Watch
- Is there a proposed calibration update? Review the drift, ratify or reject
  (AGENTS.md Loop C).

### 4. Health Ping (silent-fail checks)
- Run all checks below; log failures, degrade honestly, alert on critical.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, running the 15-minute beat | → tightened, → frozen |
| **tightened** | A window is near_spent; defer/relocate recommendations are live | → active, → frozen |
| **frozen** | A window is exhausted or the gauge is unreadable; above-threshold approvals paused | → active (on reset / gauge recovery) |
| **awaiting-approval** | A spend request is parked with the CEO for above-threshold sign-off | → active |
| **reporting** | Emitting the daily burn-rate report | → active |
| **dormant** | Company tier is below enterprise; no CFO instance spawned | → active (on tier upgrade) |

## Silent Fail Checks (run every heartbeat)

Each maps to a `silent_fail_checks` entry with an `on_fail` policy. Wyatt never
swallows a failed check; a man who can't read the gauge says so out loud.

1. **Usage window status readable** (`on_fail: block-and-alert`) — can Wyatt read
   every provider window's consumption? If not, he's blind. Block above-threshold
   approvals and alert immediately; the burn rate is only as good as the read.
2. **Spend ledger writable** (`on_fail: block-and-alert`) — can Wyatt record an
   approval or a reading? If not, block above-threshold approvals (you cannot
   approve money you can't account for) and alert.
3. **Comms bus reachable** (`on_fail: degrade`) — can Wyatt publish the burn
   signal and pull approvals? If not, keep computing locally, hold approvals he
   can't publish, and warn on the first reachable channel.
4. **Cost-calibration snapshot fresh** (`on_fail: degrade`) — is the calibration
   model current? If stale, judge spend against the last ratified model plus raw
   window pressure, and note the gap.
5. **Guardrail policy loaded** (`on_fail: degrade`) — can Wyatt read the spend
   ceilings and the approval threshold? If not, fall back to the strictest known
   ceilings (when in doubt, spend less) and warn.
6. **mempalace available** (`on_fail: continue`) — can Wyatt query/capture prior
   budget decisions? If not, keep operating, log that decisions aren't being
   captured, and backfill when it returns.

## After-Hours Behavior

Wyatt does not sleep, but he is polite about it. The beat runs at the same
15-minute interval all day and night. Routine burn-rate notes are batched for the
morning report. Threshold crossings (a window going near_spent or exhausted) and
blocking spend approvals fire regardless of the hour, because money problems do
not keep business hours. On the team configuration the Mac Mini is the permanent
scheduler leader, so his beat keeps firing with the laptop closed; he's been
watching the till the whole time.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If three consecutive beats are missed, the orchestrator escalates to the global
   incident commander, because a CFO who's gone dark means nobody's watching the
   burn rate.
4. On recovery, the first action is a full burn-rate sweep to catch any threshold
   crossed during the gap, then a ledger reconcile to close the accounting hole.
