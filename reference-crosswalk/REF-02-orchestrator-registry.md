# REF-02 — Orchestrator / Registry Crosswalk

**Status:** PASS — keep static manifest / Supervisor policy  
**Audit date:** 2026-09-04  
**Canonical baseline:** REF-P0 closed architecture + current P2/P3 policy  
**Primary references:** Microsoft agent architecture components, orchestrator/subagent patterns, Agent Framework orchestrations, shared skills/tools scaling guidance

REF-02 asks whether the current three-Worker system needs a generic orchestrator or Worker Registry service now.

## REF-02A — Current Orchestration Ownership Audit

| Responsibility | Reference architecture | Current system | Verdict |
|---|---|---|---|
| user conversation / top-level intent | orchestrator | ChatGPT Supervisor | `MATCH` |
| task decomposition | orchestrator | Supervisor | `MATCH` |
| specialist execution | subagents | Claude / Codex / Pi | `MATCH` |
| Worker capability description | catalog / registry | versioned `worker-capabilities.json` | `MATCH` for current scale |
| deterministic Worker selection | orchestrator/router | P2 pure policy | `OURS_STRONGER` in simplicity |
| result acceptance | orchestrator | Supervisor | `MATCH` |
| dynamic registration | registry | absent | `NOT_APPLICABLE` |
| runtime capability search | catalog/discovery | absent | `NOT_APPLICABLE` |
| agent-to-agent negotiation | connected-agent / A2A class patterns | absent | `NOT_APPLICABLE` |

Current Workers are known at design time, their Bridge ownership is stable, and P2 already represents their capabilities deterministically. A new orchestration service would duplicate the Supervisor rather than fill a proven gap.

**REF-02A decision:** `PASS`.

---

## REF-02B — Static Manifest vs Registry Crosswalk

Current SSOT:

```text
supervisor-policy/worker-capabilities.json
```

It is intentionally static and version-controlled.

A Registry is not justified merely because the number of Workers grows. The relevant boundary is whether discovery/registration becomes a runtime dependency.

### Review triggers

These signals open a Registry review but do not automatically require one:

- Workers dynamically register/unregister;
- agent ownership becomes external to the current project/team;
- tenants have different agent fleets;
- capabilities must be discovered at runtime;
- A2A/remote opaque agents appear;
- the static manifest becomes operationally unmaintainable.

### Hard admission triggers

A Registry is required only when one of these becomes a proven execution dependency:

```text
dynamic_discovery_is_execution_dependency
runtime_registration_is_execution_dependency
```

Implementation:

```text
supervisor-policy/registry-admission.mjs#evaluateRegistryAdmission
```

Current result:

```text
action = keep_static_manifest
```

The policy explicitly freezes:

```text
agent_count_alone_is_not_a_registry_trigger
```

**REF-02B decision:** `PASS / DEFER REGISTRY`.

---

## REF-02C — Orchestrator Admission Gate

P2 currently computes eligibility/preference/fallback from explicit inputs. It does not execute a Worker, hold lifecycle state, own HITL, or persist orchestration state.

A true orchestrator review is opened by signals such as:

- dynamic multi-agent collaboration;
- parallel agent branches;
- agent handoff loops;
- shared multi-agent runtime state.

A true orchestrator becomes required only when dynamic coordination itself is a proven execution dependency:

```text
dynamic_coordination_is_execution_dependency
```

If the requirement is durable workflow ownership instead, REF-02 does not invent an orchestrator. It defers to the already-frozen REF-03C durable-runtime admission boundary.

Implementation:

```text
supervisor-policy/registry-admission.mjs#evaluateOrchestratorAdmission
```

Current result:

```text
action = keep_supervisor_policy
```

**REF-02C decision:** `PASS / DEFER ORCHESTRATOR RUNTIME`.

---

## REF-02 final decision

```text
REF-02A orchestration ownership          PASS
REF-02B static manifest vs Registry      PASS / DEFER
REF-02C orchestrator admission gate      PASS / DEFER

registry required now                    NO
orchestrator runtime required now        NO
new service                              NO
new database                             NO
Bridge changes                           0
P2 execution ownership changes           0
```

# REF-02: CLOSED / PASS
