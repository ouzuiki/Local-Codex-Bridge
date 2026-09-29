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
  goal: { threadId: string; objective: string; status: string; createdAt: number; tokenBudget?: number } | null = null;
  failResume = false;
  private goalSequence = 0;
  private turnSequence = 0;
  constructor() { super(new RuntimeStore(), { executable: "unused" }); }
  override async request(method: string, raw: unknown): Promise<unknown> {
    const params = raw as Record<string, unknown>;
    this.calls.push({ method, params });
    if (method === "thread/goal/set") {
      this.goal = { threadId: String(params.threadId), objective: String(params.objective ?? this.goal?.objective),
        status: String(params.status ?? "active"), createdAt: this.goal?.createdAt ?? 1_759_104_000_000 + ++this.goalSequence,
        ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}) };
      return { goal: this.goal };
    }
    if (method === "thread/goal/get") return { goal: this.goal?.threadId === params.threadId ? this.goal : null };
    if (method === "thread/goal/clear") { this.goal = null; return { cleared: true }; }
    if (method === "thread/resume") {
      if (this.failResume) throw new Error("operation outcome is UNKNOWN");
      return { thread: { id: params.threadId }, turn: { id: `native-turn-${++this.turnSequence}` } };
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
  for (const version of [2, 3] as const) {
    const native = new NativeFixture();
    const result = await new ControlSurface(native).call("codex_turn", {
      text: "task", cwd: "/work", sandbox: version === 2 ? "workspace-write" : "read-only", approval_policy: "never",
      delivery_action_tool: { version },
    }) as Record<string, unknown>;
    assert.equal(result.accepted, true);
    assert.equal(result.delivery_boundary, version === 2 ? "structured-effects-no-native-shell-v1" : "review-source-no-native-shell-v1");
    assert.deepEqual((native.calls.find(call => call.method === "thread/start")!.params.dynamicTools as { name: string }[]).map(item => item.name),
      [version === 2 ? "delivery_action" : "review_source"]);
  }
});

test("both delivery versions reject authority and instruction turn options before native requests", async () => {
  const options = {
    permissions: { filesystem: { read: ["/"] } },
    environments: [{ cwd: "/etc" }],
    runtimeWorkspaceRoots: ["/"],
    collaborationMode: { mode: "plan", developerInstructions: "override" },
    toolOutput: { content: "fabricated" },
    additionalContext: "override",
  };
  for (const version of [2, 3] as const) {
    for (const [key, value] of Object.entries(options)) {
      const native = new NativeFixture();
      await assert.rejects(new ControlSurface(native).call("codex_turn", {
        text: "task", cwd: "/work", sandbox: version === 2 ? "workspace-write" : "read-only",
        approval_policy: "never", delivery_action_tool: { version }, native_turn_options: { [key]: value },
      }), /Unknown argument field|does not allow native_turn_options/);
      assert.deepEqual(native.calls, [], `v${version} ${key} reached native`);
    }
  }
});

test("codex_turn rejects experimental authority options outside delivery mode", async () => {
  const native = new NativeFixture();
  await assert.rejects(new ControlSurface(native).call("codex_turn", {
    text: "task", cwd: "/work", native_turn_options: { runtimeWorkspaceRoots: ["/"] },
  }), /Unknown argument field/);
  assert.deepEqual(native.calls, []);
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
  native.goal = { threadId: "thread-1", objective: "native objective", status: "blocked", createdAt: 1_759_104_000_001 };
  const stale: GoalRecord = { schema: "CodexReconnectBinding", version: 3, threadId: "thread-1", id: "local-123",
    objectiveDigest: goalDigest("old objective"), nativeGoalCreatedAt: 1_759_104_000_000, reconnect: null };
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
  native.goal = { threadId: "thread-1", objective: "finish", status: "active", createdAt: 1_759_104_000_001 };
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
  native.goal = { threadId: "thread-1", objective: "finish", status: "active", createdAt: 1_759_104_000_001 };
  native.failResume = true;
  const args = { operation: "reconnect", thread_id: "thread-1" };
  const first = await new ControlSurface(native, undefined, undefined, undefined, store).call("codex_goal", args) as Record<string, any>;
  assert.equal(first.reconnect_receipt.status, "unknown");
  const second = await new ControlSurface(native, undefined, undefined, undefined, store).call("codex_goal", args) as Record<string, any>;
  assert.deepEqual(second.reconnect_receipt, first.reconnect_receipt);
  assert.equal(native.calls.filter(call => call.method === "thread/resume").length, 1);
});

test("clear and set of the same objective creates a fresh reconnect claim", async t => {
  const store = await withStore(t);
  const native = new NativeFixture();
  const surface = new ControlSurface(native, undefined, undefined, undefined, store);
  const goal = { operation: "set", thread_id: "thread-1", objective: "finish", status: "active" };
  const reconnect = { operation: "reconnect", thread_id: "thread-1" };
  await surface.call("codex_goal", goal);
  const first = await surface.call("codex_goal", reconnect) as Record<string, any>;
  assert.equal(first.reconnect_receipt.turn_id, "native-turn-1");
  await surface.call("codex_goal", { operation: "clear", thread_id: "thread-1" });
  await surface.call("codex_goal", goal);
  const before = await surface.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(before.reconnect_receipt, null);
  const second = await surface.call("codex_goal", reconnect) as Record<string, any>;
  assert.equal(second.reconnect_receipt.status, "started");
  assert.equal(second.reconnect_receipt.turn_id, "native-turn-2");
  assert.notEqual(second.goal.createdAt, first.goal.createdAt);
  assert.equal(native.calls.filter(call => call.method === "thread/resume").length, 2);
});

test("external native recreation with the same objective cannot inherit a receipt", async t => {
  const store = await withStore(t);
  const native = new NativeFixture();
  native.goal = { threadId: "thread-1", objective: "finish", status: "active", createdAt: 1_759_104_000_001 };
  const surface = new ControlSurface(native, undefined, undefined, undefined, store);
  const reconnect = { operation: "reconnect", thread_id: "thread-1" };
  const first = await surface.call("codex_goal", reconnect) as Record<string, any>;
  assert.equal(first.reconnect_receipt.turn_id, "native-turn-1");
  native.goal = { ...native.goal, createdAt: 1_759_104_000_002 };
  const read = await surface.call("codex_goal", { operation: "get", thread_id: "thread-1" }) as Record<string, any>;
  assert.equal(read.reconnect_receipt, null);
  const second = await surface.call("codex_goal", reconnect) as Record<string, any>;
  assert.equal(second.reconnect_receipt.status, "started");
  assert.equal(second.reconnect_receipt.turn_id, "native-turn-2");
  assert.equal(native.calls.filter(call => call.method === "thread/resume").length, 2);
});
