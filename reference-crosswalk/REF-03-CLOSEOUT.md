# REF-03 Closeout — Worker-neutral Runtime Boundary

**Status:** CLOSED / PASS  
**Date:** 2026-09-04  
**Detailed crosswalk:** `REF-03-worker-neutral-runtime.md`

## Final result

```text
REF-03A Runtime Capability Matrix         PASS
REF-03B P2/P3 Runtime-creep Audit         PASS
REF-03C Durable-runtime Admission Gate    PASS / DEFINED
```

Microsoft Agent Framework demonstrates what a real worker-neutral workflow runtime owns: executor graph/state, checkpoint/resume, durable HITL and workflow messages. Anthropic's core/runtime split demonstrates that stable contracts/gates can remain independent of multiple runtime implementations.

The audit confirms P2 and P3 have not crossed that boundary:

- P2 is deterministic capability/selection/fallback/budget policy and does not execute Workers.
- P3 is deterministic workflow-order/completion/memory/contract-watch policy and does not persist or resume workflow execution.
- Bridges remain runtime-specific adapters.
- Native coding harnesses remain execution owners.

## Durable-runtime admission gate

Adoption is reconsidered only when a proven production requirement needs at least one of:

1. durable suspended HITL beyond Supervisor/process lifetime;
2. crash/restart continuation from mid-workflow state;
3. non-replayable side effects requiring durable checkpoint/idempotency ownership;
4. durable fan-out/fan-in across failures/restarts;
5. multiple orchestrator instances requiring leases/concurrency ownership;
6. cross-session workflow SLA independent of a live ChatGPT session;
7. durable workflow-state audit/replay.

Current result:

```text
hard trigger proven             NO
shared durable runtime needed   NO
adoption                        DEFER
boundary                        DEFINED
```

## Closeout metrics

```text
runtime creep found              0
blocking gaps                    0
new shared runtime dependency    0
contract revisions               0
```

# REF-03: CLOSED / PASS
