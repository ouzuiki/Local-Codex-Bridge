# Supervisor Operational Wiring Closeout

**Status:** CLOSED — PURE COMPOSITION OPERATIONAL; MACHINE-ENFORCED WEB INTERCEPTION ADMISSION-GATED  
**Date:** 2026-09-04  
**Audit:** `OPERATIONAL-WIRING-AUDIT.md`  
**Native Skill dependency:** `AGENT-SKILLS-NATIVE-ADOPTION-CLOSEOUT.md`

## Goal

Turn the already-frozen P2/P3/REF-05 rules into one usable Supervisor task-planning seam without introducing a fourth agent runtime, Registry, workflow daemon, universal context loader, production Skill router, or duplicate memory path.

## Final execution model

```text
Task
  ↓
buildExecutionPlan()
  ├─ P2 selectWorker()
  ├─ active/HITL/unknown-ack hold semantics
  ├─ project-contract presence/conflict checks
  ├─ P3 evaluateRecallPolicy()
  ├─ native Agent Skills ownership declaration
  └─ context authority/evidence declaration
  ↓
ExecutionPlan (data only)
  ↓
ChatGPT Supervisor invokes selected existing Bridge
  ↓
Claude / Codex / Pi native harness
  ├─ native AGENTS/project context
  ├─ native Agent Skills
  └─ existing authoritative memory transport when configured
  ↓
Supervisor verification
  ↓
P3 Completion Gate
```

`buildExecutionPlan()` does not execute this graph. It composes policy and returns data; the Supervisor remains the execution owner.

## OW-1 — Operational Wiring Audit

**Result:** PASS.

The audit distinguished policy that exists from behavior already invoked on real paths:

- P2 Worker selection is deterministic policy and belongs above Bridges.
- AGENTS/project context is already Worker-native.
- Agent Skills are now Worker-native and operational after the native adoption closeout.
- REF-05 `selectMinimalSkills()` remains reference/regression only; it is not the production router.
- Memory recall policy is a decision seam, while memory transport remains environment/worker-specific.
- LClB and LPB have explicit shared-memory hooks; current LCB source does not prove equivalent in-bridge ownership, so this work did not add a duplicate Codex memory injection path.
- P3 Completion Gate remains the final close authority.
- No Registry or orchestration runtime is required.

Confirmed wiring gap: the policy pieces lacked one canonical composition function.

## OW-2 — Minimal Supervisor Policy Composition

**Result:** PASS.

Added:

```text
supervisor-policy/execution-plan.mjs
supervisor-policy/execution-plan.test.mjs
```

The production composition deliberately uses existing policy rather than reproducing it:

```text
selectWorker()
+ evaluateRecallPolicy()
+ project-contract/conflict checks
+ CONTEXT_AUTHORITY
+ native Skill ownership declaration
```

It explicitly does **not**:

- invoke a Bridge or Worker;
- contact TencentDB;
- discover/rank/read/load Skills;
- persist task/session/workflow state;
- retry or route between active runs;
- create a Registry or daemon.

The resulting Skill plan is intentionally:

```json
{
  "owner": "native_worker",
  "discovery": "native_agent_skills",
  "supervisor_router": false
}
```

Permanent regression covers quality/economy selection, active HITL hold, unknown mutation acknowledgement reconciliation, project-contract blockers, task/contract conflicts, memory recall requirements, native-session recall suppression, and no-worker fail-closed behavior.

## OW-3 — End-to-End Contract Smoke

### Deterministic control path

**Result:** PASS after fixture correction.

Permanent `supervisor-policy/operational-smoke.test.mjs` exercises:

```text
Task
→ buildExecutionPlan
→ P2 Worker selection
→ memory/context/native-Skills plan
→ independently verified execution evidence fixture
→ existing P3 final Completion Gate
→ close_task
```

The first run intentionally failed because the smoke supplied an invalid P3 memory evidence state (`assessed`). P3 correctly failed closed. The fixture was corrected to the existing canonical `memory=not_needed`; Completion Gate code and semantics were not weakened.

### Live native harness evidence

The Agent Skills closeout independently exercised real native CLIs/harnesses:

- Codex app-server native `skills/list`: PASS for all four project Skills.
- Claude Code `2.1.259`: PASS for native project Skill context advertisement through Git symlink aliases, using a local mock Anthropic endpoint only to avoid external model credentials.
- Pi `0.84.4` real RPC `get_commands`: PASS through LPB's repaired native `resources_discover` seam.

These runs validate real harness loaders. They do not pretend that an external paid model semantically selected a Skill when no paid model was invoked.

### Full ChatGPT Web → installed local Bridge → paid model turn

**Status:** NOT EXECUTABLE FROM THIS TOOL SURFACE; NOT CLAIMED AS RUN.

The user's Local Codex / Pi / Claude Bridge apps are installed in ChatGPT, but their invokable tool namespaces were not exposed to this execution harness. The task therefore did not fabricate a local real-model turn.

This is an execution-surface limitation of this closeout session, not evidence that the Bridge runtime is broken. Prior P0-P3/tri-bridge real execution evidence remains authoritative for those runtime seams; this closeout adds the new policy/native-Skill evidence described above.

## Machine-enforced preflight boundary

A repository pure function cannot intercept every ChatGPT Web message by itself.

Making preflight machine-mandatory for every future Supervisor execution would require one of:

1. a new stateless Supervisor Policy MCP/adapter callable by ChatGPT before Bridge start; or
2. changing all Bridge start contracts to require a preflight artifact/token.

Neither is justified by current evidence. Option 1 adds a fourth operational service/tool surface; option 2 pushes Supervisor policy into Worker adapters and risks violating the thin-Bridge contract.

Therefore this closeout does **not** claim that ChatGPT Web is technically prevented from skipping preflight. Instead it establishes one canonical deterministic composition seam and freezes an admission gate for stronger enforcement.

### Admission triggers for a future stateless Supervisor Policy Adapter

Evaluate such an adapter only if one or more become real requirements:

- repeated observed Supervisor policy misses in production work;
- multiple Supervisor clients need the same machine-enforced preflight;
- audit/compliance requires proof that every execution passed preflight;
- non-ChatGPT programmatic callers need the same Worker/context gate.

If adopted, the adapter must remain stateless: no DB, session store, queue, agent loop, workflow executor, retry engine, or Bridge routing ownership.

## Memory boundary

This work intentionally did not make the diagram artificially symmetric.

`buildExecutionPlan()` may state that advisory recall is required, but it does not perform recall. The caller must satisfy that requirement through the authoritative memory transport already configured for that execution environment. This prevents the operational wiring layer from injecting the same TencentDB context a second time.

## Final scope audit

Added/changed in the canonical architecture repo:

```text
supervisor-policy/execution-plan.mjs
supervisor-policy/execution-plan.test.mjs
supervisor-policy/operational-smoke.test.mjs
package.json test entry
reference-crosswalk/OPERATIONAL-WIRING-AUDIT.md
reference-crosswalk/OPERATIONAL-WIRING-CLOSEOUT.md
```

Not added:

```text
Supervisor daemon
Registry service
orchestrator runtime
workflow/session DB
queue
universal context loader
production Skill router
cross-Bridge router
duplicate memory hook
```

## Final status

```text
OW-1 Operational Wiring Audit              CLOSED / PASS
OW-2 Minimal Policy Composition             CLOSED / PASS
OW-3 deterministic control-path smoke       CLOSED / PASS
native harness Skill loader smoke           CLOSED / PASS
full local paid-model turn this session     NOT CLAIMED / TOOL-SURFACE UNAVAILABLE
machine-enforced Web interception            DEFERRED BY ADMISSION GATE

new runtime                                 0
new daemon                                  0
new Registry                                0
new Skill router                            0
new memory transport                        0
blocking code gaps                          0
unknown code gaps                           0

OPERATIONAL WIRING: CLOSED
```

The system now has one deterministic operational planning seam. Stronger automatic enforcement is a future adoption decision, not a reason to turn the current Supervisor policy into a fourth runtime.
