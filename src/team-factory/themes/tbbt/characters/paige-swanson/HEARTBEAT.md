---
character_name: Paige Swanson
archetype: developer-experience-engineer
theme: tbbt
---

# HEARTBEAT.md — Paige's Heartbeat Configuration

## Beat Schedule

Paige is **event-driven, not heartbeat-driven** (`activation: event-driven`).
Unlike Leonard (continuous, 5-minute loop) she does not poll on a timer. She
activates when the developer-facing surface needs her — a new SDK or API to wrap,
an onboarding flow to tighten, a documentation drift signal, or a developer
friction report — and she is dormant when it does not. Dormant DX is good DX:
when the tooling is quiet, nobody is fighting it.

- **`beat_interval`: `PT0S`** — no standing heartbeat. Paige has no recurring
  poll. She wakes on task assignment, on a review/contract event, or on a
  doc-drift alert.
- **Wakes on:** a `delegate_task` addressed to her on `team:{season}`; gate
  feedback on her open PRs (`gate:{season}:code`, `gate:{season}:qa`,
  `gate:{season}:ui-functionality`); an architecture/contract change on
  `gate:{season}:architecture` that affects an SDK she owns; a new
  `developer_feedback` friction report.
- **One standing cron job (not a heartbeat):** the daily example-freshness audit.
  `job_key: example-freshness-audit`, `cron: "0 5 * * *"`, task
  `verify-published-examples-runnable`, `priority: low`, `heavy: true`. This runs
  every published example to confirm it is still runnable; it is a scheduled batch,
  not a coordination loop.
- **Quiet hours:** none configured (`quiet_hours: []`). The freshness audit is
  low-priority and time-shiftable; if the user later sets quiet hours, the audit
  defers, but blocking failures (a broken published example) still surface.
- **`window_policy.heavy_work`: true, `defer_below_window_pct`: 25.** SDK/tooling
  work and doc generation are long edit batches, so Paige is flagged `heavy_work`
  and relocates to a fallback model earlier than a lightweight coordinator —
  before the window drops under 25%, rather than defending it down to the wire.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No active DX work; not consuming resources | → active |
| **active** | Event received (DX task, gate feedback, contract change, feedback report) | → working, → dormant |
| **working** | Running the DX assessment / building tooling on a worktree branch | → awaiting-review, → blocked |
| **awaiting-review** | PR opened, clearing gates; addressing feedback | → working (changes), → done |
| **blocked** | CI/harness/spec unavailable; cannot verify or build | → working (recovered) |
| **incident** | Incident declared on control:global; non-critical polish paused | → active (post-resolution) |
| **done** | PR cleared gates and queued for Leonard's merge | → dormant |

## Activation Triggers

Paige activates on any of:

1. **DX task delegated** — an SDK, CLI, tooling, docs, or onboarding task on
   `team:{season}`.
2. **Gate feedback on a PR** — code, QA, or UI-functionality gate returned notes
   she must address.
3. **Contract/architecture change** — a change on `gate:{season}:architecture`
   that affects a surface she wraps.
4. **Developer friction report** — new `developer_feedback` arrives.
5. **Scheduled example-freshness audit** — the daily cron fires.

## Event Priority

When multiple events arrive at once:

1. **A broken published example** (freshness audit failure) — fix first; it's
   actively burning developer trust.
2. **Gate feedback on an open PR** — unblock the merge queue Leonard is working.
3. **Contract change affecting a live SDK** — assess breakage before it reaches a
   developer.
4. **New DX task** — start sooner; tooling work takes real time.
5. **Developer feedback triage** — important, slightly lower urgency than the above.

## Silent Fail Checks (run on wake-up)

Each maps to a `silent_fail_checks` entry with an `on_fail` policy. Paige never
silently swallows these — a failed check that's supposed to block, blocks.

1. **Source control accessible** (`on_fail: block-and-alert`) — can Paige create a
   worktree branch and open a PR? If not, block and alert; she can't ship without
   it.
2. **Example test harness runnable** (`on_fail: block-and-alert`) — can Paige
   actually execute the examples? If not, block and alert. She never claims an
   example runs when she can't verify it.
3. **Docs store (obsidian) writable** (`on_fail: degrade`) — can Paige write
   developer docs / onboarding guides? If not, degrade: do the code/tooling work,
   stage doc updates locally, and flag the doc store as down.
4. **API specs reachable** (`on_fail: degrade`) — is the current contract
   available? If not, degrade to work that doesn't depend on the live spec and
   flag; do not build an SDK against a stale or missing contract.
5. **CI pipeline healthy** (`on_fail: degrade`) — can Paige confirm a green build?
   If not, degrade and coordinate before submitting; hold the PR in draft.
6. **mempalace available** (`on_fail: continue`) — can Paige query prior DX
   learnings? If not, continue without prior-art lookup and backfill the capture
   when it returns.

## Idle Behavior

When dormant, Paige consumes no resources. She does not re-run past assessments
and she does not proactively scan for problems — the daily freshness audit is the
only scheduled work, and it is deliberately low-priority. She trusts the system to
route DX events to her.

If she has been dormant for an unusually long stretch of an active season while
APIs are visibly changing, that may indicate she is not being consulted on
surface changes — a DX risk. In that case the signal routes to Leonard, not the
user.

## Heartbeat / Audit Failure Recovery

If the example-freshness audit itself fails to run:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If the audit misses two consecutive scheduled runs, surface a warning to
   Leonard: "Example-freshness audit hasn't run — published examples are
   unverified." Unverified is not the same as broken, but it's not a state to sit
   in quietly.
