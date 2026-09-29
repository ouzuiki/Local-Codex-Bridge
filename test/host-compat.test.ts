import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerManager } from "../src/app-server.js";
import { GoalStore, goalDigest, type GoalRecord } from "../src/goal-store.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

class NativeFixture extends AppServerManager {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  goal: { threadId: string; objective: string; status: string; id?: string; tokenBudget?: number } | null = null;
  failResume = false;
  constructor() { super(new RuntimeStore(), { executable: "unused" }); }
  override async request(method: string, raw: unknown): Promise<unknown> {
    const params = raw as Record<string, unknown>;
    this.calls.push({ method, params });
    if (method === "thread/goal/set") {
      this.goal = { threadId: String(params.threadId), objective: String(params.objective ?? this.goal?.objective),
        status: String(params.status ?? "active"),
        ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}) };
      return { goal: this.goal };
    }
    if (method === "thread/goal/get") return { goal: this.goal?.threadId === params.threadId ? this.goal : null };
    if (method === "thread/goal/clear") { this.goal = null; return { cleared: true }; }
    if (method === "thread/resume") {
      if (this.failResume) throw new Error("operation outcome is UNKNOWN");
      return { thread: { id: params.threadId }, turn: { id: "native-turn-1" } };
    }
    if (method === "thread/start") return { thread: { id: "native-thread-1" }, sandbox: { type: params.sandbox === "read-only" ? "readOnly" : "workspaceWrite" }, approvalPolicy: params.approvalPolicy };
    if (method === "turn/start") return { turn: { id: "native-turn-1", status: "inProgress" } };
    throw new Error(`unexpected ${method}`);
  }
}

async function withStore(t: { after(fn: () => Promise<void>): void }): Promise<GoalStore> {
  const directory = await mkdtemp(join(tmpdir(), "lcb-native-goal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new GoalStore(directory);
}

test("Host delivery boundaries and Thick native tools coexist", async () => {
  const names = TOOL_DEFINITIONS.map(item => item.name);
  for (const name of ["codex_thread_start", "codex_turn_start", "codex_native_read", "codex_native_action",
    "codex_experimental_read", "codex_experimental_action", "codex_goal"]) assert.ok(names.includes(name));
  assert.ok(!names.includes("codex_checkpoint"));
  const native = new NativeFixture();
  const result = await new ControlSurface(native).call("codex_turn", {
    text: "task", cwd: "/work", sandbox: "workspace-write", approval_policy: "never",
    delivery_action_tool: { version: 2 },
  }) as Record<string, unknown>;
  assert.equal(result.accepted, true);
  assert.deepEqual((native.calls.find(call => call.method === "thread/start")!.params.dynamicTools as { name: string }[]).map(item => item.name), ["delivery_action"]);
});

test("native Goal set/get/clear carry current status and budget", async t => {
  const native = new NativeFixture();
  const surface = new ControlSurface(native, undefined, undefined, undefined, await withStore(t));
  const set = await surface.call("codex_goal", { operation: "set", thread_id: "thread-1", objective: "finish", status: "paused", token_budget: 500 }) as Record<string, any>;
  assert.equal("id" in set.goal, false);
  assert.equal(set.goal.status, "paused");
  assert.equal(set.goal.tokenBudget, 500);
  assert.deepEqual((await surface.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>).goal, set.goal);
  assert.deepEqual(native.calls.filter(call => call.method === "thread/goal/set")[0]?.params,
    { threadId: "thread-1", objective: "finish", status: "paused", tokenBudget: 500 });
  await surface.call("codex_goal", { operation: "set", thread_id: "thread-1", status: "blocked", token_budget: 0 });
  assert.deepEqual(native.calls.filter(call => call.method === "thread/goal/set")[1]?.params,
    { threadId: "thread-1", status: "blocked", tokenBudget: 0 });
  await surface.call("codex_goal", { operation: "clear", thread_id: "thread-1" });
  assert.equal((await surface.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>).goal, null);
});

test("Bridge receipt cannot override conflicting native Goal truth", async t => {
  const store = await withStore(t);
  const native = new NativeFixture();
  native.goal = { threadId: "thread-1", objective: "native objective", status: "blocked" };
  const stale: GoalRecord = { schema: "CodexReconnectBinding", version: 2, threadId: "thread-1", id: "local-123",
    objectiveDigest: goalDigest("old objective"), nativeGoalId: "native-goal-1", reconnect: null };
  await store.write(stale);
  const surface = new ControlSurface(native, undefined, undefined, undefined, store);
  const get = await surface.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(get.goal.objective, "native objective");
  assert.equal(get.goal.status, "blocked");
  assert.equal(get.reconnect_receipt, null);
  await assert.rejects(surface.call("codex_goal", { operation: "reconnect", thread_id: "thread-1" }), /does not permit reconnect/);
  assert.equal(native.calls.some(call => call.method === "thread/resume"), false);
});

test("reconnect claims one exact native resume and preserves its receipt across Bridge restart", async t => {
  const store = await withStore(t);
  const native = new NativeFixture();
  native.goal = { threadId: "thread-1", objective: "finish", status: "active" };
  const first = new ControlSurface(native, undefined, undefined, undefined, store);
  const args = { operation: "reconnect", thread_id: "thread-1" };
  const result = await first.call("codex_goal", args) as Record<string, any>;
  assert.equal(result.reconnect_receipt.status, "started");
  assert.equal(result.reconnect_receipt.turn_id, "native-turn-1");
  const second = new ControlSurface(native, undefined, undefined, undefined, store);
  assert.deepEqual((await second.call("codex_goal", args) as Record<string, any>).reconnect_receipt, result.reconnect_receipt);
  assert.equal(native.calls.filter(call => call.method === "thread/resume").length, 1);
});

test("ambiguous reconnect remains UNKNOWN and is never blindly retried", async t => {
  const store = await withStore(t);
  const native = new NativeFixture();
  native.goal = { threadId: "thread-1", objective: "finish", status: "active" };
  native.failResume = true;
  const args = { operation: "reconnect", thread_id: "thread-1" };
  const first = await new ControlSurface(native, undefined, undefined, undefined, store).call("codex_goal", args) as Record<string, any>;
  assert.equal(first.reconnect_receipt.status, "unknown");
  const second = await new ControlSurface(native, undefined, undefined, undefined, store).call("codex_goal", args) as Record<string, any>;
  assert.deepEqual(second.reconnect_receipt, first.reconnect_receipt);
  assert.equal(native.calls.filter(call => call.method === "thread/resume").length, 1);
});
