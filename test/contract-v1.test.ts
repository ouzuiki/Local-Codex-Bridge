import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeStore } from "../src/runtime.js";

test("Contract v1 projects Codex events with stable stream identity and detects stream change", () => {
  const runtime = new RuntimeStore(8);
  runtime.markTurnAccepted("thread-contract", "turn-contract");
  runtime.recordNotification("item/started", {
    threadId: "thread-contract",
    turnId: "turn-contract",
    item: { type: "commandExecution", apiKey: "secret" },
  });

  const first = runtime.observe("thread-contract", 0, 10)!;
  assert.equal(first.stream_changed, false);
  assert.equal(typeof first.stream_id, "string");
  assert.equal(first.events.length, 1);
  const event = first.events[0]!;
  assert.equal(event.schema_version, 1);
  assert.equal(event.worker, "codex");
  assert.equal(event.source, "lcb.codex-app-server");
  assert.equal(event.native_type, "item/started");
  assert.equal(event.type, "codex.item.started");
  assert.equal(event.stream_id, first.stream_id);
  assert.equal(event.event_id, `${first.stream_id}:1`);
  assert.equal(event.observed_at, event.at);
  assert.deepEqual(event.scope, { thread_id: "thread-contract", turn_id: "turn-contract" });
  assert.equal(event.transport.sanitized, true);
  assert.equal(((event.data as Record<string, unknown>).item as Record<string, unknown>).apiKey, "[REDACTED]");

  const changed = runtime.observe("thread-contract", first.next_cursor, 10, "stale-stream")!;
  assert.equal(changed.stream_changed, true);
  assert.equal(changed.cursor_lost, true);
});

test("Contract v1 projects typed Codex HITL metadata while retaining native scope", () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-hitl", "turn-hitl");
  runtime.recordServerRequest("req-1", "item/commandExecution/requestApproval", {
    threadId: "thread-hitl",
    turnId: "turn-hitl",
    command: "echo ok",
  });
  runtime.recordServerRequest("req-2", "item/permissions/requestApproval", {
    threadId: "thread-hitl",
    turnId: "turn-hitl",
    permissions: { network: true },
  });
  runtime.recordServerRequest("req-3", "item/tool/requestUserInput", {
    threadId: "thread-hitl",
    turnId: "turn-hitl",
    questions: [],
  });

  const pending = runtime.pendingForThread("thread-hitl") as Array<Record<string, any>>;
  assert.deepEqual(pending.map((item) => item.kind), ["action_approval", "permission_grant", "user_input"]);
  assert.equal(pending[0]?.response_contract.type, "action_decision");
  assert.equal(pending[1]?.response_contract.type, "permission_grant");
  assert.equal(pending[2]?.response_contract.type, "user_input");
  assert.equal(pending[0]?.scope.native_request_ref, "req-1");
  assert.equal(pending[0]?.method, "item/commandExecution/requestApproval");
});
