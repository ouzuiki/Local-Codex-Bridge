# Tri-Bridge External Reference Crosswalk

**Status:** REF-P0 CLOSED; REF-P1 CLOSED  
**Audit date:** 2026-09-04  
**Original P0-P3 validation baseline:** `550796c03054369b5ac96ba7cad8b3851a2ca2a5` (`P3 CLOSED`)  
**Purpose:** validate and harden the existing P0-P3 architecture against mature agent/runtime references without importing framework complexity by default.

## Closed validation phases

### REF-P0 — execution / harness / runtime boundary

```text
REF-04A Task / Execution Identity Audit
REF-04B Event Semantics Crosswalk
REF-04C HITL / Cancel / Resume Crosswalk
REF-04 Closeout
        ↓
REF-01A Native Harness Ownership Matrix
REF-01B Cancellation / Lifecycle / Hook Crosswalk
REF-01C Double-Harness Duplication Audit
REF-01 Closeout
        ↓
REF-03A Runtime Capability Matrix
REF-03B P2/P3 Runtime-Creep Audit
REF-03C Durable-Runtime Admission Criteria
REF-03 Closeout
        ↓
REF-P0 Final Closeout
```

Canonical closeout: `REF-P0-CLOSEOUT.md`.

### REF-P1 — orchestration / registry / context / Skill boundary

```text
REF-02A Current Orchestration Ownership Audit
REF-02B Static Manifest vs Registry Crosswalk
REF-02C Registry / Orchestrator Admission Gate
REF-02 Closeout
        ↓
REF-05A Context Layer / Authority Crosswalk
REF-05B Skill Catalog v1
REF-05C Context Selection + Collision Policy
REF-05D Tri-worker Context / Skill Regression
REF-05 Closeout
        ↓
REF-P1 Final Closeout
```

Canonical closeout: `REF-P1-CLOSEOUT.md`.

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
- Strands Agents — Agent Loop / Hooks / Interrupts.
- Microsoft Agent Framework — Workflow concepts / orchestration / HITL / checkpoints.
- Microsoft agent architecture guidance — orchestrator/subagent ownership, architecture components, catalogs/registries and multi-agent scaling boundaries.
- Anthropic `commerce-agents` — core/runtime split and cross-runtime deterministic gates.
- Google Agents CLI — Skills and coding-agent integration patterns.

The crosswalk records semantics and ownership, not API-name similarity.

## Frozen operating conclusions

After REF-P0 + REF-P1:

```text
ChatGPT Supervisor
  = task decomposition / semantic orchestration / acceptance

P2 policy
  = deterministic Worker eligibility / preference / fallback

worker-capabilities.json
  = current static Worker capability catalog

registry-admission.mjs
  = decision gate for future Registry / orchestrator adoption

context-policy.mjs
  = non-executing minimum-context / Skill-selection policy

AGENTS.md / native session / native Skill loader
  = Worker-native context mechanisms

TencentDB
  = selective advisory project memory

LCB / LPB / LClB
  = thin native protocol adapters
```

Do not introduce a Registry service, orchestration runtime, universal context loader, centralized Skill-content store, or Bridge context scanner without a proven admission trigger.

## Baseline discipline

The original P0-P3 system definition was frozen at the baseline above. REF repairs and policies are recorded as post-baseline validation/hardening and cannot be used to rewrite what the audit originally found.

## Repair rule

Crosswalk work is read-only by default. If a `CONFIRMED_GAP` is found:

1. prove it against current implementation evidence;
2. classify ownership (`Supervisor`, `Bridge`, `Native Worker`, `External Infrastructure`);
3. make the smallest compatible repair at that seam;
4. add deterministic regression where feasible;
5. run the repository's permanent CI;
6. update the finding to `REPAIRED` without changing its original classification.

Do not use crosswalk work as permission for opportunistic framework adoption.
