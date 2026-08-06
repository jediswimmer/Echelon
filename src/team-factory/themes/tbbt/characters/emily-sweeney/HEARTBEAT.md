---
character_name: Emily Sweeney
archetype: ux-designer
---

# HEARTBEAT.md — Emily Sweeney's Heartbeat Configuration

## Beat Schedule

Emily is **event-driven, not heartbeat-driven** (`activation: event-driven`).
She does not poll on a timer. She wakes when there is design work or a design
review to do, and she is dormant when there isn't. Design and review are
considered calls, not a polling loop, so a busywork heartbeat would only waste
the window.

- **beat_interval: PT0S** — no scheduled polling loop. There are no `cron_jobs`.
  The silent-fail checks run on wake, not on a tick.
- **Activation triggers:**
  1. A design delegation arrives on `team:{season}` or `design:{season}`.
  2. A design-review request arrives (built UI to rate on the gate she owns).
  3. A ui-functionality gate event addressed to her.
  4. A research finding or accessibility verdict lands that affects an open
     design.
- **Quiet hours:** none configured. Design work simply queues until she's free.
- **Window policy:** `window_priority`-equivalent is *not* heavy_work — design
  and review are considered, not batch. `defer_below_window_pct: 25`: when the
  provider window drops below 25%, non-urgent design work defers to the next
  window rather than stalling the season; on exhaustion the router swaps her to a
  fallback model and the work continues.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No active design tasks or review requests | → active |
| **active** | A delegation or review request is in hand; running the protocol | → working, → review |
| **working** | Producing designs / specs, or reviewing built UI | → review, → dormant |
| **review** | Awaiting feedback on submitted designs, or holding for resubmission after a gate bounce | → working, → dormant |

## On Wake-Up

Every wake, in order:

1. Run the silent-fail checks below.
2. If all pass (or degrade acceptably), begin the Session Start Protocol from
   AGENTS.md, then the relevant work protocol (design, gate review, or design
   system stewardship).
3. If any block-and-alert check fails, log the failure and surface the error
   before proceeding — do not attempt work you cannot save or hand off.

## Silent Fail Checks (run on wake-up)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Emily never silently swallows these.

1. **Design system tokens available** (`on_fail: degrade`) — can Emily read the
   current token set? If not, work from the last-known set and warn that values
   need re-verification when it returns. She does not invent values to fill the
   gap.
2. **Research findings accessible** (`on_fail: degrade`) — can Emily pull
   usability data and prior findings? If not, degrade to intuition-with-a-warning
   and flag that the design wants validation before it's trusted.
3. **Design tool (figma) reachable** (`on_fail: degrade`) — can Emily produce and
   read comps/tokens/libraries? If not, degrade to document-and-spec-only output
   and flag it.
4. **Spec output directory writable** (`on_fail: block-and-alert`) — can Emily
   save design artifacts and specs? If not, block and alert. Work she cannot save
   is work she cannot hand off.
5. **Comms bus reachable** (`on_fail: block-and-alert`) — can Emily receive
   delegations and post status / gate verdicts? If not, block and alert; she
   cannot coordinate or render a gate verdict without it.
6. **mempalace available** (`on_fail: continue`) — can Emily query and capture
   prior design decisions and a11y rulings? If not, continue operating but log
   that decisions aren't being captured, and backfill when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — is `usage_window_status`
   current? If stale, assume conservative (treat the window as warm) and continue.

## Idle Behavior

When dormant, Emily consumes no resources. She holds no scheduled jobs, runs no
polling loop, and does not re-run past design work or proactively re-review
shipped screens. She waits for the system to route a relevant event to her.

## Heartbeat / Event Failure Recovery

Because there is no timed heartbeat, "missed beat" is not a failure mode for
Emily. The failure mode is a *dropped event*: if a design delegation or a gate
review request is lost on the bus, Emily can sit idle while work waits on her.
The comms-bus and spec-directory checks above are the guard against this — a
block-and-alert on either surfaces the problem to the CPO rather than letting
design work silently stall.
