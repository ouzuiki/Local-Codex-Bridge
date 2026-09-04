# Tri-Bridge External Reference Crosswalk

**Status:** REF-P0 CLOSED; REF-P1 CLOSED; Agent Skills Native Adoption CLOSED; Supervisor Operational Wiring CLOSED  
**Audit date:** 2026-09-04  
**Original P0-P3 validation baseline:** `550796c03054369b5ac96ba7cad8b3851a2ca2a5` (`P3 CLOSED`)  
**Purpose:** validate and harden the existing P0-P3 architecture against mature agent/runtime references without importing framework complexity by default.

## Closed validation phases

### REF-P0 — execution / harness / runtime boundary

```text
REF-04 Task / Event / HITL
        ↓
REF-01 Native Harness Boundary
        ↓
REF-03 Worker-neutral Runtime Boundary
        ↓
REF-P0 Final Closeout
```

Canonical closeout: `REF-P0-CLOSEOUT.md`.

### REF-P1 — orchestration / registry / context / Skill boundary

```text
REF-02 Registry / Orchestrator Admission
        ↓
REF-05 Context / Skill Boundary
        ↓
REF-P1 Final Closeout
```

Canonical closeout: `REF-P1-CLOSEOUT.md`.

## Post-REF-P1 native adoption

The discovery-time audit is preserved in `AGENT-SKILLS-NATIVE-ADOPTION-AUDIT.md`. It intentionally records the LPB gap as it was found. The repaired/final state is authoritative in `AGENT-SKILLS-NATIVE-ADOPTION-CLOSEOUT.md`.

Final native Skill ownership:

```text
Agent Skills / SKILL.md               ADOPT
pet-hotel-manager `.agents/skills`    shared Skill-content SSOT
Codex Skill routing/loading           native
Claude Skill routing/loading          native via `.claude/skills` symlink aliases
Pi Skill routing/loading              native via repaired LPB resource compatibility
Supervisor production Skill router    DO NOT BUILD
```

The original LPB `--no-skills` / read-scope compatibility finding was repaired without enabling ambient Skill discovery: LPB keeps `--no-skills`, publishes only the canonical project `.agents/skills` root through Pi's native `resources_discover` seam, and permits read-only procedure access to that root while leaving mutation authority unchanged.

REF-05 `skill-catalog.json` and `selectMinimalSkills()` remain schema/regression/reference mechanisms. They are not the production Skill discovery/loading owner and must not grow into a Skill Registry, filesystem scanner, semantic router, synchronizer, or content loader.

## Supervisor operational wiring

`OPERATIONAL-WIRING-AUDIT.md` distinguishes policy existence from real execution ownership. `OPERATIONAL-WIRING-CLOSEOUT.md` records the final implementation.

The new canonical composition seam is:

```text
Task
  ↓
buildExecutionPlan()
  ├─ P2 selectWorker()
  ├─ active/HITL/unknown-ack control state
  ├─ project-contract/conflict checks
  ├─ P3 evaluateRecallPolicy()
  ├─ native Agent Skills ownership
  └─ context authority/evidence
  ↓
ExecutionPlan (data only)
  ↓
ChatGPT Supervisor invokes selected existing Bridge
  ↓
Native Worker
  ↓
Supervisor verification
  ↓
P3 Completion Gate
```

`buildExecutionPlan()` is deliberately pure and non-executing. It does not invoke Bridges, contact TencentDB, load Skills, persist workflow state, retry, or route active runs.

Machine-enforced interception of every ChatGPT Web execution is **not** claimed. A repository function cannot intercept the Web Supervisor by itself. A future stateless Supervisor Policy Adapter is admission-gated and should be evaluated only after real policy misses, multi-Supervisor enforcement needs, compliance requirements, or non-ChatGPT programmatic callers prove the need. It must not become a fourth runtime.

## Adjudication vocabulary

Every finding uses exactly one primary classification:

- `MATCH` — materially equivalent semantic responsibility.
- `OURS_STRONGER` — our current contract/policy is stricter for the relevant property.
- `REFERENCE_STRONGER` — reference framework has a stronger capability; this is not automatically a gap.
- `INTENTIONAL_ASYMMETRY` — difference is deliberate because native Worker capabilities differ.
- `CONFIRMED_GAP` — a required current semantic is missing or incorrect.
- `NOT_APPLICABLE` — reference capability is outside current requirements/boundaries.
- `UNKNOWN` — insufficient evidence; must be resolved before closeout.

A `CONFIRMED_GAP` is the only classification that automatically opens a repair decision. A richer reference-framework feature does not.

## Reference evidence snapshot

Official/reference sources reviewed on 2026-09-04 include:

- OpenAI Agents SDK — Human-in-the-loop / RunState / streaming.
- OpenAI Codex — Agent Skills, app-server Skills APIs, progressive disclosure.
- Strands Agents — Agent Loop / Hooks / Interrupts.
- Microsoft Agent Framework — Workflow concepts / orchestration / HITL / checkpoints.
- Microsoft agent architecture guidance — orchestrator/subagent ownership, catalogs/registries and multi-agent scaling boundaries.
- Anthropic `commerce-agents` — core/runtime split and deterministic gates.
- Claude Code — Agent Skills, project discovery and symlinked Skill directories.
- Pi coding agent — Agent Skills, native resource discovery, RPC commands, progressive disclosure and project-trust semantics.
- Google Agents CLI — Skills and coding-agent integration patterns.

The crosswalk records semantics and ownership, not API-name similarity.

## Frozen operating conclusions

```text
ChatGPT Supervisor
  = task decomposition / semantic orchestration / acceptance / execution caller

buildExecutionPlan()
  = pure Worker/context/memory decision composition

P2 policy
  = deterministic Worker eligibility / preference / fallback

worker-capabilities.json
  = current static Worker capability catalog

registry-admission.mjs
  = future Registry / orchestrator adoption gate

context-policy.mjs
  = context authority / memory / conflict reference policy;
    Skill-selection helpers are not production routing

AGENTS.md / native session / native Agent Skills loader
  = Worker-native context and procedure mechanisms

pet-hotel-manager `.agents/skills`
  = canonical project Skill-content SSOT

TencentDB
  = selective advisory project memory through authoritative existing transports

LCB / LPB / LClB
  = thin native protocol adapters

P3 Completion Gate
  = final task-close authority
```

Do not introduce a Registry service, orchestration runtime, universal context loader, centralized Skill-content store, Bridge Skill router, cross-Bridge router, duplicate memory hook, or Supervisor daemon without a proven admission trigger.

## Baseline discipline

The original P0-P3 system definition was frozen at the baseline above. REF repairs and policies are recorded as post-baseline validation/hardening and cannot be used to rewrite what an earlier audit originally found.

## Repair rule

Crosswalk work is read-only by default. If a `CONFIRMED_GAP` is found:

1. prove it against current implementation evidence;
2. classify ownership (`Supervisor`, `Bridge`, `Native Worker`, `External Infrastructure`);
3. make the smallest compatible repair at that seam;
4. add deterministic regression where feasible;
5. run permanent CI;
6. close the repair without erasing the original finding.

Do not use crosswalk work as permission for opportunistic framework adoption.
