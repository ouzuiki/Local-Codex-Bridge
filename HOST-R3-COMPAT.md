# Host R3 compatibility and goal lifecycle

This release keeps the current native thread and turn surface. It adds one compatibility tool, `codex_goal`, and two closed `codex_turn.delivery_action_tool` shapes required by the deployed Host. It does not restore checkpoints, Host task state, `codex_thread_start`, or `codex_turn_start`.

## Delivery boundary

- `{ "version": 2 }` requires `sandbox: "workspace-write"` and `approval_policy: "never"`. It installs the native `delivery_action` dynamic tool and sets `features.shell_tool: false`, `features.unified_exec: false`, and `web_search: "disabled"`. The acknowledgement includes `delivery_boundary: "structured-effects-no-native-shell-v1"`.
- `{ "version": 3 }` requires `sandbox: "read-only"` and `approval_policy: "never"`. It installs only the native `review_source` dynamic tool under the same disabled native shell/web configuration. The acknowledgement includes `delivery_boundary: "review-source-no-native-shell-v1"`.
- The adapter accepts no extra `delivery_action_tool` fields or other versions. Resume reasserts the native config on the exact thread. Native sandbox and approval policy acknowledgements must match the request before `turn/start`.

These tools carry typed requests to the Host; the Host remains responsible for validating and performing admitted effects. The Bridge does not execute them or own delivery policy.

## Durable goal and reconnect receipt

`codex_goal` accepts only `set`, `get`, `clear`, and `reconnect`. `set` and `clear` call the native Goal methods and require exact acknowledgements. The small local record is keyed by a SHA-256 hash of the exact native thread ID, stored by default in the per-user state directory (`$XDG_STATE_HOME/local-codex-bridge/goals-v1` on Linux/macOS, `%LOCALAPPDATA%/LocalCodexBridge/goals-v1` on Windows). `LCB_GOAL_STATE_DIR` overrides the directory. It holds the objective digest, initial native turn ID when known, and one reconnect receipt. It contains no Host checkpoint or task data. The existing `source`, `operation`, `goal`, `resumed`, and `cleared` response fields remain available.

When the local record is absent, `get` can import an existing deployed native goal through `thread/goal/get`, but only after checking its exact thread ID, objective, and active/complete status. A native runtime without that method leaves the goal absent. An imported goal has no proven initial turn ID, so reconnect cannot infer one from history. Replacing, clearing, or reconnecting an imported goal requires a confirmed native `thread/goal/clear` before a new turn; explicit clear writes a durable tombstone so a legacy native goal cannot be reimported.

`reconnect` returns the deployed Host's `source`, `operation`, `thread_id`, and `resumed` fields, plus `receipt`:

```json
{
  "schema": "CodexGoalReconnectReceipt",
  "version": 1,
  "thread_id": "native-thread-id",
  "goal_digest": "sha256:...",
  "goal_status": "active",
  "turn_id": "exact-native-turn-id-or-null",
  "status": "started"
}
```

`status` is `started`, `already_in_progress`, `terminal`, or `unknown`. `resumed` is true only for the first two. A durable claim is written before a possible native mutation. Reconnect calls native `thread/resume` once and does not inject a prompt or call `turn/start`. Duplicate reconnects read the same receipt and never replay the mutation. `started` requires a native turn ID in the resume result; a lost acknowledgement or absent native turn ID stays `unknown`. The Bridge never manufactures a native mutation ID. Older stored receipts containing `goal_id` or `reconnect_id` remain readable, but new receipts omit those local IDs because they were not native result identities.

`codex_goal get` adds `lifecycle` without changing its existing fields. It reads the exact native Goal and `thread/read` history, and returns `native_goal`, `goal_digest`, `active_turn_id` from the live runtime when known, `latest_turn_id` and `latest_turn_status` from native history, `reconnect_outcome`, `reconnect_receipt`, `candidate_turn_id`, and an `uncertainty` array. A candidate turn after an UNKNOWN acknowledgement is evidence, not proof that reconnect created it. The outcome remains `unknown` until an exact native result can establish it. A Host can read this projection repeatedly after Bridge restart without replaying reconnect or diffing turn arrays. Mismatched native thread or Goal identity fails closed.

The Bridge record provides compatibility and reconnect identity. Native Codex remains the source of thread and turn history; this is a thin adapter, not restored legacy checkpoint ownership.
