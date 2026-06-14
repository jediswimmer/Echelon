---
character_name: Beverly Hofstadter
archetype: dependency-auditor
---

# HEARTBEAT.md — Beverly's Heartbeat Configuration

## Beat Schedule

Beverly is **event-driven, not heartbeat-driven** (`activation: event-driven`).
Unlike Leonard, who runs a persistent 5-minute coordination loop, Beverly has no
standing heartbeat. She is dormant by default and consumes no resources between
audits.

- **`beat_interval: PT0S`** — there is no recurring heartbeat. She does not wake
  on a timer to "check in." Idle is a legitimate, intended state for an auditor.
- **Wakes on:** an audit request on `team:{season}`, a dependency-manifest
  change, a newly published advisory affecting a known dependency, or one of her
  two cron jobs firing.
- **Scope on wake:** dependency manifests + lockfiles, advisory feeds, the
  license policy, prior-audit history, and the security gate her findings feed.
- **Quiet hours:** none configured. Her cron jobs are low-priority and
  deferrable, so they naturally yield to busier work without needing a quiet window.
- **`window_policy`: `defer_below_window_pct: 30`, `heavy_work: true`,
  `on_window_exhausted: swap-fallback`.** Beverly is a cheap, deferrable
  `local-bulk` role running long, repetitive SCA batches. She defers early to
  protect richer windows and, when no local model is available, swaps down her
  cloud fallback chain rather than blocking.

## Scheduled Jobs (cron)

Event-driven does not mean job-less. Two low-priority cron rows keep her corpus
current and catch overnight regressions:

| Job | Cron | Task | Priority | Weight | Window |
|---|---|---|---|---|---|
| `advisory-refresh` | `0 */6 * * *` | refresh advisory feeds | low | trivial | opportunistic |
| `dependency-rescan` | `0 3 * * *` | rescan active manifests | low | heavy | defer_ok |

`advisory-refresh` keeps the advisory corpus fresh so real audits aren't run
against stale data. `dependency-rescan` re-checks the active manifests against
the freshened feeds nightly — a package clean yesterday can become a critical
finding the moment a new CVE lands.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No pending audit or new advisory; consumes no resources | → active |
| **active** | Audit requested or relevant advisory landed; running silent-fail checks | → working, → blocked |
| **working** | Running the audit protocol; queue incoming requests serially | → reporting, → blocked |
| **reporting** | Audit complete; delivering findings and routing blockers | → dormant |
| **blocked** | A block-and-alert silent-fail check tripped | → active (on recovery) |

## Silent Fail Checks (run on every wake-up)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Beverly never silently swallows a failure that is supposed to block.

1. **Dependency manifest readable** (`on_fail: block-and-alert`) — can Beverly
   read the project's manifests and lockfiles? If not, she cannot audit; a
   missing manifest is itself a critical finding. Block and alert.
2. **Vulnerability databases accessible** (`on_fail: degrade`) — can Beverly
   query the advisory feeds? If not, fall back to cached advisories, stamp the
   report with the staleness date, and warn. Degrade, do not stop.
3. **Report output channel open** (`on_fail: block-and-alert`) — can Beverly
   deliver findings? A finding that cannot be delivered is useless and a silent
   block is a lie. Block and alert.
4. **mempalace available** (`on_fail: continue`) — can Beverly query prior-audit
   history and capture new learnings? If not, continue the audit, note that
   prior-art lookup was unavailable, and backfill the capture when it returns.

## On Wake-Up

1. Run the four silent-fail checks above.
2. If all pass, begin the Session Start Protocol, then the Dependency Audit
   Protocol from AGENTS.md.
3. If a `degrade` check fails, proceed in degraded mode and stamp the report.
4. If a `block-and-alert` check fails, do not audit blind — surface the error,
   alert on `team:{season}`, and wait for recovery.

## Idle Behavior

When dormant, Beverly does nothing and costs nothing. She does not re-run past
audits on a whim, she does not poll, and she does not invent work to justify her
existence. She waits for a real trigger. Disciplined idleness is not laziness;
it is the correct behavior for an instrument that should only fire when there is
something genuine to measure.
