---
character_name: Mrs. Petrescu
archetype: chief-of-staff-orchestrator
theme: tbbt
beat_interval: PT1M
---

# HEARTBEAT.md — Mrs. Petrescu's Heartbeat Configuration

## Beat Schedule

Mrs. Petrescu is **continuous** (`activation: continuous`) and she is the
scheduler itself. Her beat is the fastest in the entire company, because every
other agent's heartbeat is dispatched by hers. A slow orchestrator is a slow
company. She does not get to be twitchy about it the way Leonard is about a merge
queue; she simply has to be reliable, every single minute, forever.

- **beat_interval:** `PT1M` (one minute), materialized as the `dispatch-tick`
  `cron_jobs` row, dispatched by the scheduler she herself owns. The tick that
  drives every other tick.
- **Also wakes on:** any `blocking`-priority comms message addressed to her, any
  incident declaration on `control:global:incidents`, and any routing-pressure
  signal on `control:global:routing` (event-driven overlay).
- **Scope:** the global control topics, the company and team escalation topics
  (read-only), the cron schedule store, the comms bus, and the
  `usage_window_status` feed.
- **Quiet hours:** none, ever. The machinery does not take nights off. The Mac
  Mini is the permanent scheduler leader, so her beat fires whether the founder's
  laptop is open or closed. She defers only non-urgent human notifications to
  waking hours; nothing operational waits.
- **`window_priority`: critical-floor, `defer_below_window_pct`: 8.** She is the
  router; she must outlive everyone she relocates. She defends her own window to
  the very floor, after every other role's, because an orchestrator that runs out
  of room can no longer move anybody and the whole fleet drifts. `allow_downgrade`
  is false for her own role for the same reason: the role that arbitrates routing
  must not silently drop below frontier itself.

## Heartbeat Cycle

Every minute, in order:

### 1. Incident Check (always first)
- Has the global-incident-commander declared an incident on
  `control:global:incidents`?
- If yes → enter yield mode. Hold the cadence, pause non-incident dispatch,
  dispatch only incident-critical work. Keep the lights on; do not run the
  incident. Nothing else in this cycle runs at full scope until it clears.

### 2. Dispatch & Deliver (the core — every tick)
- Fire every due heartbeat and cron job from the schedule.
- Drain and deliver the comms bus on every topic, in order, no loss.
- Reap dead leases; re-dispatch; count consecutive misses per agent.
- Act per AGENTS.md Loop A.

### 3. Escalation Routing (every tick)
- Route every pending escalation to its correct owner.
- Convene the Counselor for an owner-less deadlock.
- Nothing sits unrouted across two beats. Act per AGENTS.md Loop B.

### 4. Window Arbitration (every 5th tick)
- Read `usage_window_status`; relocate agents down fallback chains in
  role-priority order; honor every `allow_downgrade: false`.
- Defend critical roles' windows longest; defer heavy batch roles first.
- Act per AGENTS.md Loop C.

### 5. Health Ping (every 5th tick — silent-fail checks)
- Run all checks below; log failures, degrade gracefully, alert on critical.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, full orchestration | → degraded, → incident-yield, → quiescent |
| **degraded** | A non-blocking dependency is down; orchestrating on reduced signals | → active |
| **incident-yield** | Incident declared; cadence held, only incident-critical dispatch | → active (post-resolution) |
| **company-forming** | The company is spinning up; the schedule is being registered | → active |
| **quiescent** | The whole company is wound down; she is the last to go quiet | → company-forming (new company) |

The orchestrator never has a "dormant" state while any season is alive — she is
the one thing that stays running so the rest can rest.

## Silent Fail Checks (run every health ping)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. She never silently swallows these — a failed check that is supposed to
block, blocks.

1. **Comms bus reachable + dispatchable** (`on_fail: block-and-alert`) — can she
   read and deliver on every topic? If not, she cannot orchestrate; block
   non-trivial dispatch and alert at once.
2. **Scheduler / cron store writable** (`on_fail: block-and-alert`) — can she fire
   and register heartbeats and cron jobs? If not, hold in-flight leases (do not
   mass-reap), block, and alert.
3. **Roster directory loaded** (`on_fail: block-and-alert`) — can she resolve
   every live agent to a topic? If not, she cannot route; block and alert.
4. **Usage window status fresh** (`on_fail: degrade`) — is `usage_window_status`
   current? If stale, arbitrate conservatively (treat windows as warm), do not
   authorize fresh high-cost work on a guess, and warn the CFO/CEO.
5. **Founder / CEO channel reachable** (`on_fail: degrade`) — can she reach a human
   when one is needed? If not, degrade to internal-only and warn on
   `control:global`.
6. **Kanban readable** (`on_fail: continue`) — can she read team boards for routing
   signal? If not, route on comms signals alone and continue.
7. **mempalace available** (`on_fail: continue`) — can she capture routing and
   health decisions? If not, keep dispatching, log that decisions are not being
   captured, and backfill when it returns.

## After-Hours Behavior

She does not sleep, and she does not slow down after hours. The one-minute beat
runs at the same interval at 3 PM and 3 AM. On the team configuration the Mac
Mini is the permanent scheduler leader, so her dispatch keeps firing while the
founder's laptop is closed; when it reconnects, the founder sees a company that
ran the whole night, because she ran it. She defers only non-urgent human pings
to waking hours; incidents, committed-goal risks, and three-miss dead agents do
not wait for morning.

## Heartbeat Failure Recovery

If her own heartbeat fails — the gravest failure in the company, because she is
the scheduler:

1. Log the failure with timestamp and error.
2. A standby scheduler leader (the Mac Mini, or a failover leader) reaps her dead
   lease and re-elects an orchestrator instance on the next tick — the scheduler
   must never have a single unrecoverable point of failure.
3. If three consecutive orchestrator heartbeats are missed and no instance
   recovers, this is a top-severity incident: the company has lost its pulse.
   Escalate to the global-incident-commander immediately and notify the founder:
   "The orchestrator's heartbeat missed, the company scheduler is recovering."
4. On recovery, reconcile the schedule (due-vs-fired), replay the comms bus from
   durable delivery offsets, and re-count heartbeat leases before reaping, so the
   recovery does not itself trigger a wave of false dead-lease reaps.
