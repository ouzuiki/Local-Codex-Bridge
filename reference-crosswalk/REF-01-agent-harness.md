# REF-01 — Agent Harness Crosswalk

**Status:** PASS  
**Audit date:** 2026-09-04  
**Primary reference:** Strands Agents agent loop, cancellation, interrupts and hooks  
**Our scope:** LCB / Codex, LPB / Pi, LClB / Claude Code

The purpose of REF-01 is to verify that the Bridges are adapters around native coding harnesses rather than second agent harnesses layered on top of them.

## REF-01A — Native Harness Ownership Matrix

Strands defines a full agent harness/loop that owns model invocation, tool execution, history, loop continuation, stop reasons, retry hooks, cancellation and invocation limits.

Codex, Pi and Claude Code already provide the corresponding native execution loop. Therefore adopting a second generic agent loop inside LCB/LPB/LClB would duplicate execution ownership.

| Capability | Strands Agent owns | Tri-Bridge owner | Verdict |
|---|---|---|---|
| model reasoning loop | yes | Native Worker | `MATCH` ownership |
| model → tool → model loop | yes | Native Worker | `MATCH` ownership |
| tool registry/execution | yes | Native Worker | `MATCH` ownership |
| native conversation/session history | yes | Native Worker | `MATCH` ownership |
| model/tool retry mechanics | yes | Native Worker; Supervisor only owns semantic retry decision | `MATCH` |
| task goal / acceptance | app/orchestrator | Supervisor | `MATCH` boundary |
| protocol translation | not the Agent abstraction's purpose | Bridge | `INTENTIONAL_ASYMMETRY` |
| bounded live event projection | hook/event consumer concern | Bridge | `THIN` / `MATCH` |
| pending native approval projection | runtime-specific | Bridge | `THIN` |
| cross-worker fallback | multi-agent/orchestrator concern | Supervisor P2 | `MATCH` boundary |

### Worker-specific evidence

**LCB** starts/owns the Codex `app-server` child and translates JSON-RPC. It does not implement a model/tool reasoning loop. Codex owns thread/turn execution and native tools.

**LPB** starts Pi's RPC process, sends prompts/steer/abort commands and projects Pi events/results. Pi owns the model/tool loop and native session.

**LClB** starts `claude -p --input-format stream-json --output-format stream-json`, relays permission requests and projects frames/results. Claude Code owns reasoning and tool execution.

**REF-01A decision:** `PASS`.

---

## REF-01B — Cancellation / Lifecycle / Hook Crosswalk

### Cancellation

Strands cancellation is cooperative: cancellation is checked at defined loop/tool boundaries, and an already-running non-cooperative tool may finish before the loop stops. The result reports a cancellation stop reason. Strands also distinguishes cancellation from resumable interrupts.

Our contract correctly avoids promising stronger semantics than the native Worker:

- LCB maps `turn/interrupt` / child termination behavior to Codex primitives;
- LPB maps soft interrupt to Pi queue clear + abort, with explicit force termination available;
- LClB marks `interrupting`, closes stdin, sends SIGTERM to the process group and escalates to SIGKILL after a grace interval;
- terminal outcome records interruption/failure rather than claiming instantaneous atomic cancellation.

Verdict: `MATCH` at the contract level with native-specific cancellation mechanics preserved.

### Lifecycle

Strands exposes loop lifecycle and stop reasons. Our architecture exposes the smaller cross-worker lifecycle needed by the Supervisor:

```text
idle → active → terminal
```

Native stop reasons/status details can be projected as metadata without expanding the mandatory lifecycle enum. This is an intentional thinner interface, not a missing agent loop.

Verdict: `INTENTIONAL_ASYMMETRY`.

### Hooks

Strands hooks are inside the agent loop and can observe **and modify** model/tool behavior at lifecycle points.

Our Bridges deliberately do not create a second generic hook system. Their event projections are observation/control transport, while any loop-level behavior modification remains native Worker functionality. Supervisor policies consume observations and decide external next actions; they do not masquerade as in-loop hooks.

Examples:

- P2 worker selection is a pure Supervisor decision before an attempt;
- P3 Completion Gate runs after evidence/acceptance, not inside native model/tool calls;
- memory hooks transport candidate completed episodes but do not rewrite native loop behavior;
- Contract Watch observes compatibility seams and does not intercept model/tool execution.

Verdict: `NOT_APPLICABLE` for a shared Bridge hook framework; current event/control surface is sufficient.

**REF-01B decision:** `PASS`.

---

## REF-01C — Double-Harness Duplication Audit

A double-harness smell exists if the Bridge/Supervisor layer starts independently owning the same loop already owned by Codex/Pi/Claude Code.

### Audit checklist

| Double-harness smell | Current state | Verdict |
|---|---|---|
| Bridge repeatedly calls model until completion | absent | `PASS` |
| Bridge owns generic tool registry/execution loop | absent | `PASS` |
| Bridge stores a second canonical conversation transcript | absent | `PASS` |
| Bridge performs generic model/tool retries | absent | `PASS` |
| Bridge decides semantic next action autonomously | absent | `PASS` |
| Bridge performs cross-worker handoff/routing | absent | `PASS` |
| Bridge owns generic skill engine | absent | `PASS` |
| P2 selection executes Workers itself | no, pure policy | `PASS` |
| P3 workflow is a daemon/state engine | no, pure policy/gates | `PASS` |
| TencentDB memory becomes execution/session truth | no, advisory/candidate only | `PASS` |
| LClB permission sidecar becomes an approval engine | no, transport + exact decision relay only | `PASS` |

### Frozen exception

LCB `codex_checkpoint` remains the previously declared legacy boundary exception. It does not form an agent loop and must not be replicated to sibling Bridges.

### Adoption decision

Do **not** adopt Strands as an extra execution layer around Codex/Pi/Claude Code under current requirements.

Adopt/reference Strands patterns only where they improve vocabulary or tests without moving execution ownership, e.g.:

- cancellation versus resumable-interrupt terminology;
- explicit stop/outcome metadata;
- observability/evaluation concepts;
- cancellation safety-point documentation.

### REF-01 final decision

```text
REF-01A Native harness ownership       PASS
REF-01B Cancel/lifecycle/hooks          PASS
REF-01C Double-harness audit            PASS

confirmed duplication                  0
blocking gaps                          0
runtime dependency to adopt now        none
contract v1 changes                    0
```

# REF-01: CLOSED / PASS
