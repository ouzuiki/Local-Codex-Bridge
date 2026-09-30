import assert from "node:assert/strict";
import test from "node:test";
import { AppServerManager } from "../src/app-server.js";
import { RuntimeStore, type RpcId } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";
import { NATIVE_GROUPS } from "../src/native.js";

class NativeFixture extends AppServerManager {
  calls: { method: string; params: unknown }[] = [];
  responses: { id: RpcId; result: unknown }[] = [];
  constructor() { super(new RuntimeStore(), { executable: "unused" }); }
  override async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/fork") return { thread: { id: "fork-native-id" } };
    if (method === "thread/start") return { thread: { id: "native-thread", cwd: (params as Record<string, unknown>).cwd, ephemeral: false } };
    if (method === "thread/resume") return { thread: { id: (params as Record<string, unknown>).threadId } };
    if (method === "turn/start") return { turn: { id: "native-turn", status: "inProgress" } };
    if (method === "turn/steer") return { turnId: (params as Record<string, unknown>).expectedTurnId };
    if (method === "thread/read") return { thread: { id: (params as Record<string, unknown>).threadId, title: "native", turns: [] } };
    return { native: method, items: [] };
  }
  override async respond(id: RpcId, result: unknown): Promise<void> { this.responses.push({ id, result }); }
}

test("stable native reads and actions use exact allowlists and bounded arguments", async () => {
  const native = new NativeFixture();
  const surface = new ControlSurface(native);
  assert.ok(Object.hasOwn(NATIVE_GROUPS.codex_native_read, "plugin/skill/read"));
  assert.ok(Object.hasOwn(NATIVE_GROUPS.codex_native_read, "app/read"));
  assert.ok(Object.hasOwn(NATIVE_GROUPS.codex_native_read, "thread/attachment/list"));
  for (const operation of ["thread/turns/list", "thread/items/list", "thread/attachment/list"]) {
    await surface.call("codex_native_read", { operation, params: { threadId: "native-thread", limit: 5 } });
  }
  const read = await surface.call("codex_native_read", { operation: "thread/read", params: { threadId: "native-thread", includeTurns: true } }) as Record<string, any>;
  assert.equal(read.result.thread.title, "native");
  await surface.call("codex_native_read", { operation: "thread/list", params: { originators: [], sortKey: "updated_at", sourceKinds: ["cli"] } });
  await surface.call("codex_native_read", { operation: "account/workspaceMessages/read", params: {} });
  assert.equal(native.calls.at(-1)?.params, null);
  await surface.call("codex_native_action", { operation: "thread/attachment/add", params: { threadId: "native-thread", attachmentType: "note", identityKey: "key", payload: { value: "x" } } });
  await surface.call("codex_native_action", { operation: "thread/attachment/remove", params: { threadId: "native-thread", attachmentType: "note", identityKey: "key" } });
  const fork = await surface.call("codex_native_action", { operation: "thread/fork", params: { threadId: "native-thread" } }) as Record<string, any>;
  assert.equal(fork.result.thread.id, "fork-native-id");
  await surface.call("codex_native_action", { operation: "thread/compact/start", params: { threadId: "native-thread" } });
  await surface.call("codex_native_action", { operation: "thread/revert", params: { threadId: "native-thread", beforeTurnId: "turn-1" } });
  for (const operation of ["command/exec", "fs/readFile", "config/value/write", "plugin/install", "thread/shellCommand", "thread/rollback"]) {
    await assert.rejects(surface.call("codex_native_action", { operation, params: {} }), /Unknown native operation/);
    await assert.rejects(surface.call("codex_native_read", { operation, params: {} }), /Unknown native operation/);
  }
  await assert.rejects(surface.call("codex_native_action", { operation: "thread/revert", params: { threadId: "native-thread", beforeTurnId: "turn-1", command: "whoami" } }), /Unsupported native parameter/);
});

test("experimental groups expose audited methods but reject administration", async () => {
  const native = new NativeFixture();
  const surface = new ControlSurface(native);
  await surface.call("codex_experimental_read", { operation: "thread/searchOccurrences", params: { threadId: "native-thread", searchTerm: "term" } });
  await surface.call("codex_experimental_read", { operation: "project/list", params: { limit: 5 } });
  await surface.call("codex_experimental_action", { operation: "thread/queue/add", params: { threadId: "native-thread", clientUserMessageId: "u-1", input: [{ type: "text", text: "queued" }] } });
  await surface.call("codex_experimental_action", { operation: "thread/memoryMode/set", params: { threadId: "native-thread", mode: "default" } });
  for (const operation of ["project/delete", "thread/backgroundTerminals/terminate", "process/spawn", "memory/reset"]) {
    await assert.rejects(surface.call("codex_experimental_action", { operation, params: {} }), /Unknown native operation/);
  }
});

test("all current UserInput variants and turn options reach native turn/start", async () => {
  const native = new NativeFixture();
  const surface = new ControlSurface(native);
  const input = [
    { type: "text", text: "hello", text_elements: [] },
    { type: "image", url: "https://example.invalid/image.png", detail: "high" },
    { type: "image", fileId: "file-1" },
    { type: "localImage", path: "/tmp/image.png" },
    { type: "audio", url: "https://example.invalid/audio.wav" },
    { type: "localAudio", path: "/tmp/audio.wav" },
    { type: "skill", name: "skill", path: "/tmp/SKILL.md" },
    { type: "mention", name: "file", path: "/tmp/file" },
  ];
  await surface.call("codex_turn", { thread_id: "native-thread", input, output_schema: { type: "object" },
    turn_trigger: "host", native_turn_options: { multiAgentMode: "explicitRequestOnly", clientUserMessageId: "message-1" } });
  const turn = native.calls.find(call => call.method === "turn/start")?.params as Record<string, unknown>;
  assert.deepEqual(turn.input, input);
  assert.deepEqual(turn.outputSchema, { type: "object" });
  assert.equal(turn.turnTrigger, "host");
  assert.equal(turn.multiAgentMode, "explicitRequestOnly");
  assert.equal(turn.clientUserMessageId, "message-1");
});

test("named turn-start uses an exact idle native thread without thread lifecycle replay", async () => {
  const native = new NativeFixture();
  native.runtime.ensureThread("native-thread");
  const surface = new ControlSurface(native);
  const result = await surface.call("codex_turn_start", { thread_id: "native-thread", text: "continue", effort: "high" }) as Record<string, unknown>;
  assert.equal(result.turn_id, "native-turn");
  assert.deepEqual(native.calls.map(call => call.method), ["turn/start"]);
  const unknown = new NativeFixture();
  await assert.rejects(new ControlSurface(unknown).call("codex_turn_start", { thread_id: "unknown", text: "no" }), /thread.status/);
  assert.deepEqual(unknown.calls.map(call => call.method), ["thread/read"]);
});

test("steer forwards native UserInput without changing exact turn identity", async () => {
  const native = new NativeFixture();
  const input = [{ type: "localImage", path: "/tmp/screenshot.png" }, { type: "text", text: "inspect" }];
  const result = await new ControlSurface(native).call("codex_steer", { thread_id: "native-thread", expected_turn_id: "native-turn", input,
    client_user_message_id: "message-1" }) as Record<string, unknown>;
  assert.equal(result.turn_id, "native-turn");
  assert.deepEqual((native.calls[0]?.params as Record<string, unknown>).input, input);
  assert.equal((native.calls[0]?.params as Record<string, unknown>).clientUserMessageId, "message-1");
});

test("dynamic tool and MCP elicitation requests round-trip exact pending IDs", async () => {
  const native = new NativeFixture();
  const surface = new ControlSurface(native);
  native.runtime.markTurnAccepted("native-thread", "native-turn");
  native.runtime.recordServerRequest("tool-raw-id", "item/tool/call", { threadId: "native-thread", turnId: "native-turn", tool: "delivery_action" });
  native.runtime.recordServerRequest(42, "mcpServer/elicitation/request", { threadId: "native-thread", turnId: "native-turn", message: "Continue?" });
  await assert.rejects(surface.call("codex_respond", { request_id: "tool-raw-id", thread_id: "native-thread", turn_id: "native-turn", method: "item/tool/call", response: { success: true } }), /contentItems/);
  assert.equal((native.runtime.observe("native-thread", 0, 10)?.pending_requests as unknown[]).length, 2);
  await surface.call("codex_respond", { request_id: "tool-raw-id", thread_id: "native-thread", turn_id: "native-turn", method: "item/tool/call",
    response: { success: true, contentItems: [{ type: "inputText", text: "done" }] } });
  await surface.call("codex_respond", { request_id: 42, thread_id: "native-thread", turn_id: "native-turn", method: "mcpServer/elicitation/request",
    response: { action: "accept", content: { answer: "yes" } } });
  assert.deepEqual(native.responses, [
    { id: "tool-raw-id", result: { success: true, contentItems: [{ type: "inputText", text: "done" }] } },
    { id: 42, result: { action: "accept", content: { answer: "yes" } } },
  ]);
  assert.equal((native.runtime.observe("native-thread", 0, 10)?.pending_requests as unknown[]).length, 0);
  native.runtime.recordServerRequest("future-raw-id", "future/newRequest", { threadId: "native-thread", turnId: "native-turn" });
  await assert.rejects(surface.call("codex_respond", { request_id: "future-raw-id", thread_id: "native-thread", turn_id: "native-turn",
    method: "future/newRequest", response: { guessed: true } }), /Unsupported app-server request method/);
  assert.equal((native.runtime.observe("native-thread", 0, 10)?.pending_requests as unknown[]).length, 1);
});

class PagedFixture extends NativeFixture {
  constructor(private readonly page: unknown) { super(); }
  override async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return method === "thread/read" ? { thread: { id: "other-thread" } } : this.page;
  }
}

test("read groups separate bounded projection from exact lossless delivery", async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, text: "t".repeat(index === 0 ? 20_000 : 10) }));
  const page = { data: items, nextCursor: "cursor-after-100" };
  const surface = new ControlSurface(new PagedFixture(page));
  const call = { operation: "thread/items/list", params: { threadId: "native-thread", limit: 100 } };

  const bounded = await surface.call("codex_native_read", call) as Record<string, any>;
  assert.deepEqual(bounded.delivery, { mode: "bounded", lossless: false });
  assert.notDeepEqual(bounded.result, page);

  const exact = await surface.call("codex_native_read", { ...call, delivery: "exact" }) as Record<string, any>;
  assert.deepEqual(exact.delivery, { mode: "exact", lossless: true });
  assert.deepEqual(exact.result, page);
  assert.equal(exact.result.data.length, 100);
  assert.equal(exact.result.nextCursor, "cursor-after-100");

  const small = await new ControlSurface(new PagedFixture({ data: [], nextCursor: null })).call("codex_experimental_read",
    { operation: "thread/queue/list", params: { threadId: "native-thread" } }) as Record<string, any>;
  assert.deepEqual(small.delivery, { mode: "bounded", lossless: true });
});

test("exact delivery fails whole instead of redacting, cutting, or exposing secrets", async () => {
  const call = (page: unknown) => new ControlSurface(new PagedFixture(page)).call("codex_native_read",
    { operation: "thread/turns/list", params: { threadId: "native-thread" }, delivery: "exact" });
  await assert.rejects(call({ data: [{ text: "export OPENAI_API_KEY=sk-live-secret-value" }], nextCursor: null }), /^Error: exact_delivery_failed: content_policy:/);
  await assert.rejects(call({ data: [{ apiKey: "opaque" }], nextCursor: null }), /exact_delivery_failed: content_policy:/);
  await assert.rejects(call({ data: [{ text: "x".repeat(300 * 1024) }], nextCursor: null }), /exact_delivery_failed: size: .*262144-byte bound/);
  const accepted = await call({ data: [{ tokenUsage: { total: 1 }, token: null }], nextCursor: null }) as Record<string, any>;
  assert.equal(accepted.delivery.lossless, true);

  const bounded = await new ControlSurface(new PagedFixture({ data: [{ text: "Bearer abcdefghijklmnop" }] })).call("codex_native_read",
    { operation: "thread/turns/list", params: { threadId: "native-thread" } }) as Record<string, any>;
  assert.equal(bounded.delivery.lossless, false);
  assert.doesNotMatch(JSON.stringify(bounded.result), /abcdefghijklmnop/);
});

test("exact delivery is limited to read groups and keeps native identity checks", async () => {
  const surface = new ControlSurface(new PagedFixture({}));
  await assert.rejects(surface.call("codex_native_action", { operation: "thread/archive", params: { threadId: "native-thread" }, delivery: "exact" }), /Unknown top-level argument/);
  await assert.rejects(surface.call("codex_experimental_action", { operation: "thread/queue/delete", params: { threadId: "native-thread", queuedSubmissionId: "q" }, delivery: "exact" }), /Unknown top-level argument/);
  await assert.rejects(surface.call("codex_native_read", { operation: "thread/turns/list", params: { threadId: "native-thread" }, delivery: "partial" }), /delivery must be bounded or exact/);
  await assert.rejects(surface.call("codex_native_read", { operation: "thread/read", params: { threadId: "native-thread" }, delivery: "exact" }), /different thread id/);
  for (const group of ["codex_native_read", "codex_experimental_read"] as const) {
    const variants = (TOOL_DEFINITIONS.find((tool) => tool.name === group)!.inputSchema.oneOf as Array<Record<string, any>>);
    assert.ok(variants.every((variant) => variant.properties.delivery?.enum?.join() === "bounded,exact"));
  }
  for (const group of ["codex_native_action", "codex_experimental_action"] as const) {
    const variants = (TOOL_DEFINITIONS.find((tool) => tool.name === group)!.inputSchema.oneOf as Array<Record<string, any>>);
    assert.ok(variants.every((variant) => variant.properties.delivery === undefined));
  }
});
