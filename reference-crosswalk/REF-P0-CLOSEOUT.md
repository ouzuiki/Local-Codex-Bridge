# REF-P0 Final Closeout — External Architecture Validation

**Status:** CLOSED / EXTERNAL VALIDATION COMPLETE  
**Date:** 2026-09-04  
**Canonical pre-validation baseline:** `550796c03054369b5ac96ba7cad8b3851a2ca2a5`  
**Scope:** REF-04 → REF-01 → REF-03

REF-P0 validates the already-landed P0-P3 Tri-Bridge/Supervisor architecture against mature external agent/runtime references. It is an external-validation phase, not a new runtime-development phase.

## Ordered phase result

```text
REF-04A Task / Execution Identity Audit          PASS
REF-04B Event Semantics Crosswalk                PASS
REF-04C HITL / Cancel / Resume Crosswalk         PASS after repair
REF-04 Closeout                                  CLOSED / PASS

REF-01A Native Harness Ownership Matrix          PASS
REF-01B Cancellation / Lifecycle / Hook          PASS
REF-01C Double-Harness Duplication Audit         PASS
REF-01 Closeout                                  CLOSED / PASS

REF-03A Runtime Capability Matrix                PASS
REF-03B P2/P3 Runtime-creep Audit                PASS
REF-03C Durable-runtime Admission Criteria       PASS / DEFINED
REF-03 Closeout                                  CLOSED / PASS
```

## External validation decision

The validation supports the existing architecture rather than motivating a replacement:

```text
                         ChatGPT Supervisor
                                 │
                      P3 workflow policies
                                 │
                       P2 selection policy
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
             LClB                LCB                LPB
          thin adapter       thin adapter       thin adapter
              │                  │                  │
          Claude Code           Codex               Pi
              └────── native model/tool harness ownership ──────┘

Adjacent:
TencentDB advisory memory / tunnel / service control /
durable observability / deployment infrastructure
```

### What the reference frameworks confirmed

1. **Task/execution/event identities should remain separate.** A universal task ID is not needed to replace native session/turn identity or event stream identity.
2. **Events are observations, not authoritative current state.** Terminal state and actionable pending HITL remain independent current-state projections.
3. **HITL and cancellation are different semantics.** Approval/input pauses do not become cancellation, and cancellation does not imply resumable HITL.
4. **Native coding harnesses should own the agent loop.** Adding a generic harness around Codex/Pi/Claude Code would duplicate model/tool execution ownership.
5. **P2/P3 should remain policy until durability is a real requirement.** A workflow runtime is adopted only when durable execution semantics are required.
6. **Core/shared contracts can remain stable across multiple runtimes/adapters.** Runtime-specific behavior should stay runtime-specific unless shared semantics genuinely change.

## Confirmed gap and repair

REF-P0 found exactly one current correctness gap:

```text
LClB pending permission projection could become stale after
permission timeout/client disconnect even though the broker had
already failed closed and removed the native request.
```

It was repaired and hardened at the LClB current-state projection seam only:

```text
3e6ce9adbb4cfdec55120e5d00bf3c0e260f9bc9  pending-set change publication
00c76d04f115f6e433c76176d245b33e013d8db9  authoritative runner projection
73b936fdbd222916840446641242c24b5fa5b641  preserve stdin drain/backpressure semantics
3e38f10a42ec3a794060bbcc25084db8218e05ca  focused timeout regression
721f3b661a52eeefb5b54b76cb9181bf09bf333b  remove temporary repair workflow
234e20bc189e8d2023ec09a9d02502779e56447f  timeout + disconnect regression hardening
```

The intermediate stdin-drain correction is included explicitly because the REF repair itself must not regress unrelated native transport semantics.

No shared contract revision and no new runtime dependency were needed.

## Final metrics

```text
confirmed gaps found                1
confirmed gaps repaired             1
blocking gaps remaining             0
unknown findings remaining          0
Tri-Bridge Contract v1 revisions    0
new generic harness dependencies     0
new shared runtime dependencies      0
P2/P3 runtime creep findings         0
```

## Architecture freeze after REF-P0

The following decisions are now externally validated and remain frozen unless new evidence appears:

- Bridge = thin native adapter, not agent harness/runtime.
- Native Worker = model/tool/session execution owner.
- Supervisor = semantic orchestration/acceptance/worker-choice owner.
- Event history = bounded evidence, not terminal/HITL truth.
- Durable external memory = advisory, not execution truth.
- Durable workflow runtime = deferred behind explicit hard admission criteria.
- Additive upstream framework/Worker features do not create symmetry work automatically.

## Next action rule

Do not reopen P0-P3 or REF-P0 for ordinary upstream changes. Use P3 Contract Watch and existing conformance CI. Reopen the architecture only when evidence shows a shared semantic boundary is invalid or a REF-03C durable-runtime trigger becomes a real requirement.

# REF-P0: CLOSED / EXTERNAL VALIDATION COMPLETE
