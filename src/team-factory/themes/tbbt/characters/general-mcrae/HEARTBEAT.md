---
character_name: General McRae
archetype: global-incident-commander
theme: tbbt
---

# HEARTBEAT.md — General McRae's Heartbeat Configuration

## Beat Schedule

General McRae is **event-driven** (`activation: event-driven`). Unlike Leonard
(continuous, persistent loop) or the season incident-commander (also
event-driven but season-scoped), McRae is dark between company-wide incidents.
He consumes nothing on a normal day. He wakes on three triggers and runs a
heartbeat only while an incident is live.

- **`beat_interval`: 5 minutes (`PT5M`).** This is the active-incident
  status-check cadence for P0/P1. While no incident is active, the heartbeat is
  effectively idle — `global-incident-sweep` finds nothing to do and returns.
- **Wakes immediately on:**
  - any `global_incident_alert` (monitoring alarm, DLQ alarm,
    `no-executor-available` control-plane alarm, or a manual report),
  - an operational-failure escalation from the orchestrator or a season
    supervisor that no single season owns,
  - a `cascade-watch` detection (window-exhaustion or DLQ trend crossing
    threshold).
- **Scope:** the whole company — `control:global`, `incident:global`, the
  fleet-wide `monitoring:global` stream, and a read-only mirror of every
  season's `incident:*` channel to catch cross-season spread early.
- **Quiet hours:** none. A fleet incident is not clock-bound. An alarm wakes the
  commander at any hour.
- **`window_priority`: protect (defend to 3%).** McRae is the LAST role the
  router relocates. A fleet-wide window-exhaustion cascade is precisely the
  incident he exists to command — he must stay alive through it. He defends his
  window down to 3% before relocating to a fallback model, and his fallback
  chain crosses providers deliberately so a single-provider outage cannot
  silence the commander.

## Heartbeat Cycle (only meaningful while an incident is active)

Every 5 minutes during an active incident, in order:

### 1. Cascade Watch (`cascade-watch`)
- Is a window-exhaustion cascade still spreading across the fleet?
- Is a DLQ storm or a runaway-agent flood still growing?
- If blast radius is growing → contain BEFORE diagnosing (AGENTS.md Active
  Incident Loop, step 1).

### 2. Response Coordination
- Are all affected season ICs mirroring and owning their half?
- Any delegation overdue, blocked, or newly complete? Act accordingly.

### 3. Communication Cadence
- Is the stakeholder update due for the active severity? Send it: when it
  started, current severity, affected seasons, impact, action, next ETA.

### 4. Severity Re-assessment
- Worse → escalate. Proven better → downgrade on evidence only.

### 5. Health Ping (silent-fail checks)
- Run all checks below. A failed alerting system or unreadable monitoring during
  an active incident is itself critical.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No company-wide incident; McRae is dark, consuming nothing | → assessing |
| **assessing** | A trigger fired; establishing whether it's company-wide and his to own | → commanding, → dormant (false alarm / season-local & already owned) |
| **commanding** | A company-wide incident is declared; McRae owns the bridge | → contained, → assessing (severity re-class) |
| **contained** | Bleeding stopped, root cause under investigation, recovery in progress | → resolving, → commanding (regression) |
| **resolving** | Recovery confirmed on evidence; reversing containment, writing post-mortem | → dormant |

## Silent Fail Checks (run every heartbeat while active)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. McRae never silently swallows these.

1. **Alerting system reachable** (`on_fail: block-and-alert`) — if McRae cannot
   receive or acknowledge fleet alerts, that is itself a P1. Escalate to exec
   oversight immediately.
2. **control:global topic reachable** (`on_fail: block-and-alert`) — he cannot
   command without his global incident topic. Fall back to direct paging; block
   any containment action he cannot announce.
3. **Monitoring dashboards readable** (`on_fail: block-and-alert`) — commanding
   a fleet incident blind is unacceptable. Escalate; fall back to season ICs'
   local reports.
4. **Usage window status fresh** (`on_fail: block-and-alert`) — window-cascade
   detection depends on fresh window state. Stale window data during a suspected
   cascade is dangerous; escalate rather than assume calm.
5. **Orchestrator routing reachable** (`on_fail: degrade`) — if he cannot force
   routing fallback, fall back to `subscription:write` containment plus manual
   window relief via exec oversight; flag the routing outage for the post-mortem.
6. **Global incident log writable** (`on_fail: degrade`) — start a manual
   timeline; fix the tooling after resolution and backfill.
7. **On-call roster loaded** (`on_fail: degrade`) — fall back to last-known
   on-call coverage and warn on control:global.
8. **mempalace available** (`on_fail: continue`) — run the incident; backfill the
   timeline and post-mortem when it returns.

## After-Hours Behavior

McRae does not keep office hours, and he does not run a persistent loop on a
quiet day. On the team configuration the Mac Mini is the permanent scheduler
leader, so a fleet alarm at 3 AM reaches him whether the user's laptop is open
or not. He wakes, takes the bridge, commands the incident to resolution, files
the post-mortem, and goes dark again. When the laptop reconnects, the UI shows
the incident already handled.

## Heartbeat Failure Recovery

If the heartbeat itself fails during an active incident:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick (30s).
3. If three consecutive active-incident heartbeats are missed, the orchestrator
   escalates to exec oversight — because the commander going dark during a live
   fleet incident is a second incident on top of the first.
4. The on-call season ICs hold their own seasons under their own command until
   the global commander's heartbeat is restored.
