# Local Codex Bridge

Local Codex Bridge is a small, Windows-oriented MCP stdio bridge for native Codex sessions. It exposes seven explicit controls for finding threads, starting or continuing a turn, observing progress, answering real app-server requests, steering or interrupting an active turn, and preserving an optional supervision checkpoint.

The Bridge is currently Windows only. In particular, working-directory validation accepts absolute Windows drive-letter paths, and the optional Tray integration uses Windows PowerShell, Windows Forms, WMI/CIM, and Windows process identity.

## How it runs

The direct stdio path is the primary runtime:

```text
MCP client
  -> Local Codex Bridge (newline-delimited JSON-RPC over stdio)
  -> official Codex app-server (stdio)
  -> native Codex sessions
```

The Bridge lazily starts one official Codex app-server child. It does not add Bridge job IDs, a second task lifecycle, or automatic child restart. Native Codex owns persistent threads, turns, history, and final messages. Bridge memory holds only bounded live supervision state, sanitized events, pending app-server requests, and terminal snapshots. Optional checkpoints are separate bounded supervisor metadata, not Codex history.

Secure MCP Tunnel can be placed in front of the stdio command when remote MCP connectivity is wanted. The Windows Tray is an optional launcher/status layer for that Tunnel setup. Neither is required for a direct stdio integration.

## Seven MCP tools

All seven tools publish an object input schema and explicit MCP read-only, destructive, idempotent, and open-world annotations. Tool names and protocol behavior are intentionally stable.

### `codex_threads`

Lists persistent native Codex threads or reads one exact thread.

- With `thread_id`, it calls `thread/read`; `include_turns` may request persisted turns.
- Without `thread_id`, it calls `thread/list` with optional absolute Windows `cwd`, title `search_term`, cursor, and `limit` from 1 to 100.
- `cwd` and search values are filters, not access-control boundaries.
- It does not reconstruct live Bridge events or prove that a stored thread is active.

### `codex_turn`

Starts a new native thread or resumes an existing thread, then starts one turn with the supplied text.

- A new thread requires an absolute Windows drive-letter `cwd`.
- A resumed thread may receive optional `cwd`, `model`, `effort`, `sandbox`, and `approval_policy` overrides.
- Supported sandbox values are `read-only`, `workspace-write`, and `danger-full-access`; approval policy values are `untrusted`, `on-request`, and `never`.
- The call returns when `turn/start` is accepted, not when work completes. Observe the turn separately.
- `thread_id` is native Codex context, not a permanent task or job ID.

### `codex_observe`

Reads sanitized live events, pending app-server requests, terminal output, cursor state, and current turn state for one thread.

- `cursor` is non-consuming; `limit` is 1 to 100.
- `wait_ms` is 0 to 10,000 and performs at most one bounded event-driven wait when the live turn is active and nothing useful is already ready.
- If Bridge memory for the thread is gone, it falls back to persisted `thread/read` history and explicitly marks live state as unreconstructable.
- A quiet interval is not proof of a stall. When active supervision was requested, inspect every fresh snapshot and continue bounded observes until terminal unless the user pauses or stops.

### `codex_steer`

Appends text to the same active turn through `turn/steer`. It requires the exact `thread_id` and `expected_turn_id`; it never creates a new turn. Use it only for a semantic correction or redirect, not merely because a turn is taking time.

### `codex_respond`

Answers one real, currently pending app-server request using its original string or integer `request_id`, exact thread/method scope, and `turn_id` when present. Exactly one native response form is allowed: an approval `decision`, an `execpolicy_amendment`, question `answers`, or a generic result `response` for supported methods.

Never invent a request ID, widen its scope, or use this tool as a general message or turn-completion mechanism.

### `codex_interrupt`

Sends native `turn/interrupt` for one exact active `thread_id` and `turn_id`. It does not restart or stop the Bridge or app-server process.

### `codex_checkpoint`

Reads or updates optional bounded supervisor cognition metadata keyed to one native `thread_id`.

- Initialize it only when a long or complex supervision task has enough continuity risk to justify an external anchor; initialization may happen early.
- The original goal, constraints, and acceptance criteria are immutable after initialization.
- Update only after a material change in understanding, constraints, steering choice, user-authorized amendment, or acceptance judgment.
- Read an existing checkpoint once before final acceptance.
- Do not checkpoint ordinary one-shot work, every observation, timers, token or poll counts, silence, prompts, transcripts, raw events, command output, or final answers.
- A checkpoint is not a task ID, lifecycle record, transcript store, or requirement to keep future work on the same native thread.

## Supervision semantics

`turn/start` acceptance is not completion. For an actively supervised turn, use bounded event-driven observes until terminal unless the user explicitly pauses or stops. After each wake or deadline, inspect the new state before waiting again, steering, responding, or interrupting.

Choose thread continuity from task continuity and context value. A fresh thread is a fallback when scope, context quality, or permissions make it preferable, not a mandatory audit/write boundary. Behavioral instructions and native sandbox capability are separate: the prompt constrains intended behavior, while the requested `sandbox` and `approval_policy` configure Codex capability.

Respond only to a real pending request. Steer only when new evidence or changed intent changes the work. Interrupt only for an explicit stop. None of these operations creates a hidden Bridge job lifecycle.

## Trust and security model

Local Codex Bridge does not create a new operating-system sandbox. Actual command, file, network, and process access is governed by the official Codex executable/app-server configuration and permissions, plus the `sandbox` and `approval_policy` requested for a turn.

`codex_threads` list/read can expose native persistent threads visible to the same local Codex app-server and current OS user. Its `cwd` and search inputs narrow results but are not a security boundary.

Event and pending-request data is bounded and sanitized for obvious secrets before transport. That reduces accidental exposure; it does not make the Bridge suitable as a hostile multi-tenant gateway or a cross-user isolation layer. Keep checkpoints concise and non-sensitive.

No general shell tool is directly exposed. However, text sent through `codex_turn` or `codex_steer` can cause Codex to use its configured command and file capabilities, subject to Codex policy, sandbox, approvals, and the instructions supplied for that turn.

## Non-goals

The Bridge is not:

- a task/job manager, queue, daemon, or permanent task-ID service;
- a second transcript, history, or live-event database;
- a background monitor, poller, stall detector, or telemetry system;
- an auto-retry, auto-restart, or process-management service;
- a cross-user or hostile multi-tenant isolation layer;
- a bundled Codex runtime, Tunnel profile manager, HTTP MCP server, or general shell endpoint.

## Requirements

- Windows
- Node.js 24 or newer
- An official Codex executable available as `codex` on `PATH`, or supplied through the `CODEX_EXE` environment variable

The project does not install or depend on `@openai/codex`.

## Install, build, and test

```powershell
git clone <repository-url> local-codex-bridge
cd local-codex-bridge
npm ci
npm run typecheck
npm run build
npm test
```

For a direct terminal run after building:

```powershell
$env:CODEX_EXE = 'C:\path\to\codex.exe' # optional when codex is already on PATH
npm start
```

The child command is always:

```text
codex app-server --listen stdio://
```

For an MCP client, configure the stdio command directly as `node dist/src/index.js`. Do not put `npm start` behind an MCP Tunnel or another strict JSON-RPC stdio client because npm lifecycle output can pollute stdout.

`npm run smoke:live` is intentionally separate from unit tests. It launches real Codex read-only smoke tasks and creates persistent test threads, so run it only when that side effect is wanted.

## Persistence and restart boundaries

- Native Codex threads, turns, history, and final output remain in the official app-server persistence layer.
- Bridge event rings and pending request maps are process memory and cannot be reconstructed after Bridge loss.
- Checkpoints are bounded per-thread JSON files under the current user's local application-data directory, by default `%LOCALAPPDATA%\LocalCodexBridge\checkpoints\<sha256(thread_id)>.json`.
- `LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR` may select another absolute checkpoint directory.
- On clean shutdown, the Bridge closes its exact app-server child and escalates only against that child if it does not exit promptly.
- An unexpectedly dead app-server is latched as failed and is not automatically restarted inside the same Bridge process.

## Optional Secure MCP Tunnel

Build first, then configure the Tunnel's MCP command as:

```text
node <repository>\dist\src\index.js
```

Tunnel installation, authentication, profiles, ports, readiness endpoints, and process lifecycle remain external configuration. This repository does not create or modify a Tunnel profile.

## Optional Windows Tray

The Tray starts and observes a separately installed Tunnel client. It has no production profile, port, readiness URL, or executable baked in. Supply all three required values as parameters:

```powershell
.\windows\LocalCodexBridgeTray.Debug.cmd `
  -ReadyUrl 'http://127.0.0.1:<port>/readyz' `
  -ProfileName 'your-profile' `
  -TunnelExecutable 'C:\path\to\tunnel-client.exe'
```

Or set the public environment variables before using the hidden CMD or VBS launcher:

```powershell
$env:LOCAL_CODEX_BRIDGE_READY_URL = 'http://127.0.0.1:<port>/readyz'
$env:LOCAL_CODEX_BRIDGE_TUNNEL_PROFILE = 'your-profile'
$env:LOCAL_CODEX_BRIDGE_TUNNEL_EXE = 'C:\path\to\tunnel-client.exe'
wscript.exe .\windows\LocalCodexBridgeTray.vbs
```

`LOCAL_CODEX_BRIDGE_PROJECTION_PATH` can override the Tray's projection file. The Tray passes that path to its Tunnel child as `LOCAL_CODEX_BRIDGE_UX_PROJECTION`; without this opt-in environment value, Bridge runtime projection is disabled. The Tray checks only the configured readiness URL, does not auto-restart, and may stop only the exact Tunnel process launched by that live Tray instance after executable, command line, profile, start time, PID, and PID-file identity are revalidated.

## License

Licensed under the MIT License. See `LICENSE`.
