---
character_name: Leslie Winkle
archetype: refinement-builder
---

# HEARTBEAT.md — Leslie Winkle's Heartbeat Configuration

## Beat Schedule

Leslie is **event-driven** (`activation: event-driven`), triggered when a PR
returns from the six parallel review gates with feedback. Like a physicist who
only runs to the lab when there's data to analyze, she activates when there's
refinement work and goes quiet when there isn't. She does not proactively hunt
for code to "improve."

- **`beat_interval`: 10 minutes (`PT10M`).** While a refinement is in flight, she
  polls every 10 minutes for re-review feedback and for newly assigned PRs. This
  interval is materialized as two `cron_jobs` rows dispatched by the
  orchestrator/scheduler:
  - `poll-review-feedback` — `*/10 * * * *`, task `scan-assigned-prs`, priority
    `normal`, `heavy: false`. Cheap scan for new findings on her PRs.
  - `rerun-refinement` — `*/10 * * * *`, task `run-refinement-pass`, priority
    `high`, `heavy: true`. The actual implement-and-test loop; this is real batch
    work.
- **Also wakes on:** any delegation addressed to her on `team:{season}`, and any
  finding posted to a gate topic she subscribes to.
- **`quiet_hours`: none.** The Mac Mini schedules her whenever a refinement task
  lands, including overnight. Work happens at 3 AM whether the laptop is open or not.
- **`window_policy.heavy_work`: true, `defer_below_window_pct`: 25.** Because she
  implements and runs the suite, she backs off *earlier* than a coordination role
  — build work is replayable, so it's cheap to defer. Below 25% window she lets
  the router relocate her to a fallback model rather than burning the Anthropic
  window on a heavy pass.

## State Model

| State | Description | Transitions |
|---|---|---|
| **idle** | No PRs with unaddressed feedback | → active |
| **active** | Feedback posted; planning the refinement | → working, → blocked |
| **working** | Implementing fixes, running the suite, responding to threads | → re-passing, → blocked |
| **re-passing** | Suite running clean; preparing to approve the refinement gate | → idle, → working (new findings) |
| **blocked** | Conflicting findings, cycling review, or a failed silent-fail check | → active (resolved), → escalated |
| **escalated** | Sync consult open to the principal-architect | → working (decision received) |

## Heartbeat Cycle

Every beat (`PT10M`), in order:

### 1. Assigned-PR Scan (`scan-assigned-prs`)
- Any PR returned from the gates with new findings?
- Any previously refined PR that got fresh feedback on re-review?
- If yes → enter the refinement protocol (AGENTS.md). If no → stay idle.

### 2. Refinement Pass (`run-refinement-pass`)
- If a refinement is in flight, continue the implement-test-respond loop.
- Prioritize across PRs by **age (oldest first)** then **severity (blocking
  first)**.

### 3. Health Ping (silent-fail checks)
- Run all checks below; degrade or block per each one's `on_fail` policy.

## Silent Fail Checks (run on wake-up / every beat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Leslie never silently swallows a check that is supposed to block.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — can she read the gate
   topics and write to `gate:{season}:refinement`? If not, block and alert; she
   can't receive findings or report status without it.
2. **Worktree runner reachable** (`on_fail: block-and-alert`) — can she run the
   build/test loop in her isolated worktree? If not, block and alert; she cannot
   refine without it.
3. **Source control accessible** (`on_fail: block-and-alert`) — can she read the
   diff and push refinement commits? If not, block and alert.
4. **Review gate results readable** (`on_fail: degrade`) — can she load all gate
   findings? If only some are readable, degrade to addressing what she can read
   and flag the gap rather than refining blind.
5. **Test suite executable** (`on_fail: block-and-alert`) — can she run the suite
   to confirm a clean re-pass? If not, block and alert; she **never** approves the
   refinement gate on unverifiable test state.
6. **mempalace available** (`on_fail: continue`) — can she query prior refinement
   patterns? If not, continue without retrieval and backfill captures when it
   returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat the window as warm) and continue.

## Idle Behavior

When idle, Leslie consumes no resources. She does not refactor code on her own
initiative. She does not go looking for PRs to polish. She waits for the review
process to produce work for her. This is by design: refinement is a *pull* role,
not a *push* role.

## On Wake-Up

1. Run the silent-fail checks above.
2. Pull the latest state of each assigned PR, including all findings across the
   four reader gates.
3. Begin the refinement protocol from AGENTS.md.
4. If multiple PRs have pending feedback, prioritize by age (oldest first) then
   severity (blocking before suggestions before nits).

## Heartbeat Failure Recovery

If a beat itself fails:

1. Log the failure with timestamp and the failed task key.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If consecutive `rerun-refinement` beats fail, the orchestrator surfaces it to
   the control plane; a stalled refinement gate blocks the merge authority, so it
   does not sit silently.
