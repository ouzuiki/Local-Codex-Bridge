# Codex app-server 0.156 protocol assumptions

This Candidate uses the installed official Codex 0.156.0 stable and experimental generated JSON schemas as its protocol source. The checked-in [method audit](audit/methods-0.156.json) classifies all 101 stable methods and 63 experimental-only methods exactly once. The [schema test](test/schema-audit.test.ts) regenerates both schemas and fails when method names or parameter fields drift.

The bridge launches the official executable with `app-server --listen stdio://`. JSON-RPC/JSONL stdout is protocol-only. Exact native thread, turn, and request IDs are preserved. Native persisted history owns thread/turn truth; Bridge runtime data is bounded and ephemeral.

The four generic native tools use explicit method and parameter allowlists in [src/native.ts](src/native.ts). `codex_native_read` and `codex_experimental_read` make read requests only. Mutating methods return native acknowledgements; a timeout or ambiguous write can mean the mutation was accepted, so [src/app-server.ts](src/app-server.ts) reports UNKNOWN and never retries automatically.

`thread/list` now includes 0.156 originators, source kinds, sort keys, section, provider, and state DB fields. The local app-server rejects nonempty hosted originator filters. `thread/attachment/add|list|remove`, `plugin/skill/read`, and `app/read` are part of the audited stable surface. Removed `thread/rollback` is not exposed; current `thread/revert` is.

Native `thread/goal/set|get|clear` is authoritative. The Bridge stores only a digest binding and reconnect uncertainty receipt for compatibility. `codex_goal get` always reads native Goal, including paused, blocked, usage limited, budget limited, and complete statuses. The local record cannot override a conflicting native Goal.

Current stable ServerRequest handling includes command/file/permission approvals, user input, `item/tool/call`, and `mcpServer/elicitation/request`. Responses require a real pending raw ID and exact thread/method/turn scope. Auth-token refresh and attestation remain runtime plumbing. Unknown future methods remain pending without a guessed response.

The explicit internal methods in the audit are excluded because they administer the runtime or bypass Host authority/effect ownership: raw command, file system, and process operations; config writes and reloads; account mutations; marketplace/plugin installation and sharing; raw MCP tool invocation and OAuth; shell command and guardian bypass; remote/realtime control; user verification; memory reset; environment creation; and native event stream/session control. Methods classified `redesign` need a bounded normalized contract and are listed in the [Candidate report](LCB-NATIVE-CAPABILITY-CONSOLIDATION.md).
