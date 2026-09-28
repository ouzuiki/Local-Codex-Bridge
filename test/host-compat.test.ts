import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerManager } from "../src/app-server.js";
import { GoalStore } from "../src/goal-store.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

class NativeFixture extends AppServerManager {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  turns: { id: string; status: string }[] = [];
  goal: { threadId: string; objective: string; status: string; id?: string } | null = null;
  failTurn = false;
  resumeWithoutTurn = false;
  constructor() { super(new RuntimeStore(), { executable: "unused" }); }
  override async request(method: string, raw: unknown): Promise<unknown> {
    const params = raw as Record<string, unknown>;
    this.calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "gpt-6-sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null };
    if (method === "thread/goal/set") {
      this.goal = { threadId: String(params.threadId), objective: String(params.objective), status: "active", id: "native-goal-1" };
      return { goal: this.goal };
    }
    if (method === "thread/goal/get") return { goal: this.goal?.threadId === params.threadId ? this.goal : null };
    if (method === "thread/goal/clear") { this.goal = null; return { cleared: true }; }
    if (method === "thread/read") return { thread: { id: params.threadId, turns: this.turns } };
    if (method === "thread/resume" && this.failTurn) throw new Error("operation outcome is UNKNOWN");
    if (method === "thread/resume") this.turns.push({ id: `turn-${this.turns.length + 1}`, status: "inProgress" });
    if (method === "thread/start" || method === "thread/resume") return {
      thread: { id: method === "thread/start" ? "thread-1" : params.threadId },
      ...(method === "thread/resume" && !this.resumeWithoutTurn ? { turn: this.turns.at(-1) } : {}),
      sandbox: { type: params.sandbox === "read-only" ? "readOnly" : "workspaceWrite" },
      approvalPolicy: params.approvalPolicy,
    };
    if (method === "turn/start") {
      if (this.failTurn) throw new Error("operation outcome is UNKNOWN");
      const id = `turn-${this.turns.length + 1}`;
      this.turns.push({ id, status: "inProgress" });
      return { turn: { id, status: "inProgress" } };
    }
    throw new Error(`unexpected ${method}`);
  }
}

function schema(name: string): Record<string, unknown> {
  const definition = TOOL_DEFINITIONS.find(item => item.name === name);
  assert.ok(definition);
  return definition.inputSchema;
}

function object(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

test("production Host lead v2 and reviewer v3 request shapes use closed native boundaries", async () => {
  assert.equal(TOOL_DEFINITIONS.length, 11);
  assert.equal(TOOL_DEFINITIONS.some(item => ["codex_thread_start", "codex_turn_start", "codex_checkpoint"].includes(item.name)), false);
  const turnSchema = schema("codex_turn");
  assert.equal(turnSchema.additionalProperties, false);
  const delivery = object(object(turnSchema.properties).delivery_action_tool);
  assert.equal(delivery.additionalProperties, false);
  assert.deepEqual(object(object(delivery.properties).version).enum, [2, 3]);
  const cases = [
    { text: "task", cwd: "/work", model: "gpt-6-sol", effort: "high", sandbox: "workspace-write", approval_policy: "never", delivery_action_tool: { version: 2 } },
    { text: "review", cwd: "/work", model: "gpt-6-sol", effort: "high", sandbox: "read-only", approval_policy: "never", delivery_action_tool: { version: 3 } },
  ];
  for (const [index, args] of cases.entries()) {
    const native = new NativeFixture();
    const result = await new ControlSurface(native).call("codex_turn", args) as Record<string, unknown>;
    assert.equal(result.accepted, true);
    assert.equal(result.delivery_boundary, index === 0 ? "structured-effects-no-native-shell-v1" : "review-source-no-native-shell-v1");
    const start = native.calls.find(call => call.method === "thread/start")!.params;
    assert.deepEqual(start.config, { features: { shell_tool: false, unified_exec: false }, web_search: "disabled" });
    assert.deepEqual((start.dynamicTools as { name: string }[]).map(item => item.name), [index === 0 ? "delivery_action" : "review_source"]);
    assert.equal((native.calls.find(call => call.method === "turn/start")!.params.sandboxPolicy as Record<string, unknown>).type,
      index === 0 ? "workspaceWrite" : "readOnly");
  }
  const native = new NativeFixture();
  const surface = new ControlSurface(native);
  for (const bad of [{ version: 1 }, { version: 4 }, { version: 2, extra: true }, { version: "2" }]) {
    await assert.rejects(surface.call("codex_turn", { ...cases[0], delivery_action_tool: bad }));
  }
  assert.equal(native.calls.filter(call => call.method === "thread/start").length, 0);
  await assert.rejects(surface.call("codex_turn", { ...cases[0], sandbox: "danger-full-access" }));
  await assert.rejects(surface.call("codex_turn", { ...cases[1], approval_policy: "on-request" }));
});

test("production Host goal schema is closed and exact thread record survives restart and clear", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-goal-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const goalSchema = schema("codex_goal");
  assert.equal(goalSchema.additionalProperties, false);
  assert.deepEqual(object(object(goalSchema.properties).operation).enum, ["set", "get", "clear", "reconnect"]);
  const native = new NativeFixture();
  const first = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  const set = await first.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "finish" }) as Record<string, any>;
  assert.equal(set.goal.threadId, "thread-1");
  assert.equal(set.goal.objective, "finish");
  assert.equal(set.goal.id, "native-goal-1");
  const second = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  const get = await second.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>;
  assert.deepEqual(get.goal, set.goal);
  assert.equal((await second.call("codex_goal", { operation: "get", thread_id: "thread-2" }) as Record<string, any>).goal, null);
  await assert.rejects(first.call("codex_goal", { operation: "get", thread_id: "thread-1", objective: "x" }));
  await assert.rejects(first.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "x", extra: 1 }));
  await assert.rejects(first.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "x", token_budget: 100 }));
  await second.call("codex_goal", { operation: "clear", thread_id: "thread-1" });
  assert.equal((await first.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>).goal, null);
});

test("deployed native goal is imported once only with exact thread binding", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-native-goal-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  class NativeGoalFixture extends NativeFixture {
    override async request(method: string, params: unknown): Promise<unknown> {
      if (method === "thread/goal/get") return { goal: { threadId: (params as Record<string, unknown>).threadId,
        objective: "existing production objective", status: "active" } };
      if (method === "thread/goal/clear") return { cleared: true };
      return super.request(method, params);
    }
  }
  const native = new NativeGoalFixture();
  const first = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  const imported = await first.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(imported.goal.objective, "existing production objective");
  assert.equal(imported.goal.threadId, "thread-1");
  const second = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  assert.deepEqual((await second.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>).goal, imported.goal);
  await first.call("codex_goal", { operation: "clear", thread_id: "thread-1" });
  assert.equal((await first.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>).goal, null);
  const mismatch = new ControlSurface(new class extends NativeFixture {
    override async request(method: string, params: unknown): Promise<unknown> {
      if (method === "thread/goal/get") return { goal: { threadId: "other", objective: "wrong", status: "active" } };
      return super.request(method, params);
    }
  }(), undefined, undefined, undefined, new GoalStore(directory));
  await assert.rejects(mismatch.call("codex_goal", { operation: "get", thread_id: "thread-2" }), /different thread id/);
});

test("reconnect returns exact native turn, persists receipt, and never duplicates after restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-reconnect-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeFixture();
  const first = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  await first.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "finish" });
  const args = { operation: "reconnect", thread_id: "thread-1", sandbox: "workspace-write", approval_policy: "never" };
  const reconnect = await first.call("codex_goal", args) as Record<string, any>;
  assert.equal(reconnect.resumed, true);
  assert.equal(reconnect.receipt.schema, "CodexGoalReconnectReceipt");
  assert.equal(reconnect.receipt.status, "started");
  assert.equal(reconnect.receipt.turn_id, "turn-1");
  assert.equal(reconnect.receipt.thread_id, "thread-1");
  assert.equal("reconnect_id" in reconnect.receipt, false);
  const second = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  const read = await second.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>;
  assert.deepEqual(read.reconnect_receipt, reconnect.receipt);
  assert.equal(read.lifecycle.active_turn_id, null);
  assert.equal(read.lifecycle.latest_turn_id, "turn-1");
  assert.equal(read.lifecycle.reconnect_outcome, "started");
  assert.equal(read.lifecycle.goal_digest, read.goal.digest);
  const duplicate = await second.call("codex_goal", args) as Record<string, any>;
  assert.deepEqual(duplicate.receipt, reconnect.receipt);
  assert.equal(native.calls.filter(call => call.method === "thread/resume").length, 1);
  assert.equal(native.calls.filter(call => call.method === "turn/start").length, 0);
});

test("reconnect preserves an imported native goal and uses native resume identity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-import-reconnect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new class extends NativeFixture {
    override async request(method: string, params: unknown): Promise<unknown> {
      if (method === "thread/goal/get") return { goal: { threadId: "thread-1", objective: "legacy objective", status: "active" } };
      if (method === "thread/goal/clear") { this.calls.push({ method, params: params as Record<string, unknown> }); return { cleared: true }; }
      return super.request(method, params);
    }
  }();
  native.turns = [{ id: "legacy-turn", status: "completed" }];
  const surface = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  await surface.call("codex_goal", { operation: "get", thread_id: "thread-1" });
  const result = await surface.call("codex_goal", { operation: "reconnect", thread_id: "thread-1",
    sandbox: "workspace-write", approval_policy: "never" }) as Record<string, any>;
  assert.equal(result.receipt.status, "started");
  assert.equal(result.receipt.turn_id, "turn-2");
  assert.equal(native.calls.filter(call => call.method === "thread/goal/clear").length, 0);
  assert.equal(native.calls.filter(call => call.method === "turn/start").length, 0);
});

test("ambiguous native in-progress state and lost acknowledgement stay unknown without replay", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-unknown-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeFixture();
  const surface = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  await surface.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "finish" });
  native.turns = [{ id: "old-turn", status: "inProgress" }];
  const args = { operation: "reconnect", thread_id: "thread-1" };
  const unknown = await surface.call("codex_goal", args) as Record<string, any>;
  assert.equal(unknown.receipt.status, "unknown");
  assert.equal(unknown.receipt.turn_id, "old-turn");
  assert.equal(native.calls.filter(call => call.method === "turn/start").length, 0);
  const restarted = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  assert.deepEqual((await restarted.call("codex_goal", args) as Record<string, any>).receipt, unknown.receipt);
  assert.equal(native.calls.filter(call => call.method === "turn/start").length, 0);
});

test("live active turn is selected exactly and completed bound turn is terminal", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-active-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeFixture();
  native.runtime.markTurnAccepted("thread-1", "native-active");
  const surface = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  await surface.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "finish" });
  const selected = await surface.call("codex_goal", { operation: "reconnect", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(selected.receipt.status, "already_in_progress");
  assert.equal(selected.receipt.turn_id, "native-active");
  assert.equal(native.calls.filter(call => call.method === "turn/start").length, 0);
  native.turns = [{ id: "native-active", status: "completed" }];
  native.goal!.status = "complete";
  const restarted = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  const get = await restarted.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(get.goal.status, "complete");
  assert.deepEqual(get.reconnect_receipt, selected.receipt);
});

test("lost reconnect turn acknowledgement persists unknown and never replays", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-lost-ack-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeFixture();
  native.failTurn = true;
  const surface = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  await surface.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "finish" });
  const args = { operation: "reconnect", thread_id: "thread-1", sandbox: "workspace-write", approval_policy: "never" };
  const unknown = await surface.call("codex_goal", args) as Record<string, any>;
  assert.equal(unknown.receipt.status, "unknown");
  assert.equal(unknown.receipt.turn_id, null);
  const restarted = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  assert.deepEqual((await restarted.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>).reconnect_receipt, unknown.receipt);
  assert.deepEqual((await restarted.call("codex_goal", args) as Record<string, any>).receipt, unknown.receipt);
  assert.equal(native.calls.filter(call => call.method === "thread/resume").length, 1);
});

test("unknown reconnect is reconciled by read only projection after restart without replay", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-reconcile-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeFixture();
  const first = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  await first.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "finish" });
  native.failTurn = true;
  const unknown = await first.call("codex_goal", { operation: "reconnect", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(unknown.receipt.status, "unknown");
  native.turns.push({ id: "late-native-turn", status: "inProgress" });
  const restarted = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  const read = await restarted.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(read.lifecycle.reconnect_outcome, "unknown");
  assert.equal(read.lifecycle.candidate_turn_id, "late-native-turn");
  assert.equal(read.lifecycle.latest_turn_id, "late-native-turn");
  assert.ok(read.lifecycle.uncertainty.includes("reconnect_outcome_not_proven"));
  assert.equal(native.calls.filter(call => call.method === "thread/resume").length, 1);
});

test("resume without native turn identity remains unknown while exposing latest candidate", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-no-turn-id-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeFixture();
  native.resumeWithoutTurn = true;
  const surface = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  await surface.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "finish" });
  const response = await surface.call("codex_goal", { operation: "reconnect", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(response.receipt.status, "unknown");
  assert.equal(response.receipt.turn_id, null);
  const read = await surface.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(read.lifecycle.candidate_turn_id, "turn-1");
  assert.ok(read.lifecycle.uncertainty.includes("reconnect_outcome_not_proven"));
  assert.equal(native.calls.filter(call => call.method === "turn/start").length, 0);
});

test("terminal native goal yields no new turn and exact thread mismatch fails closed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lcb-terminal-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeFixture();
  const surface = new ControlSurface(native, undefined, undefined, undefined, new GoalStore(directory));
  await surface.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "finish" });
  native.goal!.status = "complete";
  native.turns = [{ id: "last-native", status: "completed" }];
  const response = await surface.call("codex_goal", { operation: "reconnect", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(response.receipt.status, "terminal");
  assert.equal(response.receipt.turn_id, "last-native");
  assert.equal(native.calls.filter(call => call.method === "thread/resume").length, 0);
  const wrong = new class extends NativeFixture {
    override async request(method: string, params: unknown): Promise<unknown> {
      if (method === "thread/read") return { thread: { id: "wrong-thread", turns: [] } };
      return super.request(method, params);
    }
  }();
  wrong.goal = { threadId: "thread-1", objective: "finish", status: "complete" };
  const restarted = new ControlSurface(wrong, undefined, undefined, undefined, new GoalStore(directory));
  await assert.rejects(restarted.call("codex_goal", { operation: "get", thread_id: "thread-1" }), /different thread id/);
});
