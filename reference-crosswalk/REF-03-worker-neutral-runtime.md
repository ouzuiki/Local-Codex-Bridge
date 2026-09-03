# REF-03 — Worker-neutral Runtime Crosswalk

**Status:** PASS; durable runtime adoption deferred behind explicit admission criteria  
**Audit date:** 2026-09-04  
**Primary references:** Microsoft Agent Framework workflows/checkpoints/HITL; Anthropic `commerce-agents` core/runtime separation

REF-03 asks whether P2/P3 have remained a thin Supervisor policy layer or have silently become a generic worker-neutral execution runtime.

## REF-03A — Runtime Capability Matrix

Microsoft Agent Framework workflows provide a real workflow runtime: executors, edges/conditions, fan-out/fan-in, workflow events, shared state, HITL request/response, checkpoints and resume. Anthropic `commerce-agents` shows a complementary architecture: stable core contracts/gates can run through multiple runtime paths without making core policy itself the runtime.

| Runtime capability | MAF / mature runtime | Current Tri-Bridge system | Verdict |
|---|---|---|---|
| workflow executor graph | yes | none | `NOT_APPLICABLE` |
| edges / fan-out / fan-in scheduler | yes | none | `NOT_APPLICABLE` |
| durable workflow state | yes | none at Supervisor layer | `REFERENCE_STRONGER` / `NOT_APPLICABLE` |
| workflow checkpoint/resume | yes | native Worker session recovery only | `INTENTIONAL_ASYMMETRY` |
| pending HITL checkpoint persistence | yes | bounded current Bridge/native state | `REFERENCE_STRONGER` / `NOT_APPLICABLE` today |
| shared run state across executors | yes | no generic shared runtime state | `NOT_APPLICABLE` |
| workflow event bus | yes | per-Worker bounded event projection | `INTENTIONAL_ASYMMETRY` |
| stable core contracts across runtimes | Anthropic yes | Tri-Bridge Contract v1 | `MATCH` |
| runtime-specific adapters | Anthropic yes | LCB / LPB / LClB | `MATCH` conceptually |
| deterministic safety/business gates outside model discretion | Anthropic yes | Supervisor/Bridge/native safety boundaries | `MATCH` |
| worker-selection policy | orchestrator/runtime can own | P2 pure function | `INTENTIONAL_ASYMMETRY` |
| completion workflow | workflow engine could own | P3 evidence gate | `INTENTIONAL_ASYMMETRY` |
| cross-session project memory | runtime may integrate | TencentDB advisory layer | `INTENTIONAL_ASYMMETRY` |

**REF-03A decision:** Current system does not require or implement a worker-neutral runtime. `PASS`.

---

## REF-03B — P2/P3 Runtime-Creep Audit

### P2

P2 contains:

- a static/versioned capability manifest;
- pure eligibility/preference calculation;
- fallback admission rules;
- budget-signal normalization;
- deterministic tests.

P2 does **not**:

- call/start a Bridge;
- keep task lifecycle state;
- execute retries;
- maintain a worker registry service;
- own pending HITL;
- persist workflow progress.

Verdict: `MATCH` with the frozen Supervisor boundary; no runtime creep.

### P3

P3 contains:

- machine-readable workflow order;
- Completion Gate policy;
- memory recall/record eligibility policy;
- contract drift classifier;
- deterministic regression tests.

P3 does **not**:

- run a background scheduler;
- own executors or edges;
- persist mid-workflow state;
- resume work after process loss;
- dispatch Workers automatically;
- maintain retry queues;
- own durable HITL;
- create a second session/history database.

Verdict: `MATCH` with the frozen Supervisor boundary; no runtime creep.

### Anthropic core/runtime lesson

`commerce-agents` defines core prompt/skills/tool contracts/gates once and supports multiple runtime implementations. Safety gates such as provenance/caps/approval remain at deterministic boundaries across runtime paths, while runtime-specific concerns remain runtime-specific.

Our corresponding rule remains:

```text
Tri-Bridge Contract / Supervisor policy = stable semantics
LCB / LPB / LClB                  = runtime-specific adapters
Codex / Pi / Claude Code           = native execution runtimes
```

This crosswalk strengthens the existing separation rather than motivating a new common runtime.

**REF-03B decision:** `PASS`.

---

## REF-03C — Durable-Runtime Admission Criteria

The absence of a shared durable workflow runtime is correct **until** a requirement appears that pure Supervisor policy + native Worker session recovery cannot safely satisfy.

### Hard admission triggers

A durable runtime should be evaluated/adopted when at least one of the following becomes a real production requirement and cannot be delegated cleanly to a native Worker or existing external service:

1. **Durable suspended HITL** — a workflow must remain paused with actionable pending requests for hours/days after the Supervisor/Bridge process is gone, then resume exactly from that point.
2. **Crash/restart continuation** — machine/process restart must restore a multi-step workflow's intermediate state without restarting from safe input.
3. **Non-replayable side effects** — completed expensive or mutating steps must not be re-executed after crash; progress/checkpoints need durable ownership and idempotency records.
4. **Durable fan-out/fan-in** — parallel branches execute independently and must join reliably after partial failures/restarts.
5. **Multiple orchestrator instances** — more than one Supervisor/runtime process may concurrently claim or resume the same workflow and requires leases/ownership/concurrency control.
6. **Cross-session workflow SLAs** — workflow completion is an independent service obligation rather than something supervised inside a live ChatGPT task/session.
7. **Audit/replay requirement for workflow state** — compliance/operations require reconstructed workflow progress, pending messages and transitions, not just Worker events/results.

### Soft signals that are *not* sufficient alone

Do not adopt a durable runtime merely because we want:

- prettier workflow diagrams;
- more events/metrics;
- one extra Worker;
- a new model/provider;
- a longer prompt;
- a few sequential Supervisor steps;
- periodic compatibility checks;
- normal native session resume;
- a convenient place to put generic code.

### Admission process

When a hard trigger appears:

```text
1. prove the requirement with a concrete workflow/failure scenario
2. confirm native Worker/session + current external services cannot own it safely
3. compare mature durable runtimes (e.g. MAF, LangGraph, Restate-class systems)
4. keep Tri-Bridge Contract and worker adapters as stable seams where possible
5. migrate orchestration ownership upward; do not expand each Bridge into a workflow engine
```

### What adoption would change

A future durable runtime may legitimately own:

- durable workflow/run identity;
- checkpointed workflow state;
- pending workflow messages/HITL persistence;
- retry scheduling and idempotency bookkeeping;
- executor graph/step state;
- crash/restart resume.

It must **not** automatically take over:

- native Worker model/tool loop;
- Worker-native session history unless intentionally replaced;
- Bridge protocol translation;
- project contract authority;
- business/security gates that belong at deterministic domain boundaries.

### Current admission result

As of 2026-09-04:

```text
hard trigger proven = NO
shared durable runtime required now = NO
adoption = DEFER
boundary = DEFINED
```

**REF-03C decision:** `PASS / DEFER ADOPTION`.

---

## REF-03 final decision

```text
REF-03A Runtime capability matrix        PASS
REF-03B P2/P3 runtime-creep audit        PASS
REF-03C Durable-runtime admission gate   PASS / DEFINED

runtime creep found                      0
blocking gaps                            0
shared runtime to adopt now              none
future durable-runtime boundary          explicit
contract v1 changes                      0
```

# REF-03: CLOSED / PASS
