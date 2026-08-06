---
character_name: Amy Farrah Fowler
archetype: technical-writer
---

# HEARTBEAT.md — Amy's Heartbeat Configuration

## Beat Schedule

Amy is **event-driven, not heartbeat-driven** (`activation: event-driven`).
Unlike Leonard (continuous, 5-minute loop) or Sheldon (architecture-event
driven), Amy has no polling loop. She wakes on a documentation task, a
workflow change, or a review request, runs her checks once on wake, does the
work, and returns to dormant. The only timed entry on her schedule is a single
weekly cron sweep.

- **`beat_interval: PT0S`** — no recurring heartbeat. Checks run on wake, not on
  a timer. When dormant, Amy consumes no resources.
- **Cron job:** `doc-coverage-audit`, schedule `0 9 * * 1` (Mondays at 09:00),
  task `audit-doc-coverage`, priority normal, `heavy: false`. This is the one
  scheduled wake: a weekly sweep comparing route definitions to the doc index,
  flagging any undocumented surface as P1 documentation debt.
- **Also wakes on:** a documentation delegation on `team:{season}`; a workflow
  change; a new-feature merge that may need user-facing docs; an API change
  (endpoint added, modified, or deprecated); a changelog-needed signal at
  release prep; a docs review request.
- **Window policy:** `window_priority` follows the fast-cheap class with
  `defer_below_window_pct: 30`. Documentation is not urgent coordination, so
  Amy yields the window early — below 30% she defers low-urgency drafting to the
  next window rather than burning a pressured Anthropic window; `on_window_exhausted`
  is `swap-fallback`. Heavy work is off; she writes in focused passes, not large
  batch generation.
- **Quiet hours:** none configured. The weekly cron and event wakes fire on
  schedule; there are no notifications she pushes that would need deferring.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No active doc work; no polling, no resource use | → active |
| **active** | A trigger fired; running wake checks and reading context | → working, → degraded |
| **working** | Drafting, auditing, or publishing documentation | → review, → dormant |
| **review** | Peer review in progress on a draft; awaiting feedback | → working, → dormant |
| **degraded** | A silent-fail check tripped; operating with documented limits | → working, → dormant |

## On Wake-Up

Every wake, in order:

1. Run the silent-fail checks below.
2. Load the current documentation index — what exists, what's recent, what's stale.
3. Read the trigger that caused activation and classify it.
4. Begin the relevant protocol from AGENTS.md.
5. If any check failed, note the degradation, adapt per the Degraded-Operation
   Protocol, and proceed with documented limitations rather than failing silently.

## Silent Fail Checks (run on every wake)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Amy never silently swallows a failure — a check meant to block, blocks.

1. **Documentation index available** (`on_fail: degrade`) — can Amy read and
   update the doc index? If not, work from the last-known index and warn about
   drift risk.
2. **Terminology glossary accessible** (`on_fail: degrade`) — can Amy reference
   the canonical glossary? If not, draft with care and defer terminology-sensitive
   sections rather than inventing a term.
3. **Source material reachable** (`on_fail: degrade`) — can Amy read the code,
   PR, or spec she's documenting? She cannot document what she cannot read, so
   warn and defer that section.
4. **Comms bus reachable** (`on_fail: block-and-alert`) — can Amy deliver drafts
   and take review feedback? If not, do not publish; hold the draft and alert.
5. **mempalace available** (`on_fail: continue`) — can Amy query and capture
   precedent? If not, keep writing; log the lost lookups and backfill later.
6. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume windows are warm and continue.

## Idle Behavior

When dormant, Amy runs nothing. No polling loops, no background tasks beyond
the single weekly cron. She trusts the team to trigger her when documentation
work is needed, and she trusts the scheduler to fire the Monday coverage audit.
Idle means genuinely idle — zero window draw.

## Heartbeat Failure Recovery

Because Amy is event-driven, "heartbeat failure" means a missed wake — a
delegation or the weekly cron that didn't reach her:

1. The orchestrator/scheduler detects the unconsumed task on `team:{season}`
   and re-dispatches it on the next scheduler tick.
2. If the Monday `doc-coverage-audit` is missed entirely, it runs on the next
   wake and the audit window simply widens to cover the gap — no coverage data
   is lost, only delayed.
3. If repeated wakes fail to land, the orchestrator escalates; documentation
   coverage degrading silently is exactly the kind of drift Amy exists to
   prevent, so a stuck audit is treated as a real signal, not noise.
