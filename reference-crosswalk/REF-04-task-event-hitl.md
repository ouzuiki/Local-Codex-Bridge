# REF-04 — Task / Event / HITL Crosswalk

**Status:** PASS after one minimal repair  
**Audit date:** 2026-09-04  
**Our baseline:** Tri-Bridge Contract v1 + P1 implementation alignment + P2/P3 policy (`550796c...`)  
**Primary references:** OpenAI Agents SDK, Microsoft Agent Framework; Strands used specifically to distinguish cancellation from resumable interrupts.

## REF-04A — Our Task / Execution Identity Audit

### Identity model

The current system deliberately has several identity classes rather than one universal `task_id`:

```text
Supervisor current_task
        │
        ├── LCB: native thread_id + turn_id
        ├── LPB: native session path / durable entry + one active supervisor execution
        └── LClB: Claude session_id + one bridge run slot

Independent from all of the above:
        event stream_id + cursor
```

This is correct. Task authority, native session identity, active execution identity and event-stream identity solve different problems.

| Question | Our model | Reference comparison | Verdict |
|---|---|---|---|
| Is user/Supervisor task text itself the durable execution identity? | No | OpenAI separates run input/state; MAF separates workflow input/run/checkpoint | `MATCH` |
| Can native persistent session identity differ from one execution/turn? | Yes | OpenAI session/run state and MAF workflow/checkpoint concepts are distinct | `MATCH` |
| Is event stream identity separate from task/execution identity? | Yes | Streaming/event surfaces are observations of execution, not the execution identity itself | `MATCH` |
| Does LCB distinguish persistent Codex thread from turn? | Yes | Strong equivalent of session vs run/turn separation | `MATCH` |
| Does LPB expose a worker-native session artifact rather than inventing a generic shared run DB? | Yes | Native-specific persistence is allowed | `INTENTIONAL_ASYMMETRY` |
| Does LClB use Claude session identity while Bridge runtime owns only the current run slot? | Yes | Thin projection over native session | `MATCH` |
| Is there a system-wide durable workflow-run ID surviving Supervisor/process loss? | No | MAF/OpenAI can persist resumable run state | `REFERENCE_STRONGER` / `NOT_APPLICABLE` today |

### Lifecycle audit

Frozen common lifecycle remains:

```text
idle → active → terminal
```

Pending HITL does not create a fake terminal state and does not need a shared workflow lifecycle phase. Worker-specific sub-statuses (`interrupting`, `attached_idle`, native turn status, etc.) remain optional projections.

**REF-04A decision:** `PASS`. No identity redesign required.

---

## REF-04B — Event Semantics Crosswalk

### Reference principles used

OpenAI streaming exposes events around a run while the resumable `RunState` remains the execution state. Microsoft workflows expose workflow/executor events while checkpoint/shared state remain state. Both support the principle that an event log is not automatically the authoritative current state.

### Crosswalk

| Semantic | Tri-Bridge v1 | External reference | Verdict |
|---|---|---|---|
| Bounded event retention | mandatory | Frameworks do not require unbounded event replay for run correctness | `MATCH` |
| Stream identity | `stream_id` owns cursor namespace | Streaming/run instances have explicit scope | `MATCH` |
| Cursor comparable only within stream | yes | consistent with scoped event streams | `MATCH` |
| Lost history disclosed | `cursor_floor`, `cursor_lost`, `stream_changed` | explicit recovery boundaries are safer than pretending continuity | `OURS_STRONGER` for bridge projection |
| Event ID distinct from execution ID | yes | events/items are not the run identity | `MATCH` |
| Pending HITL reconstructed from event history | forbidden | OpenAI interruptions / MAF pending requests are run/workflow state | `MATCH` |
| Terminal state inferred by hunting for result event | forbidden | result/run state is authoritative | `MATCH` |
| Unknown future native event | transport without invented semantics | extensible event systems preserve unknown/additive event types | `MATCH` |
| Payload bounding/redaction | Bridge responsibility | reference tracing/event systems assume application security controls | `OURS_STRONGER` as a local transport contract |
| Trace IDs fabricated when absent | forbidden | tracing identity must come from real trace context | `MATCH` |

### Worker evidence

**LCB**

- per-thread `streamId`, monotonic cursor and bounded ring;
- `cursor_floor`/loss/change projection;
- terminal snapshot stored independently of events;
- pending app-server requests stored independently of events;
- late mutating responses reconciled rather than blindly replayed.

**LPB**

- `PiEventRuntime` provides bounded ring, stream/event IDs, cursor loss/change metadata, sanitization and separate pending state;
- terminal is Supervisor state and clears pending independently of retained events.

**LClB**

- each new run resets event ring and creates a new `stream_id`;
- bounded ring with `cursor_floor`, `cursor_lost`, `stream_changed`;
- terminal snapshot and pending permission state are separate from events.

**REF-04B decision:** `PASS`. No event architecture repair required.

---

## REF-04C — HITL / Cancel / Resume Crosswalk

### 1. HITL authority

OpenAI Agents SDK pauses a run when approval is required and exposes pending approvals in `interruptions`; decisions are applied to the same `RunState`. Microsoft Agent Framework models HITL as request/response state and includes pending requests in workflow checkpoints.

Our v1 rule is equivalent at the non-durable Bridge boundary:

```text
observe.pending_requests = authoritative actionable state
```

Events may announce a request, but are never used to reconstruct whether it is still actionable.

### 2. Confirmed LClB gap found at audit baseline

At the pre-REF LClB implementation, the permission broker itself correctly removed a request on:

- explicit response;
- timeout (fail closed to deny);
- client/sidecar disconnect;
- shutdown.

However, the Bridge runtime's `pending_requests` projection was refreshed when a request first arrived and after an explicit Supervisor response, but not on every broker-side removal transition. Therefore a timeout/disconnect could leave a stale pending request visible in `claude_observe` even though the native permission transport had already denied/settled it.

Classification:

```text
CONFIRMED_GAP
owner = LClB Bridge current-state projection
impact = correctness / HITL safety
contract_change = no
```

Minimal repair:

- `3e6ce9a` — permission broker publishes full pending-set changes after add/remove transitions;
- `00c76d0` — runner subscribes to that authoritative pending set instead of manually refreshing only selected paths;
- `234e20b` — regression covers timeout and client-disconnect transitions to authoritative empty pending state.

The repair changes no Claude native permission semantics and adds no approval memory.

Post-repair state: `REPAIRED`.

### 3. Response safety

| Semantic | Our system | Reference comparison | Verdict |
|---|---|---|---|
| Respond only to a real pending request | required | OpenAI interruption/MAF request identity | `MATCH` |
| Unknown request semantics guessed | forbidden | typed/known approval request expected | `MATCH` |
| Failed native handoff consumes pending | forbidden | unresolved request remains unresolved | `MATCH` |
| Bridge-wide sticky approval memory | forbidden | OpenAI can persist approval within RunState, but this is runtime-owned state | `INTENTIONAL_ASYMMETRY` |
| Deterministic safety gate bypassed by approval | forbidden | guardrails/business gates remain separate from approval | `MATCH` |

### 4. Cancel versus resumable HITL

Strands makes the distinction explicit: cancellation terminates the agent invocation; interrupts pause for external input and can resume. Our contract also keeps these semantics separate:

- `interrupt` is a control/cancellation operation mapped to the native Worker primitive;
- pending HITL is a blocking request state;
- responding to HITL is not the same operation as `interrupt`;
- a Bridge never promises stronger cancellation atomicity than its native Worker/process can provide.

Verdict: `MATCH`.

### 5. Durable resume

OpenAI can serialize `RunState` and resume a paused approval later; MAF checkpoints persist workflow state and pending requests. Tri-Bridge v1 does not provide a shared durable suspended-workflow state outside native Worker session capabilities.

This is deliberately **not** a current REF-04 gap:

```text
REFERENCE_STRONGER
current classification = NOT_APPLICABLE
future decision = REF-03C durable-runtime admission criterion
```

If future tasks must survive Supervisor/process/machine loss while suspended mid-workflow, the system should adopt a durable runtime rather than expand Bridge state into one.

### REF-04 final decision

```text
REF-04A Identity/Lifecycle       PASS
REF-04B Event semantics          PASS
REF-04C HITL/Cancel/Resume       PASS after repair

confirmed gaps found             1
confirmed gaps repaired          1
blocking gaps remaining          0
unknown findings remaining       0
contract v1 changes              0
```

# REF-04: CLOSED / PASS
