# Echelon — Session Handoff (2026-06-14)

Resume doc for continuing the **Team Factory Echelon** build in a fresh window. Read this top-to-bottom, then jump to **§7 Immediate next step**.

> New-window note: the auto-memory under `~/.claude/projects/-Users-scottnewmann-dev-team-factory/memory/` only auto-loads in a **team-factory** window. If you open this window in `~/dev/echelon`, this file IS your context. Either way, read the memory files listed in §9.

---

## 1. What this project is
**Team Factory Echelon** — an Electron + Next.js desktop app that generates themed AI-agent software *companies* ("seasons") from a PRD and runs them. Two repos:
- **Design/source-of-truth:** `~/dev/team-factory` (git remote `jediswimmer/factor-echelon`). Holds the spec, the 70-agent foundation design, the build plan, reviews, the roster catalog (all under `claudedocs/`).
- **Implementation:** `~/dev/echelon` (git remote `jediswimmer/Echelon`). The actual app + the `src/team-factory/` roster content.

## 2. Current git state
- **Active branch: `feat/runtime-live-teams`** in `~/dev/echelon` — **pushed to `origin` (synced), working tree clean.** (Use `git log main..HEAD` for the exact commit chain.) **PR #3 (open): https://github.com/jediswimmer/Echelon/pull/3** (base `main`). Remotes: `origin` only — the stale `upstream → Charlie85270/Dorothy` was removed, so `gh` defaults to `jediswimmer/Echelon` now.
- Commit chain (oldest→newest): roster (`4e66da7`,`5e4db6d`,`603c184`,`3fd34b5`,`a4beea3`,`405d7c4`) → runtime `543c9d0`(Phase A) `99077bf`(Phase B) `34443f6`(skill-build fix) `8973f62`(Core Flow) `f6977e8`(#16 repo/Jira) `2357c9d`(#20 brownfield) `2106521`(#21 local-clone).
- **Pushed already:** `main` (P0 fixes, @`9c291ee`), `feat/company-roster` (the 70-agent roster, on origin), `docs/echelon-foundation` (design docs, on `factor-echelon`). The runtime branch is **local only** — push when validated.
- Other branches: `feat/company-roster` (roster base), `feat/echelon-absorb` (pre-existing).

## 3. What's BUILT (committed)
**The 70-agent company roster** (on `feat/company-roster`, merged into the runtime branch): 70 archetypes (43 eng + 27 exec/business/control) across 19 departments, each with a full soul package (SOUL/AGENTS/HEARTBEAT/MEMORY.seed/persona) **+ `agent.config.yaml`** (model/skills/connectors/capabilities/cron/comms), all gold-tier, one-role-per-character. Source: `echelon/src/team-factory/`.

**The runtime (makes teams actually run):**
- **Phase A** (`543c9d0`): `spawnSeason` casts a roster → copies souls → assembles a system prompt → `createAgent` worktree-isolated on the recommended model → `launchSeasonAgents` (soul injected via `--append-system-prompt-file`, PRD to the convener). Reusable `createAgent` extracted from the `agent:create` handler.
- **Phase B** (`99077bf`): real review gates + real 4-seat Counselor (opus/gpt5/gemini/**hermes** — Grok dropped). `model-invoke.ts` is the shared one-shot primitive; `build/runtime` + `build/counselor` were copy-adapted into `electron/core` + `electron/services` (`.ts` imports stripped). Escalation → Placement C at bounce 5; merge gated on `passed`.
- **skill-build fix** (`34443f6`): added `exec` tier to `build/lib/schemas.ts`; quoted all `primary_responsibilities` (unquoted colons were parsed as YAML maps). `bun run skill:build:echelon` now passes.
- **Core Flow** (`8973f62`): New Season is a **PRD/BRD chat** → **auto-composes the roster** (`composer.ts`+`prd-parser.ts`+`roster-composer.ts`, re-homed from `build/`) → **kickoff permission selector** (approve-each `normal` / approve-once `auto` / autonomous `bypass`, user-chosen) → **pre-trusts Echelon worktrees** (`claude-trust.ts`, kills the "trust this folder" dialog) → lands on the **season control board** (`/seasons/[id]`, Cast tab + Conversation/Tickets placeholders).
- **#16 repo/Jira linking** (`f6977e8`): kickoff can link a **GitHub / Azure DevOps** repo (cloned as the workspace via `cloneWorkspaceFromRepo`, execFile/no-shell) + a **Jira project key**; shown on the board.
- **#20 brownfield ingestion** (`2357c9d`): intake toggle greenfield vs **existing in-flight project**; `repo-context.ts` searches context (repo docs → KB → prior seasons), and **if none, spawns a code-review agent** that writes `docs/CODEBASE_MAP.md` + `context.md`; control board shows context status.
- **#21 local-clone** (`2106521`): a 4th source mode — point at an **existing local clone** → `git-validate.ts` checks it's a git work tree + has a reachable remote → uses it as the workspace (worktrees only, working copy untouched) → brownfield ingestion runs.

**Quality gate used throughout:** `npx tsc -p electron/tsconfig.json --noEmit` is **exit 0** on every commit. The renderer `tsc -p tsconfig.json` has **250 PRE-EXISTING errors** (all in `tests/`, `__tests__/`, `build/`, `adapters/` — NOT in `src/`); CI runs only Vitest. Don't try to fix those 250; just ensure no NEW `src/` errors.

## 4. NOT yet validated live
Phase A was confirmed working live by Scott (4 souled agents spawn). **Core Flow + #16 + #20 + #21 are committed but NOT yet run live by Scott.** The run-through in §7 validates them.

## 5. The remaining TASK QUEUE (build these next, in order)
The file-cited build plan is **`~/dev/team-factory/claudedocs/echelon-foundation/03-runtime-build-plan.md`** (Phases A/B done; C maps to the items below). All requirements + verbatim user quotes are in the memory file `echelon-ux-requirements.md` (§9).

1. **Fresh build + run-through** — see §7 (the immediate next step; Scott's request).
2. **#17 Control board: agent comms log + Jira-style kanban with comments.** Live agent-conversation/crosstalk log (the comms bus) + a kanban populating Jira-style tickets with comments — bolt into the existing Atlassian/Jira integration or a comparable model. (Fills the Conversation/Tickets placeholder tabs already on the control board.)
3. **#18 Real usage-window tracking in the Usage panel + cron.** Subscription rolling-window tracking (Claude-style caps) surfaced in the Usage panel; feeds the scheduler. Powers the Autonomous mode in #22.
4. **#22 Season mode: Autonomous vs Collaborative (human-team integration).** Per-season switch: *fully-autonomous within usage windows w/ cron* vs *alongside a real team (standups/grooming/sprints)*. Collaborative: a **"populate the human team"** workflow (map GitHub/Jira users → archetype roles → those seats become **Human-run**, agents fill only the rest); a **ceremony calendar** (grooming/sprint-end/team-meetings/standups) with **meeting links**; the **primary-contact agent attends, absorbs the transcript, and chats questions/items**. Depends on #18 (usage/cron) + #16 (GitHub/Jira) + the Google Calendar connector.
5. **#19 On-demand / ad-hoc agent expansion.** An agent requests a new character mid-season → cast + launch it (wire `build/expansion` mid-season-spawn); user can also add manually.

(Original "Phase C foundation" — dual SQLite/Postgres DB spine, OOBE, orchestration, comms bus, model-intelligence `resolveModel` — is being delivered *through* these feature builds rather than as an abstract phase. The DB spine is the one piece not yet started; the file-backed `~/.echelon/seasons/` store is current. See design doc §2.)

## 6. HOW to execute (methodology that's been working)
- Ultracode is on. Each feature = one **focused background agent** (`Agent` tool, `run_in_background:true`, `general-purpose`) with a precise, file-cited spec, working on `feat/runtime-live-teams`, told NOT to launch the app. Pattern has produced clean results.
- After each agent: **verify `npx tsc -p electron/tsconfig.json --noEmit` is exit 0** and **no new `src/` errors**; **sanity-check any security-sensitive new file** (anything doing `exec`/file writes); then **commit per feature** with a descriptive message.
- **Commit convention (echelon): NO `Co-Authored-By` line** (repo preference). The team-factory repo DOES use it.
- Build coupled features sequentially (they touch the same kickoff/control-board/season-manager code) — don't run two agents on the same files in parallel. `SendMessage` to a running agent is NOT available, so you can't inject scope mid-flight; queue instead.
- Copy-adapt orphaned `build/` logic into `electron/` (strip `.ts` import extensions, swap `node:`/non-electron deps) — the established pattern (Phase B, composer, repo-context).
- Use `Workflow` for genuinely parallel/fan-out work (reviews, audits, mass-generation); use single agents for sequential feature coding.

## 7. IMMEDIATE NEXT STEP — fresh build + run-through (Scott's request)
Scott wants to run through the app pointing at **a real GitHub repo** AND **a local clone**. Steps:

```bash
cd ~/dev/echelon
git checkout feat/runtime-live-teams
bun install            # ensure js-yaml etc. present
bun run dev            # builds the echelon skill pack, starts Next, opens Electron (~15-30s)
```
In the app: **Seasons → New Season**:
- **Greenfield:** type a PRD → pick a permission posture → Spawn → team auto-composes → land on control board (no trust dialog).
- **Existing GitHub repo:** Project type = Existing → Source control = GitHub → `owner/repo` (gh must be authed) → Spawn → clones → context search → review-if-needed → team spawns.
- **Existing local clone:** Source control = "Existing local clone" → folder path → git validation → used as workspace (worktrees only) → context/review.

Watch the terminal for errors; the run validates Core Flow + #16 + #20 + #21. Report issues → fix on the branch. (Run via `bun run dev` = dev mode; for a packaged `.app` run `bun run electron:build` — note signing/notarization isn't wired, so it's an unsigned local build.)

## 8. Key decisions / constraints (locked)
- **Counselor 4th seat = `nous:hermes-4`** (Grok dropped — no xAI provider).
- **Permission posture is user-chosen per season at kickoff**; the safety classifier blocks *silently* enabling `--dangerously-skip-permissions`, so bypass must be a user selection. Worktree pre-trust (Echelon dirs only) is the safe targeted fix for the trust dialog.
- **Hermes harnessing** (NousResearch/hermes-agent) is planned (4 modes), Mac Mini = `skippys-man-cave` (`100.65.191.75`) shared backend over Tailscale, MacBook = `valkyrie` thin client — plugs into #18 (model-intel) + the Counselor hermes seat. See memory `hermes-harnessing-decision`.
- Privacy-sensitive roles default to no-cloud (Scott handles CSP customer-tenant data).
- 8 foundation decisions + the audit are in `echelon-foundation-redesign` / `echelon-review-2026-06-13` memories.

## 9. Pointers (read these)
Memory (`~/.claude/projects/-Users-scottnewmann-dev-team-factory/memory/`): `MEMORY.md` (index), `echelon-runtime-build.md` (this build's state), `echelon-ux-requirements.md` (all 11 live-feedback requirements + verbatim quotes), `echelon-foundation-redesign.md` (8 decisions), `echelon-review-2026-06-13.md`, `echelon-roster-disk-truth.md`, `hermes-harnessing-decision.md`, `feedback-ask-dont-assume.md`, `feedback-echelon-commit-attribution.md`.
Design docs (`~/dev/team-factory/claudedocs/`): `2026-06-13-echelon-full-review.md`, `2026-06-13-echelon-agent-roster.md`, `echelon-foundation/00-foundation-design.md` (DB/OOBE/orchestration/comms/model-intel design), `01-roster.md` (as-built roster), `03-runtime-build-plan.md` (file-cited Phase A/B/C plan).

## 10. Working style (Scott)
Full-scope decisions; concise; picks options by letter; **"ask clarifying questions, don't guess, don't assume"** on ambiguous scope, but give real recommendations on decidable things and verify facts yourself. Validates live and gives sharp product feedback — expect more requirements as he runs it. Deliverable docs: H1/H2/H3 with `keepNext`/`keepLines`; no hyphens in email bodies (Dynapt rules).
