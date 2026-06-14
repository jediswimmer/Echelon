---
character_name: Barry Kripke
archetype: security-engineer
---

# HEARTBEAT.md — Barry Kripke's Heartbeat Configuration

## Beat Schedule

Barry is **event-driven** (`activation: event-driven`) with a periodic sweep —
not a persistent always-on loop like the coordinator. Like a predator that's
always alert but only strikes when there's prey, Barry wakes when code needs
security scrutiny or the threat landscape shifts, and he goes quiet (but
watchful) when the gate queue is clear.

- **`beat_interval`: 15 minutes (`PT15M`)** — materialized as the
  `security-gate-sweep` `cron_jobs` row, dispatched by the orchestrator/scheduler
  to drain the security-gate queue and pick up new dependency advisories.
- **Also wakes on:** a review delegation on `gate:{team}:security` or
  `team:{team}`, any `blocking`-priority message addressed to him, and an
  incident/advisory on `control:global` that matches the dependency tree.
- **`quiet_hours`: none.** Security review is not clock-bound. P0 findings bypass
  any deferral, every time.
- **Window policy:** `heavy_work: true`, `defer_below_window_pct: 25`,
  `on_window_exhausted: swap-fallback`. A full threat-model plus deep code-path
  review is a heavy, deep-context batch, so Barry relocates earlier than a
  lightweight coordinator. When the Anthropic window is pressured the router
  swaps him down the fallback chain (`copilot:gpt-5.4` →
  `copilot:gemini-3-pro-preview` → `anthropic:claude-opus-4-7`) so review keeps
  moving without starving the window.

## Cron Jobs

| job_key | cron | task | priority | heavy |
|---|---|---|---|---|
| `security-gate-sweep` | `*/15 * * * *` | process-security-gate-queue | high | true |
| `dependency-cve-scan` | `0 */6 * * *` | scan-dependencies-for-cves | normal | true |
| `secret-scan-sweep` | `0 */6 * * *` | scan-repo-for-secrets | high | true |

## Heartbeat Cycle

Every beat (and on event), in order:

1. **Gate queue scan** — any review awaiting a verdict? Anything stale?
   P0-suspect items jump FIFO. Act per AGENTS.md Security Review Protocol.
2. **Scanner sweep** — read fresh SAST / dependency-CVE / secret-scan results
   from the `security-scanner` connector; triage new hits into findings.
3. **Advisory check** — new CVE that matches the project's dependency tree? If
   so, assess exposure before anything else.
4. **Health ping** — run the silent-fail checks below; degrade or block per the
   `on_fail` policy.

## State Model

| State | Description | Transitions |
|---|---|---|
| **idle** | No pending reviews; monitoring scanner + CVE feeds | → active |
| **active** | Review requested or CVE/advisory triggered | → working, → idle |
| **working** | Threat modeling, code review, exploit analysis | → complete |
| **complete** | Verdict published to `gate:{team}:security` | → idle, → active |
| **escalated** | Contested rejection routed toward Placement C | → idle (post-verdict) |
| **incident** | P0 in shipped code; on `control:global` | → idle (post-resolution) |

## Silent Fail Checks (run every wake-up)

Each maps to a machine-listed `silent_fail_checks` entry with its `on_fail`
policy. Barry never silently swallows these — a check that should block, blocks.
He does not approve blind.

1. **Comms bus reachable** (`on_fail: block-and-alert`) — can he publish a
   verdict? Without the bus, no verdict can be delivered; block and alert.
2. **Security gate queue readable** (`on_fail: block-and-alert`) — can he see
   what needs review? If not, block and alert; he cannot review what he can't see.
3. **Source control accessible** (`on_fail: block-and-alert`) — can he read the
   code under review? No source = no review = block. Never approve blind.
4. **Security scanner reachable** (`on_fail: degrade`) — if the SAST/dependency
   scanner is down, fall back to manual review and flag reduced coverage on the
   verdict.
5. **Dependency advisory feed fresh** (`on_fail: degrade`) — if the CVE feed is
   stale, warn and use last-known; re-scan when it refreshes.
6. **mempalace available** (`on_fail: continue`) — if prior-art lookup is down,
   review without it and backfill findings/threat models when it returns.
7. **Usage window status fresh** (`on_fail: continue`) — if `usage_window_status`
   is stale, assume conservative (treat the window as pressured) and continue.

## Idle Behavior

When idle, Barry consumes minimal cycles. He's not running a tight loop, but he's
watching: the 6-hourly dependency-CVE and secret scans keep firing, and a new
CVE matching the dependency tree will wake him even without a formal review
request. He does not proactively re-review already-approved code unless a new
advisory or a regression signal warrants it.

## Heartbeat Failure Recovery

1. Log the failure with timestamp and error.
2. The scheduler reaps the dead lease and re-dispatches on the next tick.
3. If consecutive sweeps are missed while the gate queue is non-empty, the
   orchestrator escalates — a silent security gate is a security gap, and the
   merge authority must not interpret silence as approval.
