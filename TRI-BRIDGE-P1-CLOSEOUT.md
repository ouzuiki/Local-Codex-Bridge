# Tri-Bridge P1 Closeout

**Status:** CLOSED  
**Date:** 2026-09-03  
**Contract:** [`TRI-BRIDGE-CONTRACT-V1.md`](TRI-BRIDGE-CONTRACT-V1.md) — unchanged / FROZEN  
**Applies to:** Local Codex Bridge (LCB), Local Pi Bridge (LPB), Local Claude Bridge (LClB)

P1 closes the implementation-alignment and regression-hardening work that followed the P0 contract freeze.

The P0 semantics were not redesigned. P1 only aligned the concrete Bridges to the frozen contract, added regression coverage, and established permanent CI boundaries.

---

## P1-1 — LCB Event Envelope Alignment

**Status:** PASS / CLOSED

Implementation commit:

```text
b762f642c9c8f905cb83cae01199101dcfafeff9
feat: align LCB with tri-bridge contract v1
```

LCB already had a bounded runtime event ring, monotonic cursor, cursor-floor/loss handling, sanitization, independent pending-request state and terminal projection. P1 therefore did not replace the Codex runtime model.

P1 added only the Contract v1 projection layer:

- per-runtime `stream_id`;
- stable `event_id = stream_id:cursor`;
- `requested_stream_id` / `stream_changed` disclosure;
- stream mismatch treated as continuity loss rather than an empty page;
- common event metadata (`schema_version`, `worker`, `source`, `type`, `native_type`, timestamps, scope and transport metadata);
- bounded/sanitized native payload preservation;
- Contract v1 regression tests.

`codex_observe` gained an additive optional `stream_id` input. No new public tool was added.

Permanent LCB CI later validated this implementation together with the P1 context regression.

---

## P1-2 — LClB Event Envelope Alignment

**Status:** PASS / CLOSED

Implementation commit:

```text
53178d97eea118f10da5e2f9ef255cc806cf58c9
feat: align LClB with tri-bridge contract v1
```

LClB already had a bounded stream-json event ring, monotonic cursors, terminal projection, pending permission state and sanitizer. P1 preserved those native seams and added only the common projection:

- per-run `stream_id`;
- stable `event_id`;
- `requested_stream_id` / `stream_changed`;
- stream mismatch continuity-loss disclosure;
- common event metadata;
- typed Contract v1 event regression coverage.

`claude_observe` gained an additive optional `stream_id` input. The public surface remains exactly the existing seven `claude_*` tools.

---

## P1-3 — LCB / LClB HITL Projection Alignment

**Status:** PASS / CLOSED

LPB had already closed its typed-HITL implementation debt during the P0 repair. P1 brought LCB and LClB projections to the same semantic level without erasing native asymmetry.

### LCB

Pending native Codex requests now project common metadata including:

- `kind` (`action_approval`, `permission_grant`, `user_input`, or `unknown`);
- real native request identity and exact thread/turn scope;
- `native_method`;
- `blocking`;
- response-contract metadata;
- native payload retained in bounded/sanitized form.

`codex_respond` retains native Codex response semantics and adds an acknowledgement projection:

```text
acknowledgement = accepted
resolution      = submitted
worker          = codex
```

Unsupported future methods remain observable and fail closed rather than receiving guessed response objects.

### LClB

Claude permission requests now project as typed `permission_grant` HITL with:

- native request identity;
- session/tool-use scope;
- tool presentation/payload metadata;
- `blocking = true`;
- fail-closed policy;
- explicit `allow` / `deny` response contract.

`claude_respond` keeps the existing native permission broker semantics and adds the same acknowledgement-level metadata.

No Bridge-owned durable approval memory or generic HITL workflow engine was introduced.

---

## P1-4 — Tri-Worker Context Regression

**Status:** PASS / CLOSED

Canonical regression fixture and procedure:

- [`test/fixtures/tri-worker-context/AGENTS.md`](test/fixtures/tri-worker-context/AGENTS.md)
- [`test/fixtures/tri-worker-context/CLAUDE.md`](test/fixtures/tri-worker-context/CLAUDE.md)
- [`TRI-WORKER-CONTEXT-SMOKE.md`](TRI-WORKER-CONTEXT-SMOKE.md)

The fixture contains one unique contract token only in `AGENTS.md`:

```text
TRI_BRIDGE_CONTEXT_OK_7F29
```

The task text does not contain the token. The fixture `CLAUDE.md` contains only:

```text
@AGENTS.md
```

LCB deterministic CI locks these fixture invariants.

LClB now also has a repository-owned root `CLAUDE.md -> @AGENTS.md` shim plus a deterministic regression test ensuring it remains a thin shim rather than a second copied contract.

LPB retains its existing regression coverage for the prior context-loader failure mode, including the opt-in native `loadProjectContextFiles` test seam. Generic CI intentionally does not require a locally installed/authenticated Pi runtime.

### Live smoke boundary

The three-real-worker smoke is operator-triggered, not a GitHub CI dependency, because it requires local Bridge installations, provider authentication and real Codex/Pi/Claude capacity.

Canonical live smoke:

```text
What is TRI_BRIDGE_CONTEXT_TOKEN? Return only the token.
```

Expected:

```text
LCB  -> Codex       -> TRI_BRIDGE_CONTEXT_OK_7F29
LPB  -> Pi          -> TRI_BRIDGE_CONTEXT_OK_7F29
LClB -> Claude Code -> TRI_BRIDGE_CONTEXT_OK_7F29
```

This P1 closeout environment did **not** rerun the three-provider live smoke because the local Bridge call surfaces were not exposed to the executing session. That is not represented as a fresh live PASS.

P1 is nevertheless closed because the context authority/wiring contract, canonical fixture, deterministic regressions, and operator smoke procedure are now durable. The live smoke remains an explicit compatibility check after native Worker/context-loader changes, not a provider-dependent CI gate.

---

## P1-5 — Permanent Conformance CI

**Status:** PASS / CLOSED

### LCB

Permanent CI run:

```text
run 33767859782
head 23b3368582212f9ee79ab11c6cb57b9700b7a9d5
conclusion: success
```

This run includes the Contract v1 LCB implementation and the context-fixture regression.

### LPB

Permanent CI was added and made independent of a developer-machine Pi installation while keeping fake/native test seams explicit.

Final green run:

```text
run 33767337513
head 7ec6d3198cfb052bd7e4cc1adb761214c80772c1
conclusion: success
```

The initial generic runner failure was traced to unit tests resolving a locally installed Pi CLI before their fake-spawn seam. CI now supplies an existing fixture path through `LPB_PI_CLI_PATH`; real native Pi context tests remain opt-in.

### LClB

Permanent CI was added after the P1 projection work. It exposed one pre-existing scheduler-dependent interrupt fixture: a never-resolving Promise did not itself keep the fake Node child alive after stdin close, so SIGKILL escalation could race with process exit.

The fixture was made deterministic by keeping a real event-loop handle alive. Production interrupt behavior was not weakened or changed to satisfy the test.

Final green run:

```text
run 33767886934
head 3743ae4f3b10990b0cf07fec2724edb61fc0a450
conclusion: success
```

The earlier temporary P1 apply/retry/publish workflows were removed. Only the permanent CI remains.

---

## Final P1 conformance snapshot

| Area | LCB | LPB | LClB |
|---|---|---|---|
| Worker-neutral control semantics | PASS | PASS | PASS |
| Event Envelope v1 implementation | PASS | PASS | PASS |
| Typed HITL / response correctness | PASS | PASS | PASS |
| Context authority/wiring regression | PASS | PASS | PASS |
| Permanent deterministic CI | PASS | PASS | PASS |
| Thin-Bridge boundary preserved | PASS | PASS | PASS |

Native capability asymmetry remains intentional. P1 does not require identical public tool counts, native event types, permission models, session models, quota surfaces or provider metadata.

---

## Scope-control result

P1 introduced **no**:

- generic agent runtime;
- worker registry;
- workflow/DAG engine;
- cross-worker router;
- second session/history database;
- generic approval engine;
- universal context loader;
- Bridge-owned shell/systemd harness;
- custom tracing platform.

The Bridges remain thin native adapters under `Tri-Bridge Contract v1`.

---

## P1 final decision

```text
P1-1  LCB Event Envelope Alignment       PASS / CLOSED
P1-2  LClB Event Envelope Alignment      PASS / CLOSED
P1-3  LCB/LClB HITL Alignment            PASS / CLOSED
P1-4  Tri-Worker Context Regression      PASS / CLOSED
P1-5  Permanent Conformance CI           PASS / CLOSED

P1 — TRI-BRIDGE IMPLEMENTATION ALIGNMENT & REGRESSION HARDENING
STATUS: CLOSED
```

Future shared semantic changes require an explicit Contract revision. Ordinary upstream Worker changes should first be handled as adapter compatibility work and must not silently reopen P0/P1 or grow a Bridge into a generic runtime.
