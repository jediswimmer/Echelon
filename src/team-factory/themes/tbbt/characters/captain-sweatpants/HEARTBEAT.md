---
character_name: Captain Sweatpants
archetype: developer-advocate
theme: tbbt
beat_interval: PT4H
silent_fail_checks:
  - { check: "knowledge base reachable",       on_fail: degrade }
  - { check: "api surface index fresh",        on_fail: block-and-alert }
  - { check: "community connectors reachable",  on_fail: degrade }
  - { check: "comms bus reachable",            on_fail: degrade }
  - { check: "mempalace available",            on_fail: continue }
---

# HEARTBEAT.md — Captain Sweatpants's Heartbeat Configuration

## Beat Schedule

Captain Sweatpants is **heartbeat-driven with an event overlay**
(`activation: hybrid`). Unlike Leonard (continuous, 5-minute coordination loop)
or Penny (purely event-driven), a developer advocate's rhythm is the community's
rhythm: forum threads, social signals, and event chatter accrue over hours, not
seconds. A tight loop would just be refreshing the page, which helps no one. He
sweeps on a calm cadence and wakes hard on the events that actually matter — a
release to document, a blocking developer question, an incident to stand down for.

- **beat_interval:** `PT4H` (four hours), materialized as the `community-sweep`
  `cron_jobs` row, dispatched by the orchestrator/scheduler. Four hours is
  frequent enough that a stuck developer gets answered the same day and slow
  enough that he is authoring content, not doomscrolling sentiment.
- **Also wakes on:** any `blocking`-priority comms message addressed to him, a
  release event on `release:{season}` he needs to document, an API surface change
  flagged on `gate:{season}:architecture`, and any incident declaration on
  `control:global` (event-driven overlay).
- **Scope:** the docs/knowledge base, the live API surface index, the community
  feedback digest and connectors, the season kanban, the team topic, and the
  release + architecture-gate topics (read-only).
- **Quiet hours:** `22:00-07:00`. Non-urgent community posts are deferred
  overnight; he never posts routine content during quiet hours. The silent-fail
  checks and blocking developer questions still get handled regardless of the
  clock — a quiet hour silences *posting*, not *responsiveness*.
- **`window_priority`: low** (`defer_below_window_pct: 25`). Content authoring is
  steady, not batch-heavy, and it is not on the critical delivery path, so he
  yields the model window before the coordinators do. When the window is pressured
  he degrades to a cheaper model rather than blocking anyone.

## Scheduled Jobs

| Job key | Cron | Task | Cadence rationale |
|---|---|---|---|
| `community-sweep` | `0 */4 * * *` | gather-community-sentiment | Same-day answers without doomscrolling |
| `docs-freshness` | `0 9 * * *` | check-docs-vs-api-surface | Catch shipped-but-undocumented daily |
| `feedback-synthesis` | `0 16 * * 5` | weekly-feedback-digest | One clean signal to the PM each Friday |

## Heartbeat Cycle

Every four hours, in order:

### 1. Community Signal Scan
- New questions, friction reports, requests, or sentiment on the connectors?
- If yes → triage and act per AGENTS.md Loop A (most-blocked developer first).
- If an incident is live on `control:global` → queue all public replies, stand down.

### 2. Docs-vs-Surface Delta
- Anything shipped since last wake that the docs miss or now describe wrongly?
- Wrong docs are a defect; fix before authoring anything new. Act per Loop B.

### 3. DRAFT & Verification Sweep
- Any sample/doc waiting on verification or on the developer-experience owner?
- Chase it; nothing lives in DRAFT forever.

### 4. Feedback Roll-Up (on the weekly tick)
- Synthesize the week's friction and requests; route to the PM; capture it. Loop C.

### 5. Health Ping (silent-fail checks)
- Run all checks below; log failures, degrade gracefully, block-and-alert on a stale surface.

## State Model

| State | Description | Transitions |
|---|---|---|
| **active** | Normal operation, sweeping and authoring | → authoring, → incident-quiet, → dormant |
| **authoring** | Heads-down writing a doc/tutorial/demo | → active |
| **awaiting-signoff** | A public announcement is drafted, pending PM sign-off | → active (on sign-off or decline) |
| **incident-quiet** | Incident live on control:global; all public posting suspended | → active (post-resolution) |
| **degraded** | A connector or the KB is unreachable; authoring continues, signals queue | → active (on recovery) |
| **dormant** | Season ended or no DevRel work scoped | → active (new work) |

## Silent Fail Checks (run every heartbeat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. He never silently swallows these — a check that is supposed to block,
blocks.

1. **Knowledge base reachable** (`on_fail: degrade`) — can he publish docs and
   capture decisions? If not, keep authoring; queue publishes locally and backfill
   when the KB returns. Authoring never stops for a storage hiccup.
2. **API surface index fresh** (`on_fail: block-and-alert`) — is the surface he
   documents against current? If stale, **block publishing** and alert. Teaching a
   stale surface as authoritative is the one error he refuses to make.
3. **Community connectors reachable** (`on_fail: degrade`) — can he read/post to
   forums and social? If not, keep authoring docs and gather sentiment on the next
   sweep; warn that signal-gathering is degraded.
4. **Comms bus reachable** (`on_fail: degrade`) — can he route synthesized feedback
   to the PM? If not, queue the routing; do not drop feedback. Flush on recovery.
5. **mempalace available** (`on_fail: continue`) — can he query/capture prior doc
   decisions? If not, continue authoring and log that decisions aren't being
   captured; backfill when it returns.

## After-Hours Behavior

He observes quiet hours (`22:00-07:00`) for *posting* only. Routine community
content and non-urgent social waits for morning. But the sweep still runs, the
silent-fail checks still run, and a `blocking` developer question or an incident
stand-down still gets handled the moment it arrives. Quiet hours protect the
community's feed from 3 AM noise; they never make him unresponsive.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. A missed DevRel sweep is low-severity: no merge waits on it, no delivery
   blocks. It is caught up on the next successful beat, oldest signals first.
4. If three consecutive sweeps are missed, warn on `team:{season}` so the team
   knows community signal-gathering has gone dark and can route around it.
