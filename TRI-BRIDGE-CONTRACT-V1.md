# Tri-Bridge Contract v1

**Status:** FROZEN — P0 CLOSED  
**Date:** 2026-09-03  
**Canonical SSOT:** this document  
**Applies to:** Local Codex Bridge (LCB), Local Pi Bridge (LPB), Local Claude Bridge (LClB)  
**Excluded:** Hermes Assistant and any frozen orchestration/runtime experiment

This document is the canonical closeout for the P0 tri-bridge architecture phase. It consolidates P0-1 through P0-6 into one durable admission and conformance contract.

The central decision is:

> LCB, LPB, and LClB are thin worker-specific protocol/control adapters. They are not generic agent runtimes, workflow engines, session databases, approval engines, memory systems, or cross-worker orchestrators.

```text
                 Supervisor
                     │
          Worker-neutral Contract v1
                     │
       ┌─────────────┼─────────────┐
       │             │             │
      LCB           LPB           LClB
   thin adapter   thin adapter   thin adapter
       │             │             │
     Codex           Pi          Claude Code
       │             │             │
       └──── native execution/session/history ────┘

Adjacent external infrastructure:
Secure Tunnel / systemd-service control / TencentDB memory /
secrets / durable observability / deployment configuration
```

---

## P0-1 — Tri-Bridge Build / Adopt / Keep Audit

**Status:** PASS / FROZEN

### KEEP

These are system-specific seams that remain ours:

- ChatGPT/external-supervisor ↔ local machine tunnel boundary.
- Codex native protocol adaptation in LCB.
- Pi RPC/native extension adaptation in LPB.
- Claude Code stream-json and permission-transport adaptation in LClB.
- Worker-neutral control semantics used by the Supervisor.
- Native approval/HITL translation.
- Native steer/interrupt mapping.
- Native project-context bootstrap compatibility.
- Thin TencentDB cross-session project-memory seams.
- Worker-specific deterministic safety shims where native runtimes do not supply the required boundary.

### THIN

These capabilities remain necessary but MUST stay adapter-sized:

- lifecycle projection;
- bounded live event state;
- pending-request projection;
- terminal/result projection;
- event sanitization/bounding;
- mutating acknowledgement handling;
- optional worker-specific capability projection;
- context delivery without replacing native context loaders.

### ADOPT

When a genuinely generic need appears, prefer mature upstream/runtime standards rather than rebuilding it inside a Bridge:

- agent loops and generic lifecycle runtimes;
- durable workflow/orchestration;
- generic worker registries;
- generic HITL workflow engines;
- generic session/history managers;
- generic tracing platforms;
- generic skill frameworks;
- generic shell/systemd execution harnesses.

Architectural references include Strands Agents, Microsoft Agent Framework, Microsoft multi-agent reference architecture, Google ADK, OpenAI Agents SDK, and Anthropic commerce-agents. They are references, not P0 runtime dependencies.

### FREEZE

Existing legacy functionality may remain when removal would create unnecessary risk, but it MUST NOT become a pattern for sibling Bridges.

Current explicit example:

- LCB `codex_checkpoint` is frozen legacy boundary debt. Do not add `pi_checkpoint` or `claude_checkpoint` for symmetry.

### REMOVE / DO NOT BUILD

The following are outside Bridge scope:

- generic task/job queues;
- generic workflow/DAG engines;
- cross-worker routing/fallback;
- generic semantic retry or stall engines;
- second transcript/session databases;
- Bridge-owned approval memory;
- Bridge-owned universal prompt/context loaders;
- generic service/systemd control surfaces;
- automatic commit/push policy;
- Bridge-to-Bridge calls.

---

## P0-2 — Worker-neutral Control Contract v1

**Status:** PASS / FROZEN

Six logical operations are frozen:

```text
start / observe / respond / steer / interrupt / result
```

Public tool names may differ; conformance is semantic.

| Operation | LCB | LPB | LClB |
|---|---|---|---|
| start | `codex_turn` | `pi_start` | `claude_start` |
| observe | `codex_observe` | `pi_observe` | `claude_observe` |
| respond | `codex_respond` | `pi_respond` | `claude_respond` |
| steer | `codex_steer` | `pi_steer` | `claude_steer` |
| interrupt | `codex_interrupt` | `pi_interrupt` | `claude_interrupt` |
| result | terminal projection via observe | `pi_result` | `claude_result` |

A dedicated result tool is optional if terminal state is stably and idempotently readable through observe.

### Frozen lifecycle

```text
idle → active → terminal
```

Pending HITL does not create a new lifecycle phase.

### Mutating acknowledgement

```text
accepted / rejected / unknown
```

`unknown` means the mutation may have crossed the native boundary. For start/respond/steer/interrupt:

> Observe/reconcile before retry. Never blindly replay a mutation after acknowledgement uncertainty.

### Ownership

- Native worker owns execution, native tools, persistent session/thread/history, model state, sandbox and native permission behavior.
- Bridge owns bounded live supervision state and faithful protocol translation.
- Supervisor owns goals, constraints, worker choice, steering decisions, HITL decisions, acceptance, retry and next action.

Capability asymmetry is intentional. Worker-specific models, rate limits, usage/cost, native session inventory, policy amendments, or other native surfaces do not become mandatory merely for symmetry.

---

## P0-3 — Unified Event Envelope v1

**Status:** PASS / FROZEN

The common layer standardizes the envelope, not every worker's native event ontology.

Required v1 fields:

```text
schema_version
stream_id
cursor
event_id
worker
source
type
category
native_type
observed_at
occurred_at
scope
data
transport
```

Core rules:

1. `stream_id` owns one monotonic cursor namespace.
2. Cursor values are comparable only inside one stream.
3. Reset/unreconstructable continuity requires a new stream ID.
4. Event storage is bounded.
5. Eviction advances `cursor_floor` and must be disclosed as cursor loss.
6. A stream change must not silently look like an empty page.
7. Native payload remains structurally faithful but bounded/sanitized.
8. Secrets are redacted and truncation/redaction is disclosed in transport metadata.
9. Pending requests are authoritative current state, not reconstructed from event history.
10. Terminal state is authoritative current state, not inferred by hunting for a result event.
11. Unknown future native events remain transportable without invented semantics.
12. Trace IDs may be projected only from a real trace context; never fabricate them.

### Current implementation status

- **LPB:** aligned. The P0 repair added bounded event runtime, stream/event IDs, cursor floor/loss/change handling, categories, timestamps, sanitization/redaction, typed request projection and compatibility metadata. Regression reached CI PASS after fixture corrections.
- **LCB:** semantically close; remaining work is outer-envelope projection/alignment, not an event-runtime redesign.
- **LClB:** semantically close; remaining work is outer-envelope projection/alignment, not a stream-json parser redesign.

LPB P0-3 implementation debt is CLOSED.

---

## P0-4 — Approval / HITL Contract v1

**Status:** PASS / FROZEN

HITL is broader than approval. Five request kinds are frozen:

```text
action_approval
permission_grant
user_input
dialog
unknown
```

The authoritative actionable state is the current `pending_requests` projection, independent of event history.

### Core rules

- A request is actionable only while actually pending.
- Request IDs are real opaque native/bridge-held identities; never fabricate them.
- Fire-and-forget UI notifications are events, not pending HITL.
- Unknown request semantics remain visible but cannot be answered by guessing.
- Respond validates the exact pending request, native method/scope and allowed response contract.
- Validation failure does not consume the pending request.
- Only one writer may claim/respond to a pending request at a time.
- A failed native response handoff leaves the request pending.
- `deny` is distinct from `deny_and_interrupt`.
- `approve_once` is distinct from native session approval.
- A Bridge must not create durable approval memory to emulate missing native support.
- Deterministic safety gates cannot be bypassed by HITL approval.
- Control-channel failure never becomes implicit approval.

### Pi alignment closeout

LPB now:

- treats response-requiring `select/confirm/input/editor` dialogs as pending;
- keeps fire-and-forget `notify/setStatus/setWidget/setTitle/set_editor_text` event-only;
- projects LPB safety confirms as action approvals;
- validates exact Pi response shapes (`confirmed`, `value`, or `cancelled` as applicable);
- validates select values against actual pending options;
- leaves unknown future dialog methods visible but unanswerable safely;
- consumes pending state only after accepted native handoff.

LPB P0-4 implementation debt is CLOSED.

LCB and LClB retain only minor common-projection/metadata alignment work; their native approval/permission mechanisms remain authoritative.

---

## P0-5 — Supervisor / Bridge Boundary Contract v1

**Status:** PASS / FROZEN

Four responsibility layers are frozen:

### Supervisor

Owns:

- goal and task decomposition;
- worker selection and fallback policy;
- supervision/steering decisions;
- HITL decisions;
- acceptance and verification;
- semantic retry;
- stall judgement;
- cross-worker handoff;
- budget policy;
- commit/push authorization;
- next action.

### Bridge

Owns:

- one worker family's protocol adaptation;
- bounded live state;
- native event projection;
- current pending-request projection;
- terminal projection;
- validation/sanitization/bounding;
- native mutation acknowledgement handling;
- narrow worker-specific deterministic safety shims;
- child/native protocol lifecycle.

### Native Worker

Owns:

- model execution and reasoning;
- tools/shell/filesystem/git available through its native environment;
- native session/history;
- native retry/compaction;
- sandbox and native permission semantics;
- provider/model semantics.

### External infrastructure

Owns:

- Secure Tunnel;
- systemd/service lifecycle and health;
- secrets/configuration;
- TencentDB/shared memory service;
- durable observability/storage;
- updater/deployment infrastructure.

### Admission rule

Before adding any Bridge feature, ask:

1. Is it native execution/session behavior? → adopt/project native worker capability.
2. Is it faithful translation/current bounded control state? → Bridge may own it.
3. Does it require deciding what should happen next? → Supervisor owns it.
4. Is it reusable machine/service infrastructure? → external control plane owns it.

If a feature looks like a generic agent runtime, workflow engine, session database, registry, approval engine, shell harness or tracing platform, default to **do not build it in the Bridge**.

---

## P0-6 — Worker-neutral Context Contract v1

**Status:** PASS / FROZEN

The system standardizes context authority and ownership, not provider-specific loader algorithms.

Frozen context classes:

```text
current_task
project_contract
native_user_context
native_session_history
advisory_memory
native_procedure
observed_evidence
```

Hard runtime/security policy is separate from textual context.

### Core rules

- `current_task` comes from the Supervisor/user and contains the requested outcome, explicit constraints/scope and authorized amendments.
- Shared project contract SSOT is `AGENTS.md`.
- Claude compatibility may use a thin project-owned `CLAUDE.md → @AGENTS.md` shim rather than copied policy text.
- Native worker context loaders remain authoritative.
- Bridges must not recursively scan instruction files and build a universal prompt stack.
- Bridges must not silently disable native context loading.
- Pi's prior `--no-context-files` incident is a permanent regression rule: native project context loading must remain enabled unless explicitly intended for a narrowly scoped test.
- Skills/procedures are loaded through native mechanisms; do not paste all skill bodies into every task.
- Native session history stays native-owned.
- TencentDB/shared external memory is advisory cross-session context, not execution truth and not an authority that can override current task/project/security policy.
- Observed worker/repo/tool evidence is evidence, not instruction authority.
- CWD is part of context correctness.
- Hot reload is not assumed; a new worker/session may be required after project contract changes.

A permanent cross-worker smoke should use one unique project rule and verify Codex, Pi and Claude all receive it through their native paths.

---

## P0 final conformance snapshot

| Area | LCB | LPB | LClB |
|---|---|---|---|
| P0-2 control semantics | PASS | PASS | PASS |
| P0-3 event semantics | PASS; minor projection alignment remains | PASS; implementation debt CLOSED | PASS; minor projection alignment remains |
| P0-4 HITL semantics | PASS; minor projection/upstream adoption watch | PASS; implementation debt CLOSED | PASS; minor projection alignment remains |
| P0-5 thin-bridge boundary | PASS with frozen `codex_checkpoint` debt | PASS | PASS |
| P0-6 context ownership | PASS | PASS | PASS |

P0 does not require perfect lexical/tool-schema symmetry. Conformance is semantic and preserves native capability asymmetry.

---

## Non-blocking debt carried into P1

P0 is CLOSED despite the following non-blocking implementation/maintenance items:

1. LCB: add/align P0-3 outer event-envelope metadata without redesigning native Codex event handling.
2. LCB: add/align P0-4 request/response projection metadata as needed; adopt future Codex policy-amendment variants only after exact native seam/test coverage.
3. LCB: `codex_checkpoint` remains a frozen legacy boundary exception; eventual Supervisor-layer relocation is allowed but not a P0 requirement.
4. LClB: add/align P0-3 outer event-envelope metadata without redesigning stream-json parsing.
5. LClB: add/align P0-4 pending/response metadata without emulating session approval or unsupported permission semantics.
6. Three Bridges: maintain repo-context hygiene and native-loader regression coverage.
7. Three Workers: keep a small cross-worker project-contract smoke as a regression test.
8. Observability/tracing: prefer standard mechanisms such as OpenTelemetry/framework-native tracing if durable observability is later required; do not build a Bridge-specific tracing platform.

These are P1 implementation alignment/maintenance tasks, not grounds to reopen P0.

---

## Versioning and future changes

`Tri-Bridge Contract v1` is frozen.

A normal Bridge change does not revise this contract merely because an upstream worker adds a native event, tool, model, quota surface, permission type or session feature.

A contract revision is required only when shared semantics change materially, for example:

- changing the six control-operation meanings;
- changing lifecycle or mutation-ack semantics;
- changing event cursor/stream identity rules;
- changing required event-envelope fields incompatibly;
- changing HITL request/response safety semantics;
- moving Supervisor/Bridge/native/external responsibility boundaries;
- replacing native context/session ownership with a new shared runtime.

New optional worker-specific capabilities should normally be projected behind capability discovery rather than added to the mandatory core.

---

## P0 Definition of Done

- [x] P0-1 Build / Adopt / Keep decisions are archived.
- [x] P0-2 Worker-neutral Control Contract v1 is frozen.
- [x] P0-3 Unified Event Envelope v1 is frozen.
- [x] P0-4 Approval / HITL Contract v1 is frozen.
- [x] P0-5 Supervisor / Bridge Boundary Contract v1 is frozen.
- [x] P0-6 Worker-neutral Context Contract v1 is frozen.
- [x] LCB / LPB / LClB all semantically conform to the v1 control architecture.
- [x] LPB's highest-priority P0 event/HITL implementation debt has been repaired and regression-tested.
- [x] Generic agent-runtime duplication is explicitly rejected inside Bridges.
- [x] Hermes Assistant remains excluded/frozen.
- [x] Remaining deltas are classified as P1/non-blocking maintenance.
- [x] A single canonical SSOT exists in version control.

# P0 PHASE: CLOSED

Next phase: **P1 — Tri-Bridge Implementation Alignment & Regression Hardening**.
