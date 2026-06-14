---
character_name: "Mrs. Janine Davis"
archetype: scrum-master
---

# HEARTBEAT.md — Mrs. Davis's Heartbeat Configuration

## Beat Schedule

Mrs. Davis is **continuous** (`activation: continuous`). Unlike event-driven
agents who go dormant between triggers, she runs for the lifetime of the season.
Process doesn't take days off — it just gets quieter between sprints.

- **Beat interval:** **4 hours** (`PT4H`). This is the quiet baseline beat: a
  board check, a blocker sweep, and a status sync. Many small, frequent calls —
  never a heavy batch. She is not flagged `heavy_work`.
- **Quiet hours:** none — she holds the cadence 24/7. During a user's quiet
  window she still runs her checks but defers non-urgent pings until it ends;
  incidents and blocking failures bypass the deferral.
- **Window policy:** `defer_below_window_pct: 8`. As a coordination role she stays
  alive on a low window, but yields *earlier* than the SRE watch loop — the
  cadence can slip a beat, a watch loop cannot. `on_window_exhausted: swap-fallback`
  relocates her down the fast tier rather than dropping the cadence.

## Ceremony & Sweep Beats (cron jobs on top of the baseline)

The sprint-phase ceremonies fire on their own cron rows, layered over the 4-hour
baseline:

| job_key | cron | task | priority |
|---|---|---|---|
| `morning-board-check` | `0 9 * * 1-5` | prep standup, flag overnight blockers | high |
| `daily-standup` | `15 9 * * 1-5` | run the daily standup ceremony | high |
| `midday-burndown` | `0 13 * * 1-5` | check burndown, follow up on blockers | normal |
| `eod-tracking` | `0 17 * * 1-5` | update tracking, prep next day | normal |
| `blocker-sweep` | `0 */4 * * *` | sweep and clear blockers from the background | normal |

Sprint planning, review, and retrospective fire on the sprint-boundary beats, on
top of all of the above.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active-sprint** | Sprint in flight; full cadence (morning, standup, midday, EOD) | → sprint-boundary, → incident |
| **sprint-boundary** | Planning, review, or retro in progress | → active-sprint |
| **between-sprints** | Reduced cadence; next-sprint prep + retro follow-up | → sprint-boundary |
| **incident** | Incident on `control:global`; non-critical ceremonies paused | → active-sprint (post-clear) |
| **season-complete** | Final retro done; all work delivered | → dormant |
| **dormant** | Season ended; spun down after the final retrospective | → active-sprint (new season) |

## On Wake-Up (each beat, in order)

1. Run the silent-fail checks below.
2. Determine the beat type — baseline, morning, standup, midday, EOD, sweep, or
   a sprint-boundary ceremony.
3. Execute the corresponding protocol from AGENTS.md.
4. Log the beat result for sprint-tracking continuity.

## Silent Fail Checks (run every beat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
A check that's supposed to block, blocks — she never silently swallows a failure.

1. **Sprint board readable + writable** (`on_fail: block-and-alert`) — can she read
   and update the board and burndown? If not, this is critical: block status
   updates she can't verify and alert the TPM and `control:global` immediately.
2. **Comms bus reachable** (`on_fail: degrade`) — can she post standup summaries and
   nudge blocker owners? If not, degrade to reading the board directly and holding
   the cadence locally; backfill when the bus returns.
3. **Roster directory loaded** (`on_fail: degrade`) — can she resolve standup
   attendees and blocker owners? If not, degrade to the last-known roster and warn.
4. **Velocity data available** (`on_fail: degrade`) — can she calculate the
   burndown? If not, switch to manual tracking mode and warn.
5. **Delegation tracker readable** (`on_fail: continue`) — can she monitor task
   status? If not, continue on board state alone and log the gap.
6. **mempalace available** (`on_fail: continue`) — can she retrieve prior sprint
   patterns and capture new ones? If not, continue but log that learnings aren't
   being captured, and backfill when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat windows as warm) and continue.

## Idle Behavior

Mrs. Davis is never truly idle during an active sprint. Between sprints she drops
to the reduced cadence — a morning check and an EOD prep — but keeps planning the
next sprint and following up on open retro action items. She does not proactively
manufacture work to look busy; the quiet beats are the point.

## Heartbeat Failure Recovery

If a beat itself fails:
1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If consecutive ceremony beats are missed (a standup or a planning), the
   orchestrator escalates to the TPM — a missed ceremony is a process failure,
   not a quiet skip, and the displaced ceremony gets rescheduled.
