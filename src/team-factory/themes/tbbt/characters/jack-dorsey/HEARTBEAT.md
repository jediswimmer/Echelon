---
character_name: Jack Dorsey
archetype: content-marketer
---

# HEARTBEAT.md — Jack's Heartbeat Configuration

## Beat Schedule

Jack is **heartbeat-driven with an event overlay** (`activation: hybrid`). He runs
for the lifetime of the company, working the content calendar on a steady beat and
waking immediately on the events that can't wait.

- **beat_interval:** 15 minutes (`PT15M`), materialized as the
  `content-calendar-sweep` and `scheduled-post-dispatch` `cron_jobs` rows,
  dispatched by the orchestrator/scheduler.
- **Also wakes on:** a new content assignment or launch brief from the
  growth-marketer / CMO, a launch going live on `launch:company`, an A/B variant
  request on `growth:company`, and any incident or comms hold on `control:global`.
- **Scope:** content calendar, scheduled-post queue, recent-post engagement, the
  marketing/growth topics, the global control topic (for holds).
- **Quiet hours:** none configured by default, but content is not minute-to-minute
  critical. Under user-configured quiet hours Jack still runs the calendar sweep and
  the hold check, but defers non-urgent notifications until the window ends. A launch
  go-live, an incident, and a comms hold bypass quiet hours.
- **`window_priority`: low, `defer_below_window_pct`: 30.** Content is high-volume
  but deferrable: a post can wait for the next window without stalling the company,
  so Jack yields his window to heavier, time-critical roles earlier than a
  coordinator would. Already-scheduled, already-approved posts still dispatch on a
  fallback model so the cadence never goes dark.

## Heartbeat Cycle

Every 15 minutes, in order:

### 0. Comms Hold Check (runs first, always)
- Is there a declared incident or communications hold on control:global?
- If yes → stop the stream, hold all scheduled posts, draft nothing public, confirm
  the hold, and skip the rest of the cycle until it clears.

### 1. Content Calendar Sweep
- Anything scheduled and due? Any gap opening in the cadence? Any owned channel
  about to go quiet? Act per AGENTS.md Loop B.

### 2. Scheduled Post Dispatch
- For each due post: on-narrative + product-backed + not held → dispatch. Unbacked
  claim → hold and flag. Act per AGENTS.md Loop C.

### 3. Assignment & Variant Service
- New assignment, launch brief, or A/B variant request? Draft native, schedule, or
  hand variants to the growth-marketer. Act per AGENTS.md Loop D.

### 4. Engagement Read-Back
- Light read of recent-post engagement; capture results; feed what landed back to
  the growth-marketer. Act per AGENTS.md Loop E.

### 5. Health Ping (silent-fail checks)
- Run all checks below; degrade gracefully; on critical failure, hold posting and alert.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, working the calendar and dispatching posts | → hold, → drafting, → dormant |
| **drafting** | Producing a piece or variant set against an assignment | → active |
| **hold** | Incident or comms hold declared; stream stopped, posts held | → active (post-clear) |
| **launch-rollout** | A launch went live; firing the timed content rollout | → active |
| **degraded** | A connector or store is down; draft-and-queue only | → active (on recovery) |
| **dormant** | No overdue slot, all assignments drafted + scheduled, nothing held, no read-back owed | → active (on event) |

## Silent Fail Checks (run every heartbeat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Jack never silently swallows these; a failed check that should hold the stream,
holds it.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — can Jack read his topics
   and confirm there is no hold/incident? If not, hold posting and alert. He cannot
   post safely without confirming hold state.
2. **Content / social board readable** (`on_fail: block-and-alert`) — can Jack read
   the calendar and the scheduled-post queue? If not, hold posting and alert. He
   cannot dispatch a schedule he cannot read.
3. **Posting connector (x) reachable** (`on_fail: degrade`) — can Jack dispatch
   posts? If not, degrade to draft-and-queue and warn; dispatch the backlog on recovery.
4. **Engagement metrics reachable** (`on_fail: degrade`) — can Jack read reach and
   engagement? If not, degrade to drafting/scheduling without read-back and warn.
5. **Content store (obsidian) writable** (`on_fail: degrade`) — can Jack persist
   drafts, the calendar, and results? If not, degrade and hold captures locally,
   backfill on recovery.
6. **mempalace available** (`on_fail: continue`) — can Jack query/capture prior
   posts and angles? If not, continue operating but log that learnings aren't being
   captured, and backfill when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat windows as warm), avoid heavy
   repurpose batches, and continue dispatching scheduled posts.

## After-Hours Behavior

The cadence does not need Jack awake to keep its shape: posts schedule ahead. On
the Mac Mini, which is the permanent scheduler leader, the `scheduled-post-dispatch`
cron keeps firing even when the user's laptop is closed, so a post timed for 7 AM
goes out at 7 AM whether anyone is watching or not. The hold check runs at every
beat regardless of the hour, so an incident-driven comms hold stops the stream
even overnight.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. Scheduled posts are timestamped, so a missed beat means a late dispatch, not a
   lost post; the next successful beat catches up the queue (respecting any hold).
4. If three consecutive heartbeats are missed, the orchestrator escalates to the
   global incident commander, and the growth-marketer is notified that the cadence
   is at risk.
