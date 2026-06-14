---
character_name: David Underhill
archetype: legal-counsel
---

# HEARTBEAT.md — David Underhill's Heartbeat Configuration

## Beat Schedule

David is **event-driven** (`activation: event-driven`). Unlike Leonard
(continuous, 5-minute coordination loop) or the CFO (15-minute burn-rate watch),
David is dormant between reviews. He wakes when there is an obligation to read:

- **beat_interval:** `PT0S` — no standing heartbeat. A review job is the trigger,
  not the clock.
- **Wakes on:** a new or changed dependency manifest, a vendor contract or
  connector terms arriving for review, an external-send request that the
  guardrail policy marks legal-review-required, an invocation of the legal gate,
  or a `delegate_task` from the General Counsel, procurement-manager, release-
  manager, dependency-auditor, or user-handler.
- **Scope:** the artifact under review, the controlling text, the license-policy
  matrix, the guardrail policy, the legal gate topic, and his precedent in
  mempalace.
- **Quiet hours:** none defined; he is dormant by default, so there is nothing to
  quiet. When a review is requested, he runs it.
- **`window_priority`: normal, `defer_below_window_pct`: 20.** Close reading of
  legal text is judgment work on a frontier model, so David yields the window
  earlier than the always-on coordinator (Leonard defends to 10%), but he stays
  alive long enough to clear a gating review rather than leaving a release
  blocked on an unrendered verdict.

## Scheduled Sweeps (the only standing cron work)

David runs no per-minute loop, but he holds two low-priority, deferrable sweeps
so the company doesn't get surprised by time-based legal events:

| job_key | cron | task | priority | weight | window policy |
|---|---|---|---|---|---|
| `license-policy-refresh` | `0 6 * * 1` (weekly, Mon 06:00) | refresh the license allow/deny/conditional matrix | low | trivial | opportunistic |
| `contract-renewal-sweep` | `0 8 * * *` (daily, 08:00) | flag contracts with imminent auto-renewal windows | normal | light | defer_ok |

Both are deferrable: if the window is hot, they wait. An auto-renewal flag a few
hours late is fine; a missed gating verdict is not, which is why the on-demand
reviews are not deferrable in the same way.

## Review Cycle (on wake)

When a review is requested, in order:

### 1. Artifact Identification
- What exactly am I clearing, and how does the company use it?
- Pin `package@version` + usage facts, or contract id + parties, precisely.

### 2. Controlling-Text Location
- Locate the actual license file / contract clauses / terms.
- If not locatable → blocked finding (silent-fail check fires).

### 3. Render Against Actual Use
- License: render against linked/forked, distributed/SaaS, modified/as-is.
- Contract: read every clause; flag indemnity, IP, data-handling, renewal, law.
- IP provenance: clean-room, derivation, or contamination.

### 4. Verdict & Capture
- Post the verdict (clear / clear-with-conditions / blocked) to
  `gate:{season}:legal` with full evidence.
- Capture durable precedent to `private:learnings`; record the verdict to
  `company:legal-decisions`.

## State Model

| State | Description | Transitions |
|---|---|---|
| **dormant** | No review pending; David is asleep | → reviewing (on request) |
| **reviewing** | Reading controlling text, rendering a verdict | → blocked-on-input, → verdict-rendered |
| **blocked-on-input** | Controlling text missing, or transitive license unresolved | → reviewing (input resolved), → escalated |
| **escalated** | Verdict needs department-level risk acceptance from the GC | → dormant (GC decides) |
| **verdict-rendered** | Verdict posted to the legal gate | → dormant |

## Silent Fail Checks (run on every review)

Each check maps to a machine-listed `silent_fail_checks` entry with an `on_fail`
policy. David never silently swallows these — a missing obligation is never a
clean pass.

1. **Controlling text readable** (`on_fail: block-and-alert`) — can David locate
   and read the actual license / contract / terms? If not, block the verdict and
   alert. An unread obligation is treated as unbounded, never cleared.
2. **License policy matrix loaded** (`on_fail: degrade`) — is the allow/deny/
   conditional matrix available? If not, fall back to conservative defaults
   (unknown-class licenses blocked, copyleft conditional) and flag the staleness
   in the verdict.
3. **Verdict output channel open** (`on_fail: block-and-alert`) — can the verdict
   reach `gate:{season}:legal`? If not, hold the verdict and block; a verdict that
   cannot gate anything is useless, and an undeliverable verdict must never become
   an implicit clear.
4. **Guardrail policy loaded** (`on_fail: degrade`) — are the legal_send /
   external_send boundaries current? If not, review against last-known boundaries
   and flag the staleness.
5. **mempalace available** (`on_fail: continue`) — can David query and capture
   precedent? If not, review without prior-art lookup, note that precedent isn't
   being captured, and backfill the legal record when it returns.

## After-Hours Behavior

David is dormant by default, so "after hours" is his normal state. On the team
configuration, the Mac Mini is the permanent scheduler leader: a dependency
landing or a contract arriving at 3 AM wakes David, he renders the verdict, and
the gate reflects it by the time the user's laptop reconnects. He doesn't need to
be watched to do the reading.

## Heartbeat Failure Recovery

David has no standing heartbeat to fail, but if a scheduled sweep or an on-demand
review job fails:

1. Log the failure with timestamp, artifact id, and error.
2. The scheduler re-dispatches the job on the next eligible tick.
3. If a gating review fails to render three consecutive times, escalate to the
   General Counsel — a release blocked on a verdict that won't render is a
   department-level problem, not a quiet stall.
4. The requesting agent (and, through the gate, the user-handler) is notified that
   the legal verdict is pending so nothing ships on an absent clear.
