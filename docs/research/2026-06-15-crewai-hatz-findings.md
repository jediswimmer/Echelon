# CrewAI & Hatz AI — Competitive Findings vs Echelon

**Date:** 2026-06-15
**Author:** Research pass commissioned by Scott
**Companion artifact:** [`2026-06-15-echelon-crewai-hatz-comparison.xlsx`](./2026-06-15-echelon-crewai-hatz-comparison.xlsx) (+ `.csv`) — the full 64-row feature matrix, build-effort column, prioritized roadmap, and platform profiles.

> **TL;DR.** We are not re-inventing the wheel — Echelon is a genuinely different shape from both competitors, and its signature bets (themed character agents, a 4-model counselor, review gates, multi-target builds, local-first privacy) are things *neither* CrewAI nor Hatz has. The problem is not vision; it's that **several flagship features are stubbed in v0.1** (counselor returns mock verdicts, the 7 review gates are stubs, the knowledge flywheel is half-built). The highest-leverage work is **making what we already designed actually run**, then borrowing three concrete, proven patterns from CrewAI (deterministic Flows, guardrails, an eval loop) and one from Hatz (integration breadth via automation bridges). The big strategic question — whether Echelon ever becomes a hosted/multi-tenant product — gates *all* the enterprise/SSO/SOC2 items and should be a deliberate executive decision, not a drift.

---

## 1. The three products are not the same category

A like-for-like feature checklist is misleading unless you hold this in mind:

| | Echelon | CrewAI | Hatz AI |
|---|---|---|---|
| **Shape** | Local-first desktop app | OSS Python framework + cloud control plane | Closed-source multi-tenant SaaS |
| **Buyer** | Solo dev / small team | Python developers | SMB business users (via MSPs) |
| **Code** | Open (this repo) | Open framework (MIT), closed AMP | Closed (only a beta TS SDK is public) |
| **Money** | Free, BYO keys | Freemium → custom enterprise | Channel-gated credits, no public price |
| **Moat** | Character UX, counselor, portability, privacy | Crews/Flows model + huge community | MSP channel + true white-label multi-tenancy |

**Implication:** Echelon competes with CrewAI on *developer-facing agent orchestration* and overlaps Hatz only on *the enterprise-readiness layer* (auth, tenancy, observability, compliance) — which Echelon does not have today and may not want, given its local-first thesis. Most of Hatz's "enterprise" advantages are downstream of being a hosted SaaS; they don't apply to a desktop app until/unless Echelon ships a hosted edition.

---

## 2. What each competitor does that's genuinely worth stealing

### From CrewAI (the framework lessons)
1. **Crews vs Flows split.** CrewAI cleanly separates *autonomous* role-based teams (Crews) from *deterministic*, event-driven, resumable workflows (Flows: `@start/@listen/@router/@persist`, Pydantic-typed state, `or_`/`and_` combinators, resume + fork). Echelon has the autonomous half (seasons) but no deterministic, inspectable workflow layer. **This is the single most borrowable idea.**
2. **Layered guardrails + typed outputs.** Function-based and LLM-based output validators (chainable, with retry budgets) plus Pydantic/JSON-schema structured outputs. Cheap to add, big reliability payoff.
3. **Hallucination guardrail.** A faithfulness scorer (0–10 vs reference context) that runs automatically before task completion. Drops straight into Echelon's security/quality-gate framing.
4. **Eval + replay loop.** `crewai test` runs a crew N times and LLM-scores per-agent/task; `crewai replay` re-runs from a task. An eval harness would quantify season quality and feed the knowledge flywheel.
5. **Weighted, scoped memory.** Recency/semantic/importance weighting with consolidation/dedup and LLM-inferred scope placement — more sophisticated than flat memory. Upgrade the KB ranking with this math.
6. **Adoption funnel.** Crew Studio (NL → drag-drop → Python export) and a Discovery engine that suggests blueprints from real deployments. The no-code on-ramp is how they reach non-developers.

**But also learn from CrewAI's failures:** its hierarchical manager is its most-criticized feature (poor coordination, 30–50% token overhead, delegation bugs); native observability is weak (everyone bolts on Langfuse/Weave); and 2026 brought real RCE CVEs around code-exec sandbox escape and a historical telemetry/GDPR controversy. Echelon's convener/counselor escalation is arguably a *cleaner* design than CrewAI's manager — don't copy that part.

### From Hatz AI (the enterprise/GTM lessons)
1. **Integration breadth via bridges.** 40+ integrations including deep M365, plus Zapier/Make/n8n as a force-multiplier. The bridge pattern is the cheapest path from ~5 integrations to thousands.
2. **Multi-model gateway with visible cost multipliers.** Their "Mido" gateway brokers providers and shows relative cost per model in the picker — great UX for budget-aware model choice. Pairs perfectly with Echelon's existing budget cap.
3. **Per-tenant templates + community workflow marketplace.** Network effects from partners publishing reusable workflows. Echelon's YAML archetype/theme model is ready-made for a shareable blueprint registry.
4. **Real, certified security posture.** SOC 2 Type I + II + SOC 3, NDA-gated reports, third-party pentests, SAML SSO + SCIM. This is *table stakes the moment Echelon has multiple users on a server* — and Hatz shows the bar is "actually certified," not "claimed" (a jab that lands on CrewAI's unverified claims).
5. **Pooled, per-seat-free pricing.** Removes the per-user adoption tax. Note for any future Echelon team edition.

---

## 3. Where Echelon already wins (protect these)

- **Themed character UX** — recognizable personas with consistent voice/quirks. Neither competitor has anything like it; it's the strongest emotional differentiator.
- **4-model counselor** — multi-provider consensus at high-stakes decisions. Genuinely unique… *once it stops returning mock verdicts.*
- **Author-once, build-to-many** — same team definitions compile to Claude Code plugins, OpenClaw bundles, and Echelon season-packs. A no-lock-in story competitors structurally can't match.
- **Worktree-per-agent isolation** and **multi-season isolation with shared global knowledge.**
- **Local-first privacy** — data never leaves the machine, no telemetry. A clean compliance/marketing angle that sidesteps much of the HIPAA/GDPR question for solo use.
- **Spatial/game UIs** (Pallet Town, 3D AgentWorld) — delightful and demo-able.

---

## 4. The honest gaps (from `docs/CODEBASE_MAP.md`)

These are scored **PARTIAL** in the matrix, not "done," because the code is scaffolded but not functional in v0.1:

- `counselor-service.ts` returns **mock verdicts** — no real fan-out yet.
- The **7 review gates are stubs.**
- `kb promote` is **deferred to v0.5**; mempalace pin is a **placeholder SHA**.
- **No observability/tracing, no human-user RBAC, no auth/SSO, no multi-tenancy, no hosted deployment.**
- Integration breadth is ~5 services vs 23–40+.
- Rebrand leftovers (window title "Dorothy", Dorothy-branded `landing/`).

---

## 5. Recommended sequence (see "Build Roadmap" tab for effort + dependencies)

**P0 — make the vision real (weeks, not months):**
1. Wire the **Counselor** to real parallel multi-model fan-out + aggregation. *(M, ~1–2 wks; keys already wired.)*
2. Implement the **7 review gates** for real, including a CrewAI-style **faithfulness scorer** on the security gate. *(L.)*
3. Realize the **knowledge flywheel** (capture-on-merge + retrieve-before-task), borrowing CrewAI's weighted/scoped memory ranking. *(L.)*

**P1 — close the framework gap with CrewAI:**
4. A deterministic **workflow layer** (Flows-equivalent) above seasons. *(L.)*
5. **OpenTelemetry tracing + an ops dashboard** — the biggest enterprise gap and the foundation for cost analytics + audit. *(XL.)*
6. **Programmatic + LLM output guardrails and typed outputs.** *(M.)*
7. **OAuth connector framework + Zapier/Make/n8n bridge** to leapfrog integration breadth. *(L.)*

**P2 — differentiation & adoption:** agent eval harness (L), multi-format + audio ingestion (M), shareable blueprint registry (L), visual no-code season/flow builder (XL).

**STRATEGIC fork:** Multi-tenancy, SSO/SCIM, SOC 2, and on-prem/VPC (the CrewAI Factory / Hatz tenant model) **all hinge on one decision** — does Echelon ship a hosted/team edition? That contradicts the current local-first, free, BYO-keys thesis. It should be chosen deliberately. Until then, treat every "enterprise auth/tenancy/compliance" gap as *intentionally deferred*, and lead with local-first privacy as the counter-positioning.

---

## 6. Sources

**CrewAI:** github.com/crewAIInc/crewAI · docs.crewai.com (concepts/flows, processes, memory, knowledge, tasks, cli, training, planning; enterprise/introduction, features/sso, features/hallucination-guardrail, features/integrations; observability/overview) · crewai.com/agent-management-platform · blog.crewai.com · pricing pages · plus criticism sources (Towards Data Science hierarchical teardown, markaicode LangGraph benchmark, Cyata CVE-2026-2275/2285/2286/2287 disclosure, HN telemetry thread).

**Hatz AI:** hatz.ai (/, /en/msps, /en/partners, /universal, /security, /credit-usage-faq) · docs.hatz.ai (integrations list, SSO/SAML/SCIM, ChatGPT MSP battlecard) · hatz-ai.canny.io/changelog · github.com/Hatz-AI (hatz-ai-typescript, remote-mcp-server) · PR Newswire seed-round release · Crunchbase · third-party reviews (rallied.ai, aiagentsquare.com, allcareit.com).

**Echelon:** `docs/CODEBASE_MAP.md`, `docs/positioning/*`, `docs/specs/2026-04-08-factor-echelon-design.md`, repo `main` @ v0.1.0.
