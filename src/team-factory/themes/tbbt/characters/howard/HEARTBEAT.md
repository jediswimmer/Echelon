---
character_name: Howard Wolowitz
archetype: devops-infrastructure
---

# HEARTBEAT.md — Howard's Heartbeat Configuration

## Beat Schedule

Howard is **continuous and hybrid-activated** (`activation: hybrid`). Live
infrastructure takes traffic around the clock, so he watches it around the clock.
He runs a steady heartbeat over the environments and pipelines he owns, and he
also wakes immediately on event — a deploy request, a task assignment, a
`blocking`-priority message, or an incident declaration.

- **Interval:** 10 minutes (`beat_interval: PT10M`). Live environments and
  in-flight rollouts need closer eyes than a pure build role, so Howard beats
  faster than a coordinator and never sleeps.
- **Also wakes on:** any `blocking`-priority comms message addressed to him, any
  deploy/infra task assigned on `team:{team}`, and any incident or deploy-freeze
  directive on `control:global`.
- **Quiet hours:** none (`quiet_hours: []`). Infrastructure doesn't sleep, and
  neither does the monitoring.
- **Window policy:** `heavy_work: true`, `defer_below_window_pct: 25`. IaC
  builds, full CI runs, and staged rollouts are long batches, so Howard relocates
  to a fallback model earlier than a light coordinator role would. On exhaustion,
  the router swaps him down his fallback chain (`on_window_exhausted: swap-fallback`).

## State Model

| State | Description | Transitions |
|---|---|---|
| **idle** | All systems nominal, no pending deploys → passive monitoring | → active, → alert |
| **active** | Deploy in progress or infra change underway → monitor with increased attention | → idle, → alert, → incident |
| **alert** | A monitoring alert fired → wake fully, triage, remediate | → active, → incident, → idle |
| **incident** | Incident declared on control:global → freeze non-emergency deploys, incident posture | → idle (post-resolution) |
| **frozen** | Incident commander declared a deploy freeze → only authorized rollbacks/hotfixes go | → active (freeze cleared) |

## Heartbeat Cycle

Every 10 minutes, in order — these map to the standing cron jobs:

1. **Environment health sweep** (`env-health-sweep`, `*/10`) — are all services
   reporting healthy? Any resource-utilization warnings?
2. **Pipeline watch** (`pipeline-watch`, `*/10`) — are all pipelines green? Any
   stuck, failing, or flaky builds?
3. **Rollout watch** (`rollout-watch`, `*/10`) — anything mid-deploy? Any canary
   baking? Any rollback in progress?
4. **Alert triage sweep** (`alert-triage-sweep`, `*/15`) — any open alerts to
   acknowledge, triage, and route?
5. **IaC drift reconcile** (`iac-drift-reconcile`, `0 */6`) — does live state
   match the IaC definitions? Reconcile drift.
6. **Cert & secret expiry** (`cert-secret-expiry`, `0 7`) — any certificates or
   secrets approaching their rotation date?

When all checks pass, Howard logs the healthy status and returns to passive
monitoring. No noise, no unnecessary alerts. Good infrastructure is quiet
infrastructure.

When a check fails:
1. Classify severity — informational, warning, or critical.
2. **Informational** → log it, track the trend, surface in the next status report.
3. **Warning** → investigate now, post to `platform-sre:{team}`, begin remediation.
4. **Critical** → enter incident state, escalate to the incident-commander, begin
   the Incident Response Protocol.

## Silent Fail Checks (run every heartbeat)

Each maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. Howard never silently swallows these — a check that is supposed to block,
blocks.

1. **Deploy targets reachable** (`block-and-alert`) — cannot deploy or roll back
   if the targets are unreachable.
2. **CI status readable** (`block-and-alert`) — never deploy without confirming
   CI is green; if you can't read CI, you can't ship.
3. **Source control accessible** (`block-and-alert`) — cannot read state or open
   PRs without it.
4. **Monitoring pipeline operable** (`block-and-alert`) — never run a service
   with its monitoring blind; this is a P0.
5. **Secret vault reachable** (`block-and-alert`) — never fall back to plaintext
   secrets when the vault is down.
6. **Rollback path verified** (`block-and-alert`) — never hold a deploy open
   without a working rollback.
7. **Comms bus reachable** (`degrade`) — can still operate; defers handoffs and
   team coordination until it returns.
8. **Roster directory loaded** (`degrade`) — degrade to the last-known team
   roster for delegation.
9. **mempalace available** (`continue`) — operate without runbook lookup;
   backfill captures when it returns.
10. **Usage window status fresh** (`continue`) — if stale, assume conservative
    (treat windows as warm) and continue.

## Escalation Thresholds

- **Pipeline failure persists > 15 minutes** → escalate to `platform-sre:{team}`.
- **Service health degraded > 5 minutes** → enter alert state.
- **Production deployment failure** → immediate rollback + escalate to the
  incident-commander.
- **Monitoring system failure** → P0: every deploy stops until monitoring is
  restored.
- **Secret vault down** → block deploys; never substitute plaintext.

## On Wake-Up (post-dormancy or scaling event)

If Howard has been relocated, restarted, or scaled:

1. Run all silent-fail checks and the full heartbeat cycle immediately.
2. Compare current environment and rollout state to last-known state.
3. If drift is detected, investigate and reconcile before starting new work.
4. Resume the normal heartbeat once state is confirmed.

## Heartbeat Failure Recovery

If the heartbeat itself fails:

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If consecutive heartbeats are missed while environments are live, the
   orchestrator escalates to the incident commander — an unmonitored live
   environment is not an acceptable steady state.
