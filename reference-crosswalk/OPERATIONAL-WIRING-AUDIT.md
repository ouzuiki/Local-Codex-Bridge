# Supervisor Operational Wiring Audit

**Status:** OW-1 COMPLETE — OW-2/OW-3 IN PROGRESS  
**Date:** 2026-09-04  
**Baseline:** `3566c36a011e1109ea3de948ed2dad0fb29038c7` (Agent Skills Native Adoption Audit recorded)  
**Purpose:** distinguish policy that merely exists from behavior that is actually on a task execution path, then define the thinnest allowed composition seam.

## Main question

Can the existing P2/P3/REF-05 decisions be used as one operational task plan without introducing a new orchestrator/runtime, duplicating native Agent Skills, or moving existing TencentDB memory ownership casually between layers?

## Current execution ownership

| Concern | Existing implementation | Actually invoked today | Adjudication |
|---|---|---|---|
| Worker eligibility / preference / fallback | `supervisor-policy/policy.mjs` (`selectWorker`) | Not automatically invoked by any Bridge | KEEP; compose above Bridges |
| Active-run / HITL / unknown-ack hold semantics | P2 `selectWorker` | Available to Supervisor policy caller | KEEP |
| Project contract loading | Native Worker loaders (`AGENTS.md`; Claude shim) | Yes when Workers start in project cwd | NATIVE / KEEP |
| Skill discovery / loading | Native Agent Skills | Codex ready; Claude project aliases added; Pi compatibility repaired | NATIVE / ADOPT |
| Skill routing in `context-policy.mjs` | `selectMinimalSkills()` reference/regression policy | Must not become production loader/router | FREEZE AS REFERENCE |
| Memory recall decision | `memory-policy.mjs` | Policy exists; transport is worker-specific | KEEP decision separate from transport |
| Claude memory transport | LClB shared memory hook before spawn + terminal writeback | Yes when enabled/configured by shared contract | EXISTING SEAM |
| Pi memory transport | LPB shared memory hook before start + result writeback | Yes when enabled/configured by shared contract | EXISTING SEAM |
| Codex memory transport | Not present in current LCB `codex_turn` path | Existing historical memory path may be external to LCB; current repo alone cannot prove ownership | DO NOT DUPLICATE WITHOUT EVIDENCE |
| Completion gate | `completion-gate.mjs` | Pure policy, not a daemon/interceptor | KEEP; Supervisor finalization responsibility |
| Registry / orchestrator | Admission policy only | No runtime/service | CORRECT — DO NOT BUILD |

## Confirmed wiring gaps

### OW-G1 — policy composition is fragmented

P2 worker selection, P3 memory decision, project-contract presence, context authority, and native Skill ownership are individually deterministic but had no single callable composition function.

**Impact:** a Supervisor can use all rules correctly, but doing so requires remembering several separate modules and their ordering.

**Decision:** add one pure `buildExecutionPlan()` composition function above Bridges. It may return a plan but may not execute Workers, recall memory, discover Skills, persist state, or own retries.

### OW-G2 — ChatGPT Web cannot be intercepted by repository policy code

Repository policy cannot automatically intercept every ChatGPT Web turn by itself. A future stateless MCP projection could expose the pure composition function if machine-enforced invocation is required, but no daemon/service is justified now.

**Decision:** do not build a Supervisor runtime merely to force invocation. Keep the composition pure and testable; the ChatGPT Supervisor remains the execution caller.

## Memory boundary finding

Do not create a second memory injection path just to make the diagram symmetric.

Current source evidence shows LClB and LPB own explicit shared-memory hooks. Current LCB source does not show an equivalent hook, while previously validated Codex↔TencentDB workflows may use a seam outside LCB. Therefore this audit does **not** move TencentDB into LCB and does **not** add Supervisor-side recall that could duplicate an existing external path.

`buildExecutionPlan()` may state that recall is required; the caller must satisfy that requirement through the already-authoritative worker/external memory seam for that execution environment.

## OW-2 allowed scope

```text
Task requirements
      ↓
P2 selectWorker()
      ↓
project-contract / conflict checks
      ↓
P3 evaluateRecallPolicy()
      ↓
Native Agent Skills ownership declaration
      ↓
ExecutionPlan (data only)
      ↓
Supervisor invokes selected existing Bridge
```

The composition must remain:

- pure;
- non-persistent;
- non-executing;
- worker-neutral at the decision layer;
- explicit that native Workers own Skill discovery/loading;
- explicit that memory decision and memory transport are different concerns.

## Prohibited expansion

OW work is not permission to add:

- Worker Registry service;
- orchestrator daemon;
- workflow DB/queue;
- Supervisor session runtime;
- universal context loader;
- production Skill router/scanner;
- duplicate TencentDB recall path;
- cross-Bridge router.

## OW-1 result

```text
architecture_gap                 NO
policy_composition_gap           YES → OW-2 minimal repair
new_runtime_required             NO
new_registry_required            NO
new_skill_router_required        NO
memory_ownership_migration       NO
```

OW-1 is complete. OW-2 is limited to the pure execution-plan composition and deterministic regression.
