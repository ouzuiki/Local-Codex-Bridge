# Tri-Bridge Workflow Automation v1

**Status:** FROZEN — P3 implementation target  
**Date:** 2026-09-04  
**Owner:** Supervisor  
**Depends on:** `TRI-BRIDGE-CONTRACT-V1.md`, `TRI-BRIDGE-P2-POLICY-V1.md`  
**Applies to:** LCB / Codex, LPB / Pi, LClB / Claude Code, TencentDB shared memory

P3 mechanizes the Supervisor workflow around the already-frozen Bridge contract and P2 worker-selection policy.

It does **not** add a generic workflow runtime. The Supervisor still owns semantic judgement; P3 turns repeated end-of-task, memory and compatibility checks into deterministic policy gates so they are not left to recollection alone.

---

## P3-0 — Canonical workflow

Machine-readable order:

`supervisor-policy/workflow-contract.json`

Frozen sequence:

```text
task intake
    ↓
memory recall assessment
    ↓
P2 worker selection
    ↓
execution / supervision
    ↓
acceptance verification
    ↓
repo + docs assessment
    ↓
memory record assessment
    ↓
commit
    ↓
push
    ↓
working-tree / repository final-state verification
    ↓
close
```

The sequence is normative, but it is not a daemon or state database. The Supervisor supplies observed evidence and decides semantic questions such as whether the implementation is actually correct, whether documentation needs updating, and whether a durable memory candidate exists.

### Execution supervision

Execution remains governed by `Tri-Bridge Contract v1`:

```text
start → observe → steer/respond/interrupt when semantically required → result
```

P3 does not replace native Worker history, session semantics, permission semantics or Bridge lifecycle state.

---

## P3-1 — Completion Gate v1

Implementation:

`supervisor-policy/completion-gate.mjs`

The completion gate is split into two phases because a task cannot simultaneously have uncommitted changes and a verified clean final tree.

### Pre-commit gate

Required evidence:

1. `acceptance` — Supervisor has verified the requested outcome;
2. `tests` — passed, or explicitly judged not required;
3. `diff` — inspected, or explicitly not required;
4. `docs` — updated or explicitly not needed;
5. `agents` — `AGENTS.md` / project contract impact assessed and resolved;
6. `decisions` — architecture/decision record impact assessed and resolved;
7. `memory` — durable-memory impact assessed; any required record has completed.

Passing result:

```text
action = ready_for_commit
```

Examples of fail-closed states:

```text
tests = not_run          → blocked
docs = update_required   → blocked
memory = record_required → blocked
memory = record_failed   → blocked
acceptance = rejected    → blocked
```

The gate does not run tests or inspect a diff itself. It requires the Supervisor to provide explicit evidence that those actions were completed. This prevents an implicit skip from being confused with a deliberate `not_required` / `not_needed` decision.

### Final gate

The final gate includes all pre-commit evidence plus:

8. `commit` — created or explicitly not needed;
9. `push` — pushed or explicitly not needed;
10. `tree` — interpreted according to the execution workspace.

The caller must declare:

```text
workspace_kind = working_tree | remote_only
```

For a normal local checkout:

```text
workspace_kind = working_tree
tree           = clean
```

Anything else (`dirty`, `unknown`, or `not_applicable`) blocks closure. A local task may never use `not_applicable` to bypass clean-tree verification.

For a remote-only repository path that never owns or mutates a local checkout, such as an authorized GitHub API write path:

```text
workspace_kind = remote_only
tree           = not_applicable
```

`remote_only` does not mean “assume clean.” It means there is no mutable local working tree whose cleanliness can truthfully be asserted. Supplying `clean`, `dirty`, or `unknown` under `remote_only` is rejected so the evidence model cannot blur those two execution environments.

Passing result:

```text
action = close_task
```

### Completion responsibility

The gate is a policy check only. It does not authorize commits or pushes on its own; commit/push authorization remains with the Supervisor/user under the frozen responsibility boundary.

---

## P3-2 — TencentDB Recall / Record Policy

Implementation:

`supervisor-policy/memory-policy.mjs`

P3 formalizes the authority and eligibility rules around the existing Worker-neutral TencentDB memory contract. It does not replace `@ouzuiki/worker-memory-contract`, MemoryCore, or the LPB/LClB memory adapters.

### Recall policy

Recall is **selective**, **fresh-run only**, and **advisory**.

A project-scoped fresh run recalls memory when one or more of the following applies:

- user explicitly requested recall;
- task continues prior work;
- task is multi-step project work;
- architecture or business rules are material;
- a cross-worker handoff is occurring;
- prior root cause or reusable SOP is likely relevant.

A simple fresh one-shot task with no trigger skips recall.

A resumed native session skips external recall by default because native session history is already active; this avoids repeatedly reinjecting the same advisory context.

Recalled memory may never override:

```text
current task
project contract / AGENTS.md
security / hard runtime policy
```

Only bounded relevant recall should be injected.

### Durable-record allowlist

P3 allows durable memory candidates only in these categories:

```text
verified_decision
business_rule
architecture_constraint
verified_root_cause
reusable_sop
```

A durable record additionally requires:

```text
Supervisor verification
+ accepted task outcome
+ no secret/credential content
+ non-ephemeral fact
```

### Explicit exclusions

The following do not become durable truth:

```text
raw_log
transcript
worker_self_report
unverified_hypothesis
temporary_task_state
credential_or_secret
raw_command_output
```

### Who may record

Authority split:

```text
Supervisor
    → may authorize durable record

Supervisor-authorized memory pipeline
    → may transport/write an already-authorized durable candidate

Worker Bridge hook
    → may transport a completed episode as candidate material
      but does not establish truth by itself

Worker model
    → may not authorize durable truth
```

This preserves the existing LPB/LClB completed-writeback design. A Bridge hook can continue sending a naturally completed task/result episode into the shared memory pipeline; P3 simply freezes the rule that a Worker result is evidence/candidate material, not automatically a verified architectural or business fact.

### Memory failure and completion

When the Completion Gate determines that a durable memory record is required:

```text
record_required / record_failed → task cannot pass pre-commit gate
```

When no durable memory is warranted:

```text
memory = not_needed
```

This makes the memory decision explicit without requiring every task to write memory.

---

## P3-3 — Reliability / Contract Watch

Implementation:

- `supervisor-policy/contract-watch-baseline.json`
- `supervisor-policy/contract-watch.mjs`

P3 watches **contract seams**, not every upstream implementation detail.

Frozen watch domains:

```text
native_api
event_schema
approval_semantics
context_loading
tool_catalog
rate_limits
```

### Worker applicability

Codex currently requires all six watch domains because LCB exposes a native quota surface through `codex_rate_limits`.

Pi and Claude require:

```text
native_api
event_schema
approval_semantics
context_loading
tool_catalog
```

`rate_limits` is optional because neither LPB nor LClB currently freezes a mandatory quota-probe capability.

### Watch triggers

Run a contract watch after any of the following:

- native Codex / Pi / Claude Code version changes;
- Bridge-facing native API or event-format update;
- context-loader change;
- permission / HITL change;
- tool catalog change;
- Codex rate-limit surface change;
- deterministic conformance regression;
- real runtime behavior contradicts the frozen contract.

### Drift states

Each watch domain is classified as:

```text
stable
additive
breaking
unknown
not_applicable
```

### Decision rules

#### Stable

With required domains stable and conformance tests green:

```text
action = pass
```

#### Additive upstream change

An additive native API/tool/event feature with green conformance:

```text
action = observe_only
allowed_fix_scope = none
```

An upstream feature is not copied into sibling Bridges merely for symmetry.

#### Version/additive change without regression evidence

```text
action = run_conformance_tests
allowed_fix_scope = no_patch_until_evidence
```

Do not patch based only on a version number.

#### Failed or unknown seam

```text
action = probe_contract_seam
```

A failing test or unknown required domain triggers diagnosis first. It does not authorize speculative redesign.

#### Confirmed breaking contract seam

```text
action = patch_contract_seam
allowed_fix_scope = adapter_contract_seam_only
```

Only the affected Worker adapter / compatibility seam should be repaired unless evidence shows the shared contract itself is no longer viable.

### When Contract v1 may change

A normal upstream update does not revise `Tri-Bridge Contract v1`.

Contract revision requires an actual shared-semantic change such as:

- control-operation meaning changes materially;
- event cursor/stream identity semantics become invalid;
- HITL safety semantics cannot be represented;
- project-context ownership changes;
- Supervisor/Bridge/native responsibility boundaries must move.

Otherwise the default is adapter maintenance or observe-only.

### Native-specific probe focus

After an update, diagnosis should focus only where evidence points:

**Codex**

- app-server methods used by start/observe/steer/respond/interrupt;
- pending approval/user-input request shapes;
- model/tool catalog projection;
- `account/rateLimits/read` projection;
- native project-context loading.

**Pi**

- RPC lifecycle/events;
- extension UI/HITL response shapes;
- project context loader;
- provider/model/tool surface;
- read/mutation scope extensions.

**Claude Code**

- `-p` / stream-json frames;
- permission prompt relay;
- session/resume semantics;
- project `CLAUDE.md → @AGENTS.md` context path;
- tool/event surface used by LClB.

A live provider smoke is required only when the affected seam cannot be validated deterministically in generic CI.

---

## P3 deterministic regression

Regression suites:

- `supervisor-policy/p3.test.mjs`
- `supervisor-policy/p3-remote.test.mjs`

They are included in the repository's permanent `npm test` path alongside P2 policy tests.

Coverage includes:

- fixed Completion Gate order;
- explicit pre-commit vs final closure semantics;
- no implicit skipped tests;
- docs/memory blockers;
- local dirty/unknown-tree blocker;
- local working tree cannot use `not_applicable`;
- remote-only completion requires explicit `tree = not_applicable`;
- remote-only path cannot falsely claim a clean local tree;
- fresh-run selective recall;
- advisory memory authority;
- durable-memory allowlist;
- raw-log/transcript/secret exclusions;
- Worker model cannot authorize durable truth;
- Bridge writeback remains candidate episode transport;
- stable contract watch PASS;
- additive change observe-only;
- version change requires regression evidence;
- failed/unknown seam requires probe;
- breaking seam restricts repair to adapter contract seam.

---

## Scope-control result

P3 deliberately introduces **no**:

- Hermes Assistant revival;
- generic workflow engine;
- DAG scheduler;
- worker router daemon;
- Bridge-to-Bridge orchestration;
- generic worker registry service;
- second session/history database;
- second memory database;
- Bridge-owned durable acceptance state;
- generic approval engine;
- systemd/service control layer;
- autonomous git commit/push daemon;
- speculative upstream feature cloning.

The architecture remains:

```text
                         ChatGPT Supervisor
                                 │
                 P3 Workflow / Completion Gate
                       │                 │
                 Memory Policy      Contract Watch
                       │                 │
                 P2 Selection Policy    │
                       │                 │
              ┌────────┼────────┐        │
              │        │        │        │
             LClB      LCB      LPB ←────┘
              │        │        │
           Claude    Codex      Pi
```

P3 mechanizes repeated Supervisor decisions while keeping execution/session ownership native and Bridges thin.
