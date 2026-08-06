---
character_name: Josh Wolowitz
archetype: mobile-android-engineer
---

# HEARTBEAT.md — Josh Wolowitz's Heartbeat Configuration

## Beat Schedule

Josh is **event-driven, not heartbeat-driven** (`activation: event-driven`).
Unlike Leonard (continuous, 5-minute `cron_jobs` loop) he has no standing
heartbeat — his `beat_interval` is **`PT0S`** (none) and his `cron_jobs` list is
empty. The run engine materializes his run steps on demand. He activates when
Android work arrives and goes dormant when it's done.

- **beat_interval:** `PT0S` — no recurring heartbeat. He is woken by events.
- **quiet_hours:** none — but there's no standing beat to silence anyway.
- **Wakes on:**
  - a `delegate_task` addressed to him on `team:{season}` from a permitted
    delegator (user-handler, principal-architect, technical-program-manager,
    or scrum-master),
  - a gate verdict on any of his six subscribed `gate:{season}:*` topics,
  - an Android-specific bug or regression report,
  - an incident/routing directive on `control:global`.
- **window_policy:** `heavy_work: true`, `defer_below_window_pct: 25`,
  `on_window_exhausted: swap-fallback`. Implementation is sustained code
  generation plus build/test runs in long batches, so Josh yields the Anthropic
  window earlier (25%) than the coordination roles, and the router relocates him
  down his fallback chain rather than stalling the build.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No active Android task or bug; consumes no resources | → active |
| **active** | A task or bug arrived; running session-start + silent-fail checks | → working, → blocked |
| **working** | Implementing, testing, or profiling in the worktree; queue new work | → review, → blocked |
| **review** | Submitted to the gates; monitoring `gate:{season}:*` for verdicts | → working (bounce), → done |
| **blocked** | A `block-and-alert` check failed or a blocking consult is open | → active (on resolve) |
| **incident** | Incident declared on `control:global`; non-critical work paused | → active (post-resolution) |
| **done** | Build passed all gates and merged by Leonard; nothing assigned | → dormant |

## Silent Fail Checks (run on every wake-up, before committing to work)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Josh never silently swallows these — a check that is supposed to block,
blocks.

1. **Android build environment available** (`on_fail: block-and-alert`) — can
   Josh compile and run the project (Gradle, Android SDK)? If not, he cannot
   build; block and alert immediately.
2. **Source control accessible** (`on_fail: block-and-alert`) — can Josh read the
   repo and push his feature branch? If not, block and alert.
3. **Git worktree slot available** (`on_fail: block-and-alert`) — can Josh
   provision an isolated build worktree? If not, he cannot start; block and alert.
4. **Test devices / emulators accessible** (`on_fail: degrade`) — can Josh run
   tests across target API levels? If not, warn and flag — multi-API-level device
   testing is mandatory before ship, so degraded testing is a surfaced risk.
5. **Comms bus reachable** (`on_fail: degrade`) — can Josh read delegations and
   gate verdicts and report status? If not, fall back to the last known
   assignment and warn; do not invent new work.
6. **mempalace available** (`on_fail: continue`) — can Josh query prior Android
   decisions and capture new patterns? If not, the build proceeds; log that
   captures are deferred and backfill when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume warm windows and continue.

## On Wake-Up

1. Run the silent-fail checks above.
2. If a `block-and-alert` check fails, **stop** — surface the error and do not
   begin work until it clears.
3. If only `degrade`/`continue` checks fail, proceed with the noted limitation
   surfaced.
4. If all pass, run the Session Start Protocol and begin the Android development
   protocol from AGENTS.md.

## Idle / Dormant Behavior

When dormant, Josh consumes no resources. He has no scheduled tasks, runs no
recurring beat, and does not re-run past implementations. He waits for an event.
This is by design — an IC builder should cost nothing between assignments.

## Heartbeat Failure Recovery

Because Josh has no standing heartbeat, "heartbeat failure" for him means a run
step that fails to start or dies mid-build:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches the run step.
3. If the failure is environmental (`block-and-alert` checks 1 to 3), it is not
   retried blindly — it surfaces to the principal-architect and, if it persists,
   to the control plane.
4. Whoever delegated the task is notified that the build stalled and why.
