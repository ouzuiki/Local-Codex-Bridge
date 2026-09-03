# Tri-Bridge P2 Closeout

**Status:** CLOSED  
**Date:** 2026-09-04  
**Contract:** [`TRI-BRIDGE-CONTRACT-V1.md`](TRI-BRIDGE-CONTRACT-V1.md) — unchanged / FROZEN  
**Policy:** [`TRI-BRIDGE-P2-POLICY-V1.md`](TRI-BRIDGE-P2-POLICY-V1.md)  
**Owner:** Supervisor  
**Applies to:** Local Codex Bridge (LCB), Local Pi Bridge (LPB), Local Claude Bridge (LClB)

P2 closes Worker Capability / Selection / Fallback / Budget Routing as a Supervisor-owned policy layer.

The implementation deliberately does **not** add routing, fallback, retry, budget state, or cross-worker orchestration to any Bridge. LCB, LPB and LClB remain thin native adapters under the frozen Tri-Bridge Contract v1.

---

## P2-0 — Scope / Boundary

**Status:** PASS / CLOSED

P0 already assigned worker selection, fallback, semantic retry, cross-worker handoff and budget policy to the Supervisor. P2 implements that decision boundary without moving it into Bridge runtime code.

The P2 policy is pure and side-effect free:

```text
observed task requirements
+ observed Worker state
+ Supervisor preference/budget mode
        ↓
selection decision / fallback chain / hold / reconcile / no_worker
```

It does not start a Worker, call a Bridge, retry a mutation, answer HITL, commit/push, or keep a durable task lifecycle database.

---

## P2-1 — Worker Capability Manifest

**Status:** PASS / CLOSED

Canonical manifest:

```text
supervisor-policy/worker-capabilities.json
```

Initial manifest commit:

```text
46a4641dbfe653a385b7f38822909c493003463a
feat: add P2 worker capability manifest
```

The manifest records only capabilities actually exposed through current Bridge surfaces and intentionally preserves native asymmetry.

### Claude / LClB

Default role:

```text
primary quality worker
```

Current Supervisor-relevant strengths:

- coding;
- permission HITL;
- Bridge health;
- terminal usage/cost when reported.

Current hard-capability gaps are represented honestly rather than papered over:

- no LClB-enforced read-only start mode;
- no exact bounded mutation-file scope;
- no public model/provider override;
- no quota probe;
- no native persistent-session inventory surface.

### Codex / LCB

Default role:

```text
quality fallback + Codex-native specialist
```

Current strengths include:

- coding;
- native approval/HITL;
- enforced `read-only` sandbox;
- model/effort override;
- current `codex_rate_limits` probe;
- persistent native thread list/read/resume.

### Pi / LPB

Default role:

```text
economy + bounded-scope specialist
```

Current strengths include:

- forced read scope;
- read-only mode;
- exact mutation file scope in coding mode;
- provider/model override;
- HITL;
- post-run native session stats/cost when reported.

No sibling Bridge capability was added merely for symmetry.

---

## P2-2 — Worker Selection Policy

**Status:** PASS / CLOSED

Implementation:

```text
supervisor-policy/policy.mjs
```

The selection algorithm is explicitly two-stage:

```text
hard capability filter
        ↓
preference / availability / budget ordering
```

A preferred or cheap Worker can never bypass a hard task capability requirement.

### Default ordering

For `quality` and `balanced`:

```text
Claude → Codex → Pi
```

This encodes the operating decision that Claude Worker is the normal first-choice engineering Worker.

For `economy`:

```text
Pi → Claude → Codex
```

An explicit `preferred_worker` is honored while that Worker remains compatible, not unavailable, and not budget-exhausted.

### Capability-driven examples

| Task requirement | Result |
|---|---|
| ordinary quality/balanced coding | Claude → Codex → Pi |
| economy coding | Pi → Claude → Codex |
| enforced read-only | Codex → Pi; Claude excluded |
| exact bounded mutation-file scope | Pi only |
| provider override | Pi only |
| model override | Codex → Pi |
| native persistent thread inventory | Codex only |
| quota-probe capability required | Codex only |

The policy fails closed with `no_worker` if no Worker can satisfy the requirements.

---

## P2-3 — Fallback Safety Contract

**Status:** PASS / CLOSED

Fallback is a Supervisor decision **between attempts**, never an automatic mid-run router.

The following are now machine-tested invariants:

### Active non-terminal run

```text
action = hold
```

Do not start a second Worker just because an active Worker is quiet or slow.

### Pending HITL

```text
action = hold
```

A real permission/input request waiting for a response is not Worker failure.

### Unknown mutating acknowledgement

```text
action = reconcile
```

If start/respond/steer/interrupt may have crossed the native boundary, the policy forbids direct retry or fallback until native state is reconciled.

### Failed attempt tracking

A Worker already marked failed for the current fallback decision is excluded from the next candidate set, preventing immediate bounce loops such as:

```text
Claude fail → Codex fail → Claude fail → ...
```

Same-Worker semantic retry remains an explicit Supervisor judgement and is not hidden inside this pure policy function.

---

## P2-4 — Budget / Quota Routing

**Status:** PASS / CLOSED

P2 uses only observed signals exposed by current Bridges. It does not fabricate cross-provider quota parity.

### Codex

LCB already exposes `codex_rate_limits`. P2 classifies the **main observed Codex rate-limit windows** using the minimum remaining percentage:

| Remaining | Pressure |
|---:|---|
| >25% | `normal` |
| >10% and <=25% | `caution` |
| >0% and <=10% | `critical` |
| 0% / spend-control reached / native reached type | `exhausted` |

Unrelated side entries in `rateLimitsByLimitId` are not allowed to make the main Codex quota look more constrained than it is.

### Claude

LClB may report `total_cost_usd` and usage on terminal results. P2 records that observed run cost but does not infer remaining Claude subscription quota because the current LClB public surface has no quota probe.

### Pi

LPB may report native `stats.cost` and session/token statistics. P2 records the observed run cost but does not hardcode provider prices or infer provider quota.

### Routing effects

- `exhausted` removes the Worker from the candidate set;
- `critical` is demoted behind non-critical viable Workers unless explicitly preferred;
- `caution` influences balanced/economy ordering;
- `quality` keeps quality preference primary except for `critical`/`exhausted` pressure;
- unknown quota remains `unknown` and selectable rather than guessed.

---

## P2-5 — Deterministic Regression / CI

**Status:** PASS / CLOSED

Regression suite:

```text
supervisor-policy/policy.test.mjs
```

Normal repository test wiring now includes:

```text
npm run test:supervisor-policy
```

The suite covers:

- Claude-first balanced/quality behavior;
- Pi-first economy behavior;
- explicit Claude preference;
- hard capability filtering;
- strict read-only exclusion of Claude;
- Pi-only bounded mutation scope;
- provider/model/thread routing;
- unavailable/exhausted fallback;
- failed-worker loop prevention;
- active-run hold;
- pending-HITL hold;
- unknown-ack reconcile;
- fail-closed `no_worker`;
- Codex main-quota threshold normalization;
- critical quota demotion;
- Claude/Pi observed-cost extraction;
- no fabricated Codex per-run cost;
- preservation of native capability asymmetry.

### Final implementation CI

Final implementation head:

```text
4fd8497a9823da303d62cfc61838724f6868433d
```

Permanent CI:

```text
run 33808927935
```

Results:

```text
Verify (macOS / Node 24)   SUCCESS
Verify (Windows / Node 24) SUCCESS
```

Both jobs completed dependency installation, typecheck, build and the full `npm test` suite successfully.

Earlier P2 runs were intentionally cancelled by the repository's `cancel-in-progress` concurrency policy as newer main commits superseded them; they are not treated as test failures.

---

## P2 final operating policy

```text
                         ChatGPT Supervisor
                                 │
                    Capability + Selection v1
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
          Claude Code           Codex               Pi
        primary quality     quality fallback   economy / bounded
              │                  │                  │
             LClB                LCB                LPB
              └──────── thin native adapters ───────┘
```

Normal engineering work:

```text
Claude first
  ↓ unavailable / incompatible / failed terminal attempt
Codex
  ↓ unavailable / incompatible / failed terminal attempt
Pi
```

Economy mode:

```text
Pi first → Claude → Codex
```

Hard task requirements always override preference ordering.

---

## Scope-control result

P2 introduced **no**:

- generic agent runtime;
- daemonized worker router;
- generic worker registry service;
- Bridge-to-Bridge calls;
- workflow/DAG engine;
- durable retry queue;
- second session/history database;
- generic approval engine;
- generic service/systemd control plane;
- provider-price scraper;
- fabricated universal quota model;
- automatic commit/push policy.

The policy is intentionally small enough to remain Supervisor cognition encoded as deterministic rules, rather than becoming a new orchestration product.

---

## P2 final decision

```text
P2-0  Supervisor Boundary / Scope          PASS / CLOSED
P2-1  Worker Capability Manifest           PASS / CLOSED
P2-2  Worker Selection Policy              PASS / CLOSED
P2-3  Fallback Safety Contract             PASS / CLOSED
P2-4  Budget / Quota Routing               PASS / CLOSED
P2-5  Deterministic Regression / CI        PASS / CLOSED

P2 — WORKER CAPABILITY / SELECTION / FALLBACK / BUDGET ROUTING
STATUS: CLOSED
```

`Tri-Bridge Contract v1` remains frozen. Future upstream Worker changes should first update observed capabilities and regression evidence. A new shared runtime is not justified merely because another Worker gains or loses a native feature.
