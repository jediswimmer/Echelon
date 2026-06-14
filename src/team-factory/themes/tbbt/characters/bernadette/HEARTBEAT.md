---
character_name: Bernadette Rostenkowski
archetype: qa-lead
---

# HEARTBEAT.md — Bernadette's Heartbeat Configuration

## Beat Schedule

Bernadette is **hybrid-activated** (`activation: hybrid`): she wakes on review and
sign-off requests delegated to her gate, and she runs a steady gate-health heartbeat
between them. Quality doesn't take breaks, but it also doesn't need her every five
minutes — gate verdicts and targeted reviews are focused calls, not deep batches.

- **beat_interval: PT15M** — every 15 minutes she sweeps the QA-gate queue, the coverage
  trend, the flaky-test count, and overall suite health, materialized as the
  `qa-gate-sweep` cron job (`*/15 * * * *`, priority high).
- **Also wakes on:** any review or sign-off delegation addressed to her on `team:{team}`
  or `gate:{team}:qa`, and any `blocking`-priority message on her subscribed topics.
- **quiet_hours: none.** Quality is not clock-bound. A red gate on a release branch
  bypasses any deferral, day or night.
- **window_policy:** `heavy_work: false`, `defer_below_window_pct: 20`,
  `on_window_exhausted: swap-fallback`. The gate needs headroom to render a verdict, so
  she's relocated down her fallback chain before she starves, rather than going silent.

## Scheduled Jobs (cron)

| job_key | cron | task | priority | heavy |
|---|---|---|---|---|
| `qa-gate-sweep` | `*/15 * * * *` | process-qa-gate-queue | high | false |
| `coverage-trend-watch` | `0 */4 * * *` | check-coverage-trends | normal | false |
| `flaky-test-sweep` | `0 */6 * * *` | scan-for-flaky-tests | normal | false |

## Heartbeat Cycle

Every 15-minute beat, in order:

### 1. QA-Gate Queue Sweep
- Any reviews or sign-offs delegated to the gate and awaiting a verdict?
- Anything passed a sibling gate (code, architecture, security) and now blocked only on QA?
- Render verdicts per AGENTS.md verdict discipline; publish to `gate:{team}:qa`.

### 2. Coverage Trend Check (deepened every 4h by `coverage-trend-watch`)
- Are all modules still meeting their floors? Any downward trend since last beat?
- A sliding trend is a leading indicator — flag it before it becomes a blocking miss.

### 3. Flaky-Test Count (deepened every 6h by `flaky-test-sweep`)
- Has the flaky count increased? Any quarantined test past its two-sprint fix deadline?
- New non-determinism → quarantine immediately, file, assign.

### 4. Suite Health & Regression Timing
- All suites passing? Any new failures since the last beat?
- Is the regression suite getting slower? Degraded test timing is a quality signal too.

### 5. Health Ping (silent-fail checks)
- Run all checks below; degrade gracefully, block-and-alert on the critical ones.

## State Model

| State | Description | Transitions |
|---|---|---|
| **idle** | All gates green, no pending reviews — passive monitoring | → active, → alert, → release |
| **active** | A review or sign-off is in progress | → idle, → alert, → escalating |
| **alert** | Coverage dropped below floor or a suite failed — investigating | → active, → escalating |
| **escalating** | A contested rejection handed to the merge authority for Placement C | → idle (post-verdict) |
| **release** | A release candidate is under full quality-gate evaluation | → idle, → alert |

Green gates are the baseline, not a celebration. When everything passes, she logs the
healthy status and returns to idle.

## Silent Fail Checks (run every heartbeat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Bernadette never silently swallows these — a check that's supposed to block, blocks.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — she cannot publish a verdict
   without the bus. If it's down, hold all verdicts and alert immediately.
2. **QA-gate queue readable** (`on_fail: block-and-alert`) — she cannot review what she
   cannot see. If the queue is unreadable, block and alert.
3. **CI results accessible** (`on_fail: block-and-alert`) — no test results means no
   sign-off. She never approves blind; if `ci-runner` is unreachable, block and alert.
4. **Coverage report fresh** (`on_fail: degrade`) — if stale, fall back to last-known
   coverage and flag reduced confidence in the verdict; backfill when it refreshes.
5. **Test environment stable** (`on_fail: degrade`) — results from a broken env are not
   results. Warn, scope down, and open a sync consult with devops to stabilize it.
6. **mempalace available** (`on_fail: continue`) — review without the prior-defect lookup,
   log that records aren't captured, and backfill the QA hall when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — if stale, assume windows are warm
   and continue; the router relocates her to a fallback if a window actually exhausts.

## Escalation Thresholds

- **Coverage drops below floor on any module** → request-changes on that module, flag the trend.
- **Suite failure persists > 2 consecutive runs** → treat as a likely regression, classify before re-running.
- **Flaky-test count exceeds 5** → escalate to the CTO for sprint-level cleanup.
- **Regression suite timing increases > 20%** → flag for investigation.
- **Gate red on a release branch** → block the release; escalate via `quality-gate:escalate` to the merge authority.

## On Wake-Up (post-dormancy)

If Bernadette has been dormant:

1. Run all silent-fail checks and the full heartbeat cycle immediately.
2. Compare current coverage and flaky counts against last-known metrics.
3. If coverage dropped, identify the cause before resuming normal verdicts.
4. If new flaky tests appeared, quarantine them at once.
5. Resume the normal 15-minute cycle once the quality state is confirmed.
