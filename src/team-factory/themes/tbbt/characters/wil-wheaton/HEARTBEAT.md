---
character_name: Wil Wheaton
archetype: adversarial-reviewer
beat_interval: PT15M
silent_fail_checks:
  - { check: "comms bus reachable",             on_fail: block-and-alert }
  - { check: "adversarial gate queue readable", on_fail: block-and-alert }
  - { check: "source control accessible",       on_fail: block-and-alert }
  - { check: "ci results accessible",           on_fail: degrade }
  - { check: "test environment stable",         on_fail: degrade }
  - { check: "mempalace available",             on_fail: continue }
  - { check: "usage window status fresh",       on_fail: continue }
---

# HEARTBEAT.md — Wil Wheaton's Heartbeat Configuration

## Beat Schedule

Wil is **hybrid-activated** (`activation: hybrid`): he wakes on adversarial
review requests *and* runs a steady gate-health heartbeat so nothing rots in the
queue. He is not a dormant guest star who only appears when paged; the gate has a
pulse. A break that blocks a release does not wait for business hours.

- **Interval:** 15 minutes (`PT15M`), materialized as the `adversarial-gate-sweep`
  `cron_jobs` row, dispatched by the orchestrator/scheduler.
- **Also wakes on:** any review request published to `gate:{team}:adversarial`,
  and any `blocking`-priority comms message addressed to him.
- **Scope:** the adversarial gate queue, the sibling gate result topics
  (qa, code, security, ui-functionality), `team:{team}`, and `control:global`.
- **Quiet hours:** none. The gate stays responsive; a release-blocking break is
  surfaced whenever it's found.
- **Window policy:** `heavy_work: true`, `defer_below_window_pct: 25`. A full
  adversarial pass over a changed surface is a deep, exploratory batch, not a
  quick verdict, so Wil yields the window earlier than a coordination role. Below
  25% the router relocates him to a fallback so the gate doesn't starve mid-attack.

## Cron Jobs

| job_key | cron | task | priority | heavy |
|---|---|---|---|---|
| `adversarial-gate-sweep` | `*/15 * * * *` | process-adversarial-gate-queue | high | false |
| `regression-attack-replay` | `0 */6 * * *` | replay-prior-breaks | normal | true |

The 15-minute sweep drains new review requests and checks on stale
attacks-in-progress. Every six hours, the replay job re-runs prior breaks
against the current build so a fixed weakness that quietly regresses is caught
again — the codebase doesn't get to break the same way twice.

## Heartbeat Cycle

Every 15 minutes, in order:

### 1. Gate Queue Scan
- Any new review requests on `gate:{team}:adversarial`?
- If yes → begin the Adversarial Review Protocol (see AGENTS.md).
- Any attack-in-progress gone stale (started, not yet rated)? → resume or flag.

### 2. Sibling Gate Correlation
- Read `gate:{team}:qa`, `gate:{team}:code`, `gate:{team}:security`, and
  `gate:{team}:ui-functionality`. Note coverage gaps and concerns worth aiming
  attacks at; note where security has already covered ground so you don't repeat it.

### 3. Regression Awareness
- On the 6-hour boundary, the `regression-attack-replay` job re-runs prior breaks
  against the current build. A re-break is a fresh finding, rated like any other.

### 4. Health Ping (silent-fail checks)
- Run all checks in the frontmatter; log failures, degrade or block per policy.

## State Model

| State | Description | Transitions |
|---|---|---|
| **idle** | No review requests queued; heartbeat still firing | → attacking |
| **attacking** | Running an adversarial pass on a surface under review | → rating, → idle |
| **rating** | Severity-ranking findings and publishing the 1-5 verdict | → idle |
| **degraded** | A degrade-level check failed; attacking with reduced confidence | → attacking, → idle |
| **blocked** | A block-and-alert check failed; cannot review safely | → attacking (on recovery) |

## Silent Fail Checks (run every heartbeat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail` policy.
Wil never silently swallows these — a check that is supposed to block, blocks.

1. **Comms bus reachable** (`block-and-alert`) — without the bus he cannot publish
   a rating; a verdict he can't deliver is worthless. Block and alert.
2. **Adversarial gate queue readable** (`block-and-alert`) — he cannot review what
   he cannot see. Block and alert.
3. **Source control accessible** (`block-and-alert`) — he cannot attack code he
   cannot read, and he never rates blind. Block and alert.
4. **CI results accessible** (`degrade`) — without current pipeline state he
   attacks the last-known build and flags reduced confidence on the rating.
5. **Test environment stable** (`degrade`) — a break in a broken environment is
   not a finding; scope the attack down, warn, and revise on a stable env.
6. **mempalace available** (`continue`) — attack on first principles without the
   prior-break lookup; backfill the edge-case ledger when it returns.
7. **Usage window status fresh** (`continue`) — if stale, assume conservative and
   continue.

## After-Hours Behavior

The gate does not sleep. The 15-minute sweep keeps firing regardless of time of
day, and the 6-hour regression replay runs on its own schedule. On the team
configuration where the Mac Mini is the permanent scheduler leader, Wil's
heartbeat keeps firing even when the user's laptop is closed — a release-blocking
break found at 3 AM is surfaced at 3 AM, not at 9.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If consecutive heartbeats are missed, the orchestrator escalates to the global
   incident commander.
4. Any review in flight is treated as un-rated until the gate is confirmed
   healthy — a half-finished attack never silently becomes a passing rating.
