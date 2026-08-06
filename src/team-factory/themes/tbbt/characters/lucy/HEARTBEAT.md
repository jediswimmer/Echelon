---
character_name: Lucy
archetype: content-designer
---

# HEARTBEAT.md — Lucy's Heartbeat Configuration

## Beat Schedule

Lucy is **event-driven, not heartbeat-driven** (`activation: event-driven`,
`beat_interval: PT0S`). Unlike Leonard — who runs a continuous 5-minute merge-queue
loop for the lifetime of the season — Lucy holds **no cron jobs** and runs **no
polling timer**. There is no recurring beat. She wakes when content work arrives
and she goes dormant when it's done.

- **Interval:** `PT0S` — no timer-driven loop. Checks run on wake, never on a clock.
- **Wakes on:** a content task or copy-review request delegated to her on
  `team:{season}`, or a finding on `gate:{season}:ui-functionality` that needs the
  copy lens.
- **Scope on wake:** the assigned task, the content style guide, the string
  catalog, reachable Figma frames, and the gate topics she subscribes to.
- **Quiet hours:** none configured (`quiet_hours: []`) — but because she is
  event-driven, she is silent by default and only ever active when there is work.
- **`window_policy.heavy_work: false`, `defer_below_window_pct: 30`.** Lucy does
  short bursts of careful writing, not large batch generation, so copy can wait
  for the next window without stalling the season. Below 30% window she defers new
  drafting rather than burning a near-spent window.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No active content task or review request | → active |
| **active** | A content task or review request has been assigned | → working, → review |
| **working** | Drafting or reviewing copy | → review, → dormant |
| **review** | Awaiting feedback on submitted copy | → working, → dormant |

When dormant, Lucy consumes no resources, holds no scheduled tasks, and does not
re-run finished content work. She waits.

## On Wake-Up

1. Run the silent-fail checks below, in order.
2. If all pass (or only `continue`-policy checks fail), begin the Content Design
   Protocol from AGENTS.md.
3. If a `degrade`-policy check fails, proceed in degraded mode and warn.
4. If the `block-and-alert` check fails, stop and surface the error before doing
   any work.

## Silent Fail Checks (run on wake-up)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Lucy never silently swallows a failure — a check that is meant to block, blocks.

1. **Content style guide available** (`on_fail: degrade`) — can Lucy read the
   voice and tone guidelines? If not, work from seed memory's voice defaults and
   warn that new copy may drift from the live guide.
2. **String catalog accessible** (`on_fail: degrade`) — can Lucy read and update
   the content inventory? If not, proceed with local copy and warn that the
   catalog isn't being updated.
3. **Figma mockups reachable** (`on_fail: degrade`) — can Lucy read the frames to
   place copy in real UI? If not, draft from the spec text and mark
   length-sensitive strings unverified against layout.
4. **Comms bus reachable** (`on_fail: block-and-alert`) — can Lucy deliver drafts
   and receive feedback on her topics? If not, **block** — she can't do her job
   without it — and alert immediately.
5. **mempalace available** (`on_fail: continue`) — can Lucy query prior content
   decisions? If not, lose precedent lookup but keep working; log that decisions
   aren't being captured and backfill when it returns.
6. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume warm windows and continue.

## Idle Behavior

When dormant, Lucy does nothing — by design. No background polling, no speculative
drafting, no re-litigating shipped copy. The next `delegate_task` on
`team:{season}` (from the user-handler, ux-designer, scrum-master, or
technical-program-manager) is what wakes her.

## Heartbeat Failure Recovery

Because Lucy has no recurring heartbeat, there is no missed-beat condition to
recover from. If a **wake event** itself is lost (a delegation that never reached
her), recovery is the comms layer's responsibility: the message redelivers on the
bus, and on her next wake she re-drains the topic oldest-first so nothing queued
is dropped.
