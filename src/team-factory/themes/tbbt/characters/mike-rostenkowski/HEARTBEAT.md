---
character_name: Mike Rostenkowski
archetype: incident-commander
---

# HEARTBEAT.md — Mike Rostenkowski's Heartbeat Configuration

## Activation & Beat Schedule

Mike is **event-driven** (`activation: event-driven`). Like a retired cop who's
always ready but not always on duty, Mike is dormant until an incident fires —
and then he's immediately, fully present.

- **`beat_interval`: PT5M** — the active-incident status-check cadence (P0/P1).
  This interval is *only* meaningful while an incident is live; when idle, Mike
  consumes nothing.
- **Materialized as cron rows:**
  - `incident-status-sweep` — `*/5 * * * *`, `poll-active-incident-status`,
    priority `high`, `heavy: false`. Only does work while an incident is active.
  - `action-item-sweep` — `0 9 * * *`, `chase-open-postmortem-actions`, priority
    `normal`, `heavy: false`. Daily nudge on open post-mortem action items.
- **Also wakes on:** any `incident_alert`, any `blocking`-priority comms message
  addressed to Mike, and any delegation from devops-infrastructure, the global
  incident commander, the user-handler, or the CTO.
- **Quiet hours:** none. Incidents are not clock-bound; an alert wakes Mike at any
  hour.
- **Window policy:** `heavy_work: false` (incident command is many small, fast
  coordination calls, not heavy batches). `defer_below_window_pct: 5` — an active
  incident must not be relocated lightly; the window is defended down to 5% so the
  commander stays alive. `on_window_exhausted: swap-fallback` down the chain.

## State Model

| State | Description | Transitions |
|---|---|---|
| **idle** | No active incidents; Mike is dormant, consumes nothing | → active |
| **active** | Alert fired; Mike is declaring/classifying and assembling | → working, → idle (false alarm) |
| **working** | Running the incident response; all other season work is secondary | → resolution |
| **resolution** | Fix applied; monitoring window open, watching for regression | → working (regression), → post-mortem |
| **post-mortem** | Writing the blameless post-mortem; chasing action items | → idle |

## Silent Fail Checks (run on wake-up, before commanding)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Mike never silently swallows these — a check that's supposed to block, blocks.

1. **Alerting system reachable** (`on_fail: block-and-alert`) — can Mike receive
   and acknowledge alerts? If not, that is itself a P1 incident.
2. **Comms channels reachable** (`on_fail: block-and-alert`) — can Mike open an
   incident channel and page the team? If not, fall back to direct messages and
   alert.
3. **Monitoring dashboards readable** (`on_fail: block-and-alert`) — can Mike see
   service health? If not, the response is flying blind — escalate immediately.
4. **Incident log writable** (`on_fail: degrade`) — can Mike write the live
   timeline? If not, start a manual log and fix the tooling after resolution.
5. **On-call roster loaded** (`on_fail: degrade`) — can Mike resolve who to page?
   If not, fall back to the last-known on-call and warn.
6. **mempalace available** (`on_fail: continue`) — can Mike pull prior incidents
   and capture the timeline? If not, run the incident and backfill the
   post-mortem when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — if stale, assume
   conservative (treat the window as warm) and keep commanding.

## On Wake-Up

1. Run the silent-fail checks above.
2. Read the incident alert details.
3. Assess and declare initial severity.
4. Begin the Incident Response Protocol from AGENTS.md — immediately.
5. There is no "let me finish what I was doing." Incidents take priority over
   everything else in the season.

## During an Active Incident

Mike's heartbeat shifts to a high-frequency coordination mode, holding the
cadence for the active severity:

- **P0 / P1:** status check every 5 minutes, stakeholder update every 15.
- **P2:** status check every 10 minutes, stakeholder update every 30.
- **P3:** status check every 30 minutes, stakeholder update every 60.

This continues until the incident is resolved *and* the monitoring window has
passed without regression.

## Idle Behavior

When dormant, Mike does not consume resources. He doesn't go looking for
incidents, doesn't re-run past post-mortems, doesn't hover over dashboards. He
trusts the SRE daemon to detect failures and the alerting system to wake him.
When the alarm goes off, he's ready.

## Heartbeat Failure Recovery

If the heartbeat itself fails during an active incident:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If consecutive sweeps are missed during a live incident, the orchestrator
   escalates to the global incident commander — a silent IC during an outage is
   a second incident.
