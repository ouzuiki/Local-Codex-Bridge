# Worker Cost / Capability Routing Policy CR0-CR3 v0

**Status:** ACTIVE — supersedes the ordering rules of `TRI-BRIDGE-P2-POLICY-V1.md` without rewriting it
**Date:** 2026-09-05
**Owner:** Supervisor
**Depends on:** `TRI-BRIDGE-CONTRACT-V1.md` (Supervisor/Bridge/native boundary), `TRI-BRIDGE-P2-POLICY-V1.md` (capability manifest, fallback/HITL lifecycle)
**Applies to:** Supervisor / worker-neutral layer only. LCB, LPB, LClB are unchanged and remain unaware of this policy.

This document is CR0 (audit), CR1 (contract), CR2 (router), and CR3 (telemetry) for the Worker Cost/Capability Routing Policy program. All of it lives in the existing `supervisor-policy/` module; no new service, bridge, or package was created.

---

## CR0 — Audit: what already existed, what was verified, what was assumed

### Verified from repository source (not assumed)

- `supervisor-policy/policy.mjs#selectWorker` (P2) already implemented deterministic capability-gated worker selection, fallback ordering, and the active-run/pending-HITL/mutation-ack-unknown lifecycle (hold/reconcile), wired into `supervisor-policy/workflow-contract.json`'s `worker_selection` binding. This program evolves that same function/file in place rather than adding a parallel router, so the existing binding requires no change.
- `supervisor-policy/worker-capabilities.json` (P2) already published a static per-worker capability manifest (`coding`, `enforced_read_only`, `bounded_mutation_scope`, `model_override`, `provider_override`, `quota_probe`, `post_run_cost`, `post_run_usage`, `native_persistent_thread_inventory`) with per-worker `evidence` file pointers.
- `src/tools.ts` (`#rateLimits`, verified 2026-09-05) shows Codex's real `account/rateLimits/read` shape: a `rateLimits` object with independent `primary` and `secondary` window objects (each `usedPercent`/`remainingPercent`/`windowDurationMins`/`resetsAt`), plus top-level `spendControlReached`/`rateLimitReachedType`. `primary.windowDurationMins` is the short (5h-class) window; `secondary.windowDurationMins` is the long (weekly-class) window. `supervisor-policy/policy.mjs`'s pre-existing `classifyCodexQuota` already read `main.primary`/`main.secondary` and took the worst-case remaining percentage — it was already conservative across windows, but it collapsed them to one number and did not expose per-window state.
- Live Supervisor-reported evidence (2026-09-05, not derivable from the checked-out source): Codex Plus `account/rateLimits/read` showing primary(5h) `usedPercent=0`/`remaining=100` while secondary(weekly) `usedPercent=100`/`remaining=0`. This is the exact shape `classifyCodexQuota`'s worst-case reduction must not be fooled by, and is now a dedicated regression test (`policy.test.mjs`: *"a healthy primary window never masks an exhausted secondary window"*).
- Claude/Pi have no quota-window probe surface in the current Bridges (`post_run_cost`/`post_run_usage` only, observed after a run). This asymmetry is unchanged and intentional (`TRI-BRIDGE-P2-POLICY-V1.md` P2-4).
- `supervisor-policy/execution-plan.mjs` and its tests, plus `supervisor-policy/operational-smoke.test.mjs`, called `selectWorker` with no `task_class` and asserted Claude as the default coding worker. That default is a P2 assumption this program deliberately retires (see CR1 below); those three tests were updated to the new default rather than left stale.

### Assumptions (not verifiable from source; treated as policy input from this task's brief)

- v0 role assignment — Codex is the default engineering/evidence worker, Claude is a scarce expert-review/reasoning worker, Pi is a specialized extension worker not assumed cheap — is a stated architectural decision for this program, not something derivable from existing code. It reverses P2's `quality`/`balanced` default order (Claude-first) and P2's `economy` order (Pi-first).
- Cost/latency bands (`low`/`medium`/`high`/`unknown`) are treated as **preference signals for a future routing refinement**, not as data verified to exist in any live Bridge telemetry today. CR1 represents them explicitly (including `unknown`) but CR2 v0 does not score on them (see CR1 §WorkerState and CR2 §Deferred scoring below).

### Placement decision (freeze)

Everything below lives in `supervisor-policy/`, the smallest existing worker-neutral module that already owned worker selection:

- `supervisor-policy/policy.mjs` — CR1 contract types/enums (as plain JS constants/normalizers) + CR2 router (`selectWorker`, `routeTask`) + the Codex quota classifier.
- `supervisor-policy/worker-capabilities.json` — CR1 static WorkerProfile data (additive `extension_capability` capability key, `default_role_v0`; schema_version bumped 1→2).
- `supervisor-policy/telemetry.mjs` — CR3 normalizer/aggregator.
- `supervisor-policy/policy.test.mjs`, `supervisor-policy/telemetry.test.mjs` — regression coverage, wired into `npm run test:supervisor-policy`.

No new service, daemon, registry, or bridge was created. `workflow-contract.json`'s `worker_selection` binding (`supervisor-policy/policy.mjs#selectWorker`) is unchanged and now resolves to the CR1/CR2 behavior automatically.

---

## CR1 — Worker Routing Contract v0

All enums are exported `Object.freeze`d arrays from `supervisor-policy/policy.mjs` (single source of truth; nothing here is duplicated as a separate schema file).

### WorkerId

`WORKERS = ["claude", "codex", "pi"]`

### TaskProfile

| Field | Type | Default | Notes |
|---|---|---|---|
| `task_class` | `TASK_CLASSES` = `evidence_gathering` \| `general_engineering` \| `expert_review` \| `extension_capability` \| `mixed` | `general_engineering` | Primary routing axis (CR2). |
| `scope` | `SCOPES` = `tiny` \| `small` \| `medium` \| `large` | `small` | Descriptive; feeds reasons/telemetry, not a hard gate in v0. |
| `risk_class` | `RISK_CLASSES` = `read_only` \| `bounded_mutation` \| `broad_mutation` | derived from `mode`/`bounded_mutation_scope` | **Participates in eligibility**: `bounded_mutation` requires the `bounded_mutation_scope` capability even without the legacy boolean. |
| `evidence_ready` | boolean | `false` | Explicit evidence-availability signal (CR0 live-evidence requirement). |
| `required_capabilities` | array of `CAPABILITY_KEYS` | `[]` | Generic capability requirement list (any key `worker-capabilities.json` publishes). |
| `enforce_read_only`, `bounded_mutation_scope`, `requires_model_override`, `requires_provider_override`, `requires_quota_probe`, `requires_native_thread_inventory`, `requires_extension_capability` | boolean | `false` | Legacy P2 shortcuts, preserved for compatibility; each maps onto the same `CAPABILITY_KEYS` vocabulary as `required_capabilities`. `requires_extension_capability` defaults to `true` when `task_class === "extension_capability"`. |
| `stages_requested` | array of `STAGE_PURPOSES` | `["evidence_acquisition","expert_review"]` when `task_class === "mixed"`, else `[]` | See RoutingStage below. The default is pinned to exactly two stages even though `STAGE_PURPOSES` has four entries — the other two (`extension_capability`, `engineering_execution`) are for single-stage projection and explicit opt-in only. |
| preferred worker / constraints | via `policy.preferred_worker` (see RoutingDecision inputs) | `null` | Kept as a sibling input alongside `task`/`state` (as `selectWorker`/`routeTask` already took it) rather than nested inside `task`, to avoid re-shaping a working call convention. It is a **preference**: capability/quota gating is evaluated first and still excludes it if ineligible. |

`CAPABILITY_KEYS` (generic capability vocabulary, mirrors `worker-capabilities.json` keys): `coding`, `approval_hitl`, `health_probe`, `enforced_read_only`, `bounded_mutation_scope`, `model_override`, `provider_override`, `quota_probe`, `post_run_cost`, `post_run_usage`, `native_persistent_thread_inventory`, `extension_capability`.

### WorkerProfile (static) — `worker-capabilities.json`

Unchanged P2 shape plus two additive CR1 fields per worker:

- `capabilities.extension_capability` — `true` only for Pi (its native RPC/extension surface; Codex/Claude are `false`).
- `default_role_v0` — `engineering_default` (Codex), `expert_review_scarce` (Claude), `specialized_extension` (Pi). Documentation/telemetry metadata; CR2's actual default ordering lives in code (`TASK_CLASS_ORDER`), not in this field, so the two cannot silently drift without a test noticing (`policy.test.mjs` asserts both).

### WorkerState (dynamic) — per-worker input to `selectWorker`/`routeTask`

| Field | Type | Default | Notes |
|---|---|---|---|
| `availability` | `AVAILABILITY_STATES` = `available` \| `unknown` \| `degraded` \| `unavailable` | `unknown` | Health. `unavailable` hard-excludes. |
| `quota_windows` | map of window id → `BUDGET_PRESSURE_STATES` | `{}` | Independent named windows (Codex today: `primary`=5h-class, `secondary`=weekly-class via `QUOTA_WINDOW_IDS`; the map itself accepts any id since a future worker's probe may add its own). |
| `budget_pressure` | `BUDGET_PRESSURE_STATES` = `normal` \| `unknown` \| `caution` \| `critical` \| `exhausted` | derived: worst-case across `quota_windows` if any given, else the legacy flat `budget_pressure` input, else `unknown` | **A single `exhausted` window forces the whole worker to `exhausted`** — a short-window-healthy/weekly-exhausted worker is `exhausted`, not healthy. `unknown` outranks `normal` in severity (never treated as healthy/free) but does not hard-exclude by itself. |
| `cost_band`, `latency_band` | `COST_LATENCY_BANDS` = `low` \| `medium` \| `high` \| `unknown` | `unknown` | Explicit dynamic signals, always present (never silently absent). **v0 does not score on these** — they are preference signals reserved for a future routing refinement; CR2 records them but does not use them to order candidates yet. |

### RoutingDecision / RoutingStage

`selectWorker({task, state, policy})` is the CR2 single-decision primitive (unchanged P2 call shape, evolved internals): `{ action, worker, fallback_chain, reason, rejected }`.

`routeTask({task, state, policy})` is the CR1 RoutingDecision wrapper: `{ action, worker, fallback_chain, reason, rejected, stages: RoutingStage[] }`.

- `action`: `route` (single stage decided), `decompose` (mixed task, all stages decided), `hold`/`reconcile` (lifecycle, see below), or `no_worker` (fail-closed).
- Each `RoutingStage`: `{ stage_id, purpose, task_class, action, worker, fallback_chain, reason, rejected }`. `purpose ∈ STAGE_PURPOSES = evidence_acquisition | expert_review | extension_capability | engineering_execution`, one fixed purpose per `task_class` (`TASK_CLASS_STAGE_PURPOSE`).
- A `mixed` task decomposes into one stage per `stages_requested` entry, each independently routed against the *same* WorkerState snapshot (this is a decision-time split, not a runtime scheduler — the Supervisor still invokes each stage's Bridge separately).
- If any stage is not `select`, `routeTask`'s overall `action`/`reason` is copied from the first blocked stage (fail-closed propagates up; the other stages' individual outcomes remain visible in `stages`).

### Lifecycle (unchanged from P2, preserved verbatim)

`active_worker` non-terminal ⇒ `hold` (`active_run`) or `hold` (`pending_hitl`) or `reconcile` (`mutation_ack_unknown`). This is evaluated before any task-class/capability/quota logic runs, exactly as in P2.

### Fail-closed / HOLD terminology mapping

This program uses two distinct blocking outcomes and does not conflate them:

- `hold` / `reconcile` — mid-run lifecycle blocking (an attempt is already in flight). Unchanged from P2.
- `no_worker` — CR2's fail-closed decision when, after capability/quota/availability filtering, zero workers remain eligible for a task or stage. This is the "deterministic HOLD" the CR2 acceptance criteria describe; it is named `no_worker` (not `hold`) specifically so it is never confused with the lifecycle hold above in reasons/telemetry.

---

## CR2 — Deterministic Router

All routing in `selectWorker`/`routeTask` is pure data-in/data-out: no model call, no network call, no I/O. Rules, in the order they are actually applied:

1. **Lifecycle first.** Active non-terminal run ⇒ `hold`/`reconcile` (unchanged P2 semantics), before any task/capability logic.
2. **Capability/risk eligibility.** A worker missing any required capability — from `mode`, `enforce_read_only`, `bounded_mutation_scope`, the individual `requires_*` flags, `risk_class` (via `RISK_CLASS_REQUIRED_CAPABILITY`), or the generic `required_capabilities` array — is rejected with `reason: "capability_mismatch"` and the exact missing capability keys (deduplicated). A worker is **never** selected for a task it lacks the capability for, regardless of preference or task-class default.
3. **Previous-attempt/availability/quota exclusion.** A worker already in `failed_workers` for this decision, `availability === "unavailable"`, or `budget_pressure === "exhausted"` (i.e. any quota window exhausted) is excluded entirely — this is where the short-window-healthy/weekly-exhausted Codex scenario is excluded, not merely demoted.
4. **Task-class default order** (`TASK_CLASS_ORDER`), applied to whatever remains eligible:
   - `evidence_gathering`, `general_engineering`, `mixed` → `codex, claude, pi`
   - `expert_review` → `claude, codex, pi`
   - `extension_capability` → `pi, codex, claude` (moot in practice: only Pi ever has the `extension_capability` capability, so Codex/Claude are already excluded at step 2 — there is no substitute worker for this task class)
5. **Explicit preference.** `policy.preferred_worker`, if present and still eligible after steps 2-3, is moved to the front. It is a preference, applied only among already-eligible candidates — it cannot resurrect a capability- or quota-excluded worker.
6. **Ordering among remaining ties:** availability rank, then quota-pressure rank, then the task-class base order index. `unknown` availability/pressure ranks worse than confirmed-healthy and better than confirmed-degraded/caution at every step — it deprioritizes, it never excludes and never counts as healthy. This is one uniform rule for every task class; there is no separate "quality mode" branch (P2 had one; it is retired along with `budget_mode`-based ordering).
7. **No eligible worker** ⇒ `action: "no_worker"`, `reason: "no_viable_worker"` (or the propagated blocked-stage reason from `routeTask`). Fail-closed; no route is invented.

### Deferred scoring (explicit, not silently missing)

`cost_band`/`latency_band` are captured in WorkerState (CR1) and telemetry (CR3) but **not** read anywhere in the ordering logic above. v0 deliberately ships them as data-only preference signals; using them to reorder eligible candidates is future work and requires its own decision (e.g. whether/how a `large`+`broad_mutation` task should prefer a `low` latency-band worker). Until that decision is made, they must not silently become a hidden tiebreaker.

### `budget_mode` (deprecated, accepted, ignored)

`policy.budget_mode` (`quality`/`balanced`/`economy`) is still validated if present (so existing callers don't throw) but has **no effect** on ordering. It encoded the exact assumption this program retires — "economy ⇒ Pi-first" — which contradicts the v0 architecture instruction that Pi is not assumed cheap. Task-class is now the only structural ordering axis; `preferred_worker` is the only override dial.

### Codex quota windows

`classifyCodexQuota(rateLimits)` classifies `primary` and `secondary` independently (`{state, remaining_percent}` each, `state ∈ {normal, caution, critical, exhausted, unknown}`), then combines them by worst-known-state, exposed as `{pressure, remaining_percent, source, windows}`. A window absent from the response is `unknown`, not `normal`. The Supervisor maps `windows.primary.state`/`windows.secondary.state` into `state.workers.codex.quota_windows` before calling `selectWorker`/`routeTask`.

---

## CR3 — Telemetry / Cost Learning Foundation (passive)

`supervisor-policy/telemetry.mjs` provides `normalizeTelemetryEvent(raw)` and `aggregateTelemetry(events)`. Neither is called from `selectWorker`/`routeTask`, and neither writes back into routing state — **CR3 never automatically changes routing policy in v0.** It exists only to make a future local Worker Economics Dataset buildable from already-collected, already-safe events.

### Normalization (privacy/redaction)

`normalizeTelemetryEvent` builds a brand-new object field by field from a fixed allowlist; it never spreads the raw input. Anything outside the allowlist — prompts, tool inputs/outputs, transcripts, message arrays, credential-like fields, environment variables, stdout/stderr, cwd, args, or any other caller-added key — never survives normalization, regardless of what it's named.

Two fields get extra scrutiny beyond simple key-dropping, because their *values* (not just unlisted sibling keys) are caller-controlled and could otherwise leak arbitrary text:

- `routing_reason` is validated against `ROUTING_REASONS` — the finite, closed set of strings `selectWorker`/`routeTask` can actually emit (`policy_<task_class>`, `explicit_preference`, `mixed_task_decomposed`, `no_viable_worker`, `active_run`, `pending_hitl`, `mutation_ack_unknown`). Any other string (including one designed to smuggle secret/prompt text) is reduced to `"unknown"`.
- `quota_window_snapshot` keeps only entries whose window id is in the bounded `QUOTA_WINDOW_IDS` allowlist **and** whose value is a real `BUDGET_PRESSURE_STATES` member; both the key and the value are checked, and a failing entry is dropped entirely rather than kept with a sanitized value.

Numeric fields (`tokens`, `cost_usd`) are normalized to `{value, source}` where `source` is `"native"` only for an actually-observed finite number, `"unknown"` otherwise — unknown cost/usage is never fabricated as zero or omitted silently.

`policy.test.mjs`/`telemetry.test.mjs` include adversarial regression coverage: a fixture with unlisted "raw" fields, an out-of-enum `routing_reason`, and an out-of-allowlist quota-window id/value, asserting all of it is dropped/reduced rather than merely absent from a spot check.

### Aggregation

`aggregateTelemetry(events)` groups normalized events by `worker:task_class`, iterating in the fixed `WORKERS × TASK_CLASSES` canonical order (not input order), producing per-group `count`, `success_rate`, `fallback_rate`, `escalation_rate`, `mean`/`median_duration_ms`, and cost/token sums split by known-vs-unknown source. Output is deterministic regardless of event arrival order (regression-tested via reversed-input equality).

---

## Files changed

- `supervisor-policy/policy.mjs` — CR1 enums/normalizers + CR2 router (evolved in place; `selectWorker` call shape unchanged, `routeTask` added).
- `supervisor-policy/worker-capabilities.json` — additive `extension_capability` capability + `default_role_v0` per worker; `schema_version` 1→2.
- `supervisor-policy/policy.test.mjs` — rewritten for task-class-driven expectations; added CR1/CR2 regression coverage.
- `supervisor-policy/telemetry.mjs`, `supervisor-policy/telemetry.test.mjs` — new, CR3.
- `supervisor-policy/execution-plan.test.mjs`, `supervisor-policy/operational-smoke.test.mjs` — updated only where they asserted the retired Claude-first/Pi-first default.
- `package.json` — `test:supervisor-policy` now also runs `telemetry.test.mjs`.
- This document — new.

No file outside `supervisor-policy/` (and this doc) or `package.json`'s test script changed. `TRI-BRIDGE-P2-POLICY-V1.md` is left intact as the historical record of the P2 decision it supersedes the *ordering* portion of; it is not rewritten.

## Deferred (intentionally out of scope for v0)

- Using `cost_band`/`latency_band` to actually reorder eligible candidates.
- Wiring `aggregateTelemetry` output into any routing decision (explicitly forbidden for v0).
- A quota-window probe for Claude/Pi (none exists in either Bridge today).
- Exact token/cost forecasting (explicitly out of scope per the architecture boundary).
