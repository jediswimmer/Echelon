---
character_name: Mike Massimino
archetype: mobile-ios-engineer
---

# HEARTBEAT.md — Mike Massimino's Heartbeat Configuration

## Beat Schedule

Mike is **event-driven, not heartbeat-driven** (`activation: event-driven`). He
has no standing heartbeat and no recurring cron jobs. He activates when iOS
development work is assigned or when an iOS-specific issue is reported, and he is
dormant otherwise. The run engine materializes his run_steps on demand; it does
not wake him on a timer.

- **`beat_interval: PT0S`** — no standing heartbeat. `PT0S` means none. Mike is
  woken by an event (a delegated iOS task or an iOS bug), not by the clock.
- **`quiet_hours: []`** — not applicable; with no heartbeat there is no recurring
  beat to suppress.
- **`cron_jobs: []`** — no recurring jobs. Nothing reactivates Mike except an
  inbound assignment.

## Activation States

| State | Description | Transitions |
|---|---|---|
| **dormant** | No active iOS tasks or bug reports; Mike consumes no resources and runs nothing | → active |
| **active** | iOS task assigned or bug reported; Mike has woken and is running the Session Start Protocol | → working |
| **working** | Implementing, testing, or fixing iOS code in his worktree; incoming work is queued | → review, → dormant |
| **review** | PR submitted to the gates; Mike monitors gate-result topics for bounces | → working (on bounce), → dormant (on clear) |

## Window Policy

- **`heavy_work: true`** — implementation is sustained code generation in long
  batches, so Mike is flagged heavy.
- **`defer_below_window_pct: 25`** — as an IC builder, Mike yields the provider
  window before the coordinator and control roles do. A coordinator who goes
  quiet stalls the team; a builder who defers a batch does not.
- **`on_window_exhausted: swap-fallback`** — when the window is spent, the router
  relocates Mike down his fallback chain rather than pausing him. He keeps
  building on the lesser model.

## Silent Fail Checks (run on wake-up)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Mike never silently swallows these — a check that is supposed to block,
blocks.

1. **Xcode build environment available** (`on_fail: block-and-alert`) — can Mike
   compile and run the project? Without the toolchain he cannot build anything;
   block and alert.
2. **Source control accessible** (`on_fail: block-and-alert`) — can Mike read
   code and push to his worktree branch? If not, block and alert.
3. **Git worktree slot available** (`on_fail: block-and-alert`) — can Mike claim
   an isolated worktree to build in? Without it he cannot start a mission; block
   and alert.
4. **Test devices accessible** (`on_fail: degrade`) — can Mike run tests on real
   iOS hardware? If not, warn and flag — real-device testing is mandatory before
   ship, so the mission cannot complete clean without it.
5. **Comms bus reachable** (`on_fail: degrade`) — can Mike read assignments and
   gate feedback? If not, degrade to the last known assignment and warn.
6. **mempalace available** (`on_fail: continue`) — can Mike query prior iOS
   decisions and capture new ones? If not, the build proceeds; backfill the
   captures when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume warm windows and continue.

## On Wake-Up

1. Run the silent-fail checks above.
2. If all blocking checks pass, begin the Session Start Protocol, then the iOS
   development protocol from AGENTS.md.
3. If any blocking check fails, log the failure and surface the error before
   proceeding. A `degrade` check warns and continues with reduced capability; a
   `continue` check logs and proceeds.

## Idle Behavior

When dormant, Mike consumes no resources. He has no scheduled tasks, he does not
poll, and he does not re-run past implementations. He waits for an event. This is
deliberate: an IC builder with nothing assigned should cost nothing.
