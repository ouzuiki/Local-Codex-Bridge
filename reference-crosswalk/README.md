# Tri-Bridge External Reference Crosswalk

**Status:** REF-P0 validation workspace  
**Audit date:** 2026-09-04  
**Canonical system baseline:** `550796c03054369b5ac96ba7cad8b3851a2ca2a5` (`P3 CLOSED`)  
**Purpose:** validate the existing P0-P3 architecture against mature agent/runtime frameworks without importing their runtime complexity by default.

## Scope

This workspace implements the ordered validation sprint:

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

## Adjudication vocabulary

Every finding uses exactly one primary classification:

- `MATCH` — materially equivalent semantic responsibility.
- `OURS_STRONGER` — our current contract is stricter for the relevant safety/correctness property.
- `REFERENCE_STRONGER` — reference framework has a stronger capability; this is not automatically a gap.
- `INTENTIONAL_ASYMMETRY` — difference is deliberate because native Worker capabilities differ.
- `CONFIRMED_GAP` — a required current semantic is missing or incorrect.
- `NOT_APPLICABLE` — reference capability is outside current requirements/boundaries.
- `UNKNOWN` — insufficient evidence; must be resolved before closeout.

A `CONFIRMED_GAP` is the only classification that automatically opens a repair decision. A richer reference-framework feature does not.

## Reference evidence snapshot

Official/reference sources reviewed on 2026-09-04:

- OpenAI Agents SDK — Human-in-the-loop: `https://openai.github.io/openai-agents-js/guides/human-in-the-loop/`
- OpenAI Agents SDK — Running agents / RunState / streaming.
- Strands Agents — Agent Loop: `https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/`
- Strands Agents — Hooks: `https://strandsagents.com/docs/user-guide/concepts/agents/hooks/`
- Strands Agents — Interrupts: `https://strandsagents.com/docs/user-guide/concepts/interrupts/`
- Microsoft Agent Framework — Workflow concepts: `https://learn.microsoft.com/en-us/agent-framework/concepts/workflows/`
- Microsoft Agent Framework — HITL and checkpoints.
- Anthropic `commerce-agents` — core/runtime split and cross-runtime safety gates: `https://github.com/anthropics/commerce-agents`

## Baseline discipline

The canonical P0-P3 system definition is frozen at the LCB commit above. Worker repositories are inspected at their current P1-conformant implementation state. Any REF repair is recorded separately as a post-baseline repair and cannot be used to rewrite history about what the audit originally found.

## Repair rule

Crosswalk work is read-only by default. If a `CONFIRMED_GAP` is found:

1. prove it against current implementation evidence;
2. classify ownership (`Supervisor`, `Bridge`, `Native Worker`, `External Infrastructure`);
3. make the smallest compatible repair at that seam;
4. add a deterministic regression where feasible;
5. run the repository's permanent CI;
6. update the finding to `REPAIRED` without changing its original classification.

Do not use a crosswalk as permission for opportunistic refactors or framework adoption.
