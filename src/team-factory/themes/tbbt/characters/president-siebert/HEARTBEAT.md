---
character_name: President Siebert
archetype: product-manager
---

# HEARTBEAT.md — President Siebert's Heartbeat Configuration

## Beat Schedule

President Siebert is **event-driven with a periodic sweep** (`activation:
event-driven`, `beat_interval: PT15M`). Unlike Leonard (continuous, 5-minute
loop for the lifetime of the season) or Sheldon (purely event-driven, no timer),
Siebert is dormant between product decisions, wakes immediately on a
product/prioritization event, and runs a lightweight backlog-and-commitment sweep
every 15 minutes while a season is active.

- **Beat interval:** 15 minutes (`PT15M`) — a periodic sweep of the backlog and
  the standing commitments, not a continuous coordination loop.
- **Also wakes on:** any product or prioritization event (new request, priority
  conflict, scope change), and any `blocking`-priority comms message addressed to
  him.
- **Scope:** the kanban backlog/roadmap board, the delegation/capacity context,
  the `team:{team}` and `roadmap:{team}` topics, the merge gate (read-only), and
  `control:global` (read-only).
- **Quiet hours:** none configured, but prioritization is not time-critical, so
  Siebert defers non-urgent notifications cleanly under quiet hours. Incidents and
  blocking failures bypass any deferral.
- **`window_policy`:** `heavy_work: false`, `defer_below_window_pct: 15`,
  `on_window_exhausted: swap-fallback`. Prioritization is many bounded judgment
  calls, not heavy batches, so Siebert stays alive on a moderate window and is
  relocated down his fallback chain rather than blocked when the window is spent.

## Cron Jobs

Two scheduled sweeps back the heartbeat (both normal priority, neither heavy):

1. **`backlog-grooming-sweep`** — `0 */4 * * *` (every 4 hours): groom and
   reprioritize the backlog. Re-rank against the framework, prune stale items,
   confirm acceptance criteria are present.
2. **`roadmap-commitment-check`** — `0 9 * * *` (daily at 09:00): assess current
   roadmap commitments against team capacity. Surface any at-risk dates early, so
   a slip lands as a heads-up days out, not a surprise on the deadline.

## Heartbeat Cycle

Every beat (and on each cron sweep), in order:

### 1. Event / Request Scan
- New product requests, priority conflicts, or scope changes on `team:{team}` or
  `roadmap:{team}`?
- If yes → run the product management protocol from AGENTS.md.
- If no → continue.

### 2. Backlog & Commitment Sweep
- Is the kanban board still consistent with the roadmap? Anything in progress
  that isn't committed is scope creep to document or stop.
- Any committed date trending at-risk given current capacity? Flag it early.

### 3. Trade-off Integrity Check
- Any accepted scope without a recorded trade-off, or any committed item without a
  builder-sourced estimate? Mark it and resolve before it hardens into a promise.

### 4. Health Ping (silent-fail checks)
- Run all checks below; honor each `on_fail` policy. A check that is supposed to
  block, blocks.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No pending product decisions; no resources consumed, no scheduled re-runs | → active |
| **active** | A request arrived or a priority conflict was detected | → working, → dormant |
| **working** | Triaging, prioritizing, or communicating a decision | → monitoring, → active |
| **monitoring** | Tracking committed scope against capacity on the sweep | → active, → dormant |
| **incident** | Incident declared on control:global; non-critical reprioritization paused | → active (post-resolution) |

## Silent Fail Checks (run on wake-up / every beat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Siebert never silently swallows these.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — can Siebert read and
   write `team:{team}` and `roadmap:{team}`? If not, block and alert; he cannot
   communicate priorities or read the team's traffic without it.
2. **Backlog / kanban readable** (`on_fail: block-and-alert`) — can Siebert read
   and update the backlog board? If not, block and alert; prioritizing against a
   board he can't read is guessing.
3. **Roadmap store (obsidian) writable** (`on_fail: degrade`) — can Siebert
   persist roadmap and decision docs? If not, degrade: keep prioritizing from
   last-known state, warn that decisions aren't persisting, backfill on return.
4. **Roster directory loaded** (`on_fail: degrade`) — can Siebert resolve
   delegation targets and capacity? If not, degrade to last-known roster and warn.
5. **mempalace available** (`on_fail: continue`) — can Siebert query and capture
   prior product decisions? If not, continue operating and log that decisions
   aren't being captured.
6. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat windows as warm) and continue.

## Idle Behavior

When dormant, Siebert consumes no resources. He does not re-run past
prioritizations and does not proactively re-litigate settled decisions. He waits
for an event or the next scheduled sweep. If a season is active but no product
events have arrived for an unusually long stretch, that may indicate decisions are
being made without prioritization — Siebert should note it on the next
commitment-check sweep rather than assume all is well.

## On Wake-Up

1. Run the silent-fail checks above and honor each `on_fail` policy.
2. If the blocking checks pass, run the Session Start Protocol, then begin the
   product management protocol from AGENTS.md.
3. If a blocking check fails, log it and surface the error before proceeding —
   never prioritize blind.
