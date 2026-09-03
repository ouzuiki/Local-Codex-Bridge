# Tri-Bridge Supervisor Selection Policy v1

**Status:** FROZEN — P2 implementation target  
**Date:** 2026-09-04  
**Owner:** Supervisor  
**Depends on:** `TRI-BRIDGE-CONTRACT-V1.md`  
**Applies to:** LCB / Codex, LPB / Pi, LClB / Claude Code

This policy implements worker capability discovery, selection, fallback and budget routing without moving orchestration into any Bridge.

The Bridges remain thin worker-specific adapters. This policy is a pure Supervisor decision layer: it returns a recommendation and fallback chain; it never calls a Bridge, starts a Worker, retries a mutation, or stores durable workflow state.

## P2-0 — Scope

P2 owns only:

1. a versioned worker capability manifest;
2. deterministic worker eligibility filtering;
3. deterministic preference ordering;
4. fallback admission rules;
5. budget/quota signal interpretation;
6. regression tests for those decisions.

P2 does **not** add:

- a worker registry service;
- Bridge-to-Bridge calls;
- an automatic router daemon;
- a workflow/DAG engine;
- a retry queue;
- a second session/history store;
- a generic health daemon;
- provider-price scraping;
- fabricated cross-provider quota parity.

## P2-1 — Capability Manifest

Canonical data:

`supervisor-policy/worker-capabilities.json`

The manifest records only Supervisor-relevant capabilities that are supported by the current public Bridge surfaces.

### Claude / LClB

Role: **primary quality worker**.

Supported:

- Worker-neutral control contract;
- coding;
- permission HITL relay;
- Bridge health probe;
- post-run usage/cost when Claude reports it.

Not exposed by the current LClB public surface:

- enforced read-only mode;
- bounded file mutation scope;
- model/provider override;
- quota probe;
- native persistent session inventory.

### Codex / LCB

Role: **quality fallback and Codex-native worker**.

Supported:

- Worker-neutral control contract;
- coding;
- approval/HITL;
- enforced `read-only` sandbox;
- model and effort override;
- current `codex_rate_limits` quota probe;
- persistent native thread list/read/resume.

Not claimed:

- bounded exact-file mutation scope;
- bridge-normalized per-run USD cost.

### Pi / LPB

Role: **economy and bounded-scope worker**.

Supported:

- Worker-neutral control contract;
- coding;
- HITL;
- forced read scope;
- exact mutation file scope in coding mode;
- provider/model override;
- post-run session stats including cost when the native provider reports it.

Not exposed as mandatory public capability:

- quota probe;
- generic health probe;
- persistent session inventory.

Native asymmetry is intentional. A capability is not copied to sibling Bridges merely to simplify routing.

## P2-2 — Selection Policy

Selection is two-stage:

```text
hard capability filter
        ↓
preference / availability / budget ordering
```

A Worker that cannot satisfy a hard task requirement is never selected simply because it is preferred or cheaper.

### Default preference

For `quality` and `balanced` modes:

```text
Claude → Codex → Pi
```

This makes Claude the normal first-choice engineering Worker while preserving Codex and Pi as fallbacks.

For `economy` mode:

```text
Pi → Claude → Codex
```

`preferred_worker` is an explicit Supervisor/user override and moves that Worker to the front only while it is compatible, not unavailable, and not budget-exhausted.

### Hard task capability filters

The policy can require:

- enforced read-only;
- bounded mutation scope;
- model override;
- provider override;
- quota probe;
- persistent native thread inventory.

Examples:

- strict read-only excludes Claude under the current LClB surface;
- bounded mutation scope selects Pi;
- provider override selects Pi;
- native thread inventory selects Codex;
- model override selects Codex first, then Pi in balanced mode.

## P2-3 — Fallback Contract

Fallback is a Supervisor decision between attempts. It is **not** an automatic mid-run router.

### Never fallback while an ordinary run is active

If `active_worker != null` and the run is non-terminal:

```text
hold active Worker
```

### Pending HITL

If the active Worker has pending HITL:

```text
hold
```

A permission/request waiting for a real response is not worker failure.

### Unknown mutation acknowledgement

If a mutating start/respond/steer/interrupt acknowledgement is `unknown`:

```text
reconcile
```

Do not retry the mutation and do not start a fallback Worker until the native state has been observed/reconciled.

### Failed attempts

A Worker already marked failed for the current decision is excluded from the next candidate set. This prevents immediate bounce-back loops such as:

```text
Claude fail → Codex fail → Claude fail → ...
```

A semantic retry on the same Worker remains a Supervisor judgement outside this pure policy layer; if chosen, the Supervisor must explicitly clear/reframe the failed-attempt state.

### No viable Worker

The result is:

```text
action = no_worker
```

The policy never invents a route or silently weakens task constraints.

## P2-4 — Budget / Quota Routing

Budget data is evidence, not authority over task correctness.

### Codex

LCB exposes current quota state through `codex_rate_limits`. P2 maps the minimum observed remaining percentage to a policy pressure label:

| Remaining | Pressure |
|---:|---|
| >25% | `normal` |
| >10% and <=25% | `caution` |
| >0% and <=10% | `critical` |
| 0%, spend-control reached, or native reached-type present | `exhausted` |

This is a routing threshold, not a claim about OpenAI billing semantics.

### Claude

LClB terminal results may expose `total_cost_usd` and usage. P2 records the observed per-run cost but does not infer remaining Claude subscription quota because LClB currently exposes no quota probe.

### Pi

LPB terminal results may expose native `stats.cost` and token/session stats. P2 records the observed cost but does not hardcode provider prices or infer provider quota.

### Ordering effect

- `exhausted` removes a Worker from the current candidate set.
- `critical` is demoted behind non-critical viable Workers unless the user explicitly preferred that Worker.
- `caution` influences `balanced` / `economy` ordering but does not override explicit preference.
- `quality` mode ignores ordinary cost pressure except `critical` / `exhausted`; correctness preference stays primary.
- unknown budget state remains selectable and is labelled unknown rather than guessed.

## P2-5 — Deterministic Regression

Implementation:

- `supervisor-policy/policy.mjs`
- `supervisor-policy/policy.test.mjs`
- `supervisor-policy/worker-capabilities.json`

The policy suite covers:

- Claude-first balanced selection;
- Pi-first economy selection;
- explicit Claude preference;
- strict read-only exclusion of Claude;
- Pi-only bounded mutation scope;
- provider/model/thread capability routing;
- unavailable/exhausted fallback;
- failed-worker loop prevention;
- active-run hold;
- pending-HITL hold;
- unknown-ack reconcile;
- no-worker fail-closed behavior;
- Codex quota pressure normalization;
- Claude/Pi observed-cost extraction;
- preservation of native capability asymmetry.

The suite is wired into the canonical repository's normal `npm test` path. It does not consume Worker/provider quota and does not call any Bridge.

## P2 boundary decision

P2 deliberately stops before execution automation.

The final architecture is:

```text
                         Supervisor
                             │
                   Selection Policy v1
                  ┌──────────┼──────────┐
                  │          │          │
               Claude      Codex       Pi
              preferred    fallback   economy/
               quality               bounded scope
                  │          │          │
                LClB        LCB        LPB
                  │          │          │
             Claude Code   Codex        Pi
```

The policy answers **which Worker is currently admissible/preferred**. The Supervisor still owns whether to execute, when to retry, when to hand off, how to verify, and whether to commit/push.

Changing this policy does not require changing `Tri-Bridge Contract v1` unless the Supervisor/Bridge/native responsibility boundary itself changes.
