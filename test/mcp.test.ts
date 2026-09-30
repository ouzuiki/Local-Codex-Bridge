import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { AppServerManager } from "../src/app-server.js";
import { McpStdioServer } from "../src/mcp.js";
import { NATIVE_GROUPS } from "../src/native.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, SUPPORTED_RESPOND_METHODS, TOOL_DEFINITIONS } from "../src/tools.js";
import { VERSION } from "../src/version.js";

type RpcId = string | number;

class TestClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, (message: Record<string, unknown>) => void>();
  readonly #unclaimed: Record<string, unknown>[] = [];
  #buffer = "";

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
    this.child = spawn(process.execPath, [entry], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = message.id;
        if (typeof id === "string" || typeof id === "number") {
          const key = `${typeof id}:${String(id)}`;
          const pending = this.#pending.get(key);
          if (pending) {
            pending(message);
            this.#pending.delete(key);
          } else {
            this.#unclaimed.push(message);
          }
        }
      }
    });
  }

  request(id: RpcId, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const response = this.expect(id, method);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  expect(id: RpcId, label = "response"): Promise<Record<string, unknown>> {
    const key = `${typeof id}:${String(id)}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 3_000);
      this.#pending.set(key, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  writeRaw(value: string): void {
    this.child.stdin.write(value);
  }

  takeUnclaimed(): Record<string, unknown>[] {
    return this.#unclaimed.splice(0);
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill();
        reject(new Error("MCP server did not exit after stdin EOF"));
      }, 3_000);
      this.child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

function toolPayload(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as Record<string, unknown>;
  const content = result.content as Array<Record<string, unknown>>;
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, "text");
  assert.equal(typeof content[0]?.text, "string");
  return JSON.parse(content[0]?.text as string) as Record<string, unknown>;
}

function successfulToolPayload(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as Record<string, unknown>;
  assert.notEqual(result.isError, true, "expected successful MCP tools/call result");
  return toolPayload(response);
}

async function initialize(client: TestClient, id: RpcId): Promise<void> {
  const response = await client.request(id, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(response.error, undefined);
}

test("MCP stdio initializes idempotently and lists the native and compatibility tools", async () => {
  const client = new TestClient();
  try {
    const initializeLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {
          roots: { listChanged: true },
          sampling: {},
        },
        clientInfo: { name: "test", version: "1" },
      },
    });
    const initializeResponse = client.expect(1, "fragmented initialize");
    client.writeRaw(initializeLine.slice(0, 35));
    client.writeRaw(`${initializeLine.slice(35)}\n`);
    const initialized = await initializeResponse;
    assert.equal(
      (initialized.result as Record<string, unknown>).protocolVersion,
      "2025-03-26",
    );
    assert.deepEqual(
      (initialized.result as Record<string, unknown>).serverInfo,
      {
        name: "local-codex-bridge",
        title: "Local Codex Bridge",
        version: "2.1.3",
      },
    );

    // A second initialize reuses the first negotiated result with its own response id.
    const repeated = await client.request(0, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.id, 1);
    assert.equal(repeated.id, 0);
    assert.equal(initialized.error, undefined);
    assert.equal(repeated.error, undefined);
    assert.deepEqual(repeated.result, initialized.result);

    const reordered = await client.request(2, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {
        sampling: {},
        roots: { listChanged: true },
      },
      clientInfo: { version: "1", name: "test" },
    });
    assert.equal(reordered.error, undefined);
    assert.deepEqual(reordered.result, initialized.result);

    client.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const pingPromise = client.expect(3, "batched ping");
    const listPromise = client.expect(4, "batched tools/list");
    client.writeRaw(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`,
    );
    const [ping, listed] = await Promise.all([pingPromise, listPromise]);
    assert.deepEqual(ping.result, {});
    const tools = (listed.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "codex_native_read",
      "codex_native_action",
      "codex_experimental_read",
      "codex_experimental_action",
      "codex_threads",
      "codex_goal",
      "codex_models",
      "codex_rate_limits",
      "codex_thread_lifecycle",
      "codex_thread_start",
      "codex_turn_start",
      "codex_turn",
      "codex_observe",
      "codex_steer",
      "codex_respond",
      "codex_interrupt",
      "memory_search",
      "memory_record_turn",
    ]);
    for (const tool of tools) {
      assert.equal(typeof tool.title, "string");
      assert.equal(typeof tool.description, "string");
      assert.equal((tool.inputSchema as Record<string, unknown>).type, "object");
      const annotations = tool.annotations as Record<string, unknown>;
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        assert.equal(typeof annotations[hint], "boolean", `${String(tool.name)} ${hint}`);
      }
    }
    const modelsTool = tools.find((tool) => tool.name === "codex_models");
    assert.match(modelsTool?.description as string, /model\/list/);
    const modelProperties = (modelsTool?.inputSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;
    assert.ok("cursor" in modelProperties);
    assert.ok("include_hidden" in modelProperties);
    const rateLimitsTool = tools.find((tool) => tool.name === "codex_rate_limits");
    assert.match(rateLimitsTool?.description as string, /account\/rateLimits\/read/);
    assert.equal(
      (rateLimitsTool?.annotations as Record<string, unknown>).readOnlyHint,
      true,
    );
    const respondTool = tools.find((tool) => tool.name === "codex_respond");
    assert.equal(
      (respondTool?.annotations as Record<string, unknown>).idempotentHint,
      false,
    );
    const memorySearch = tools.find((tool) => tool.name === "memory_search");
    assert.equal(
      (memorySearch?.annotations as Record<string, unknown>).readOnlyHint,
      true,
    );
    assert.equal(
      (memorySearch?.annotations as Record<string, unknown>).idempotentHint,
      true,
    );
    const memoryRecordTurn = tools.find((tool) => tool.name === "memory_record_turn");
    assert.equal(
      (memoryRecordTurn?.annotations as Record<string, unknown>).readOnlyHint,
      false,
    );
    assert.equal(
      (memoryRecordTurn?.annotations as Record<string, unknown>).idempotentHint,
      false,
    );
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("real MCP tools/list discovers the canonical surface, native methods, and dispatchable tools", async () => {
  const client = new TestClient();
  try {
    const initialized = await client.request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "discovery", version: "1" },
    });
    assert.equal(((initialized.result as Record<string, any>).serverInfo).version, VERSION);
    const listed = await client.request(2, "tools/list");
    const tools = (listed.result as Record<string, unknown>).tools as Array<Record<string, any>>;
    // The runtime server must serve the canonical definitions, not a stale copy.
    assert.deepEqual(tools, JSON.parse(JSON.stringify(TOOL_DEFINITIONS)));
    const byName = new Map(tools.map((tool) => [tool.name as string, tool]));
    assert.deepEqual([...byName.keys()].sort(), [
      "codex_experimental_action", "codex_experimental_read", "codex_goal", "codex_interrupt",
      "codex_models", "codex_native_action", "codex_native_read", "codex_observe", "codex_rate_limits",
      "codex_respond", "codex_steer", "codex_thread_lifecycle", "codex_thread_start", "codex_threads",
      "codex_turn", "codex_turn_start", "memory_record_turn", "memory_search",
    ]);

    const required: Record<keyof typeof NATIVE_GROUPS, string[]> = {
      codex_native_read: ["thread/list", "thread/read", "thread/turns/list", "thread/items/list", "account/read", "config/read"],
      codex_native_action: ["thread/start", "thread/resume", "thread/fork", "thread/compact/start", "thread/archive", "review/start"],
      codex_experimental_read: ["thread/search", "thread/searchOccurrences", "thread/queue/list", "thread/timeline/list"],
      codex_experimental_action: ["thread/queue/add", "thread/queue/update", "thread/queue/delete", "thread/queue/reorder", "thread/queue/start", "thread/settings/update"],
    };
    for (const group of Object.keys(NATIVE_GROUPS) as Array<keyof typeof NATIVE_GROUPS>) {
      const variants = byName.get(group)!.inputSchema.oneOf as Array<Record<string, any>>;
      const operations = variants.map((variant) => variant.properties.operation.const as string);
      assert.deepEqual(operations, Object.keys(NATIVE_GROUPS[group]), `${group} discovery drifted from its allowlist`);
      for (const method of required[group]) assert.ok(operations.includes(method), `${group} must expose ${method}`);
      const read = group.endsWith("_read");
      for (const variant of variants) {
        assert.equal(variant.properties.delivery?.enum?.join(), read ? "bounded,exact" : undefined, `${group} delivery discovery`);
      }
      assert.equal(/delivery:"exact"/.test(byName.get(group)!.description), read, `${group} description`);
    }

    assert.deepEqual(byName.get("codex_goal")!.inputSchema.properties.operation.enum, ["set", "get", "clear", "reconnect"]);
    assert.deepEqual(byName.get("codex_thread_lifecycle")!.inputSchema.properties.operation.enum, ["fork", "compact"]);
    const respondMethods = String(byName.get("codex_respond")!.inputSchema.properties.method.description);
    const supported = [
      "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
      "item/tool/requestUserInput", "item/tool/call", "mcpServer/elicitation/request",
      "execCommandApproval", "applyPatchApproval",
    ];
    assert.deepEqual([...SUPPORTED_RESPOND_METHODS].sort(), [...supported].sort());
    for (const method of supported) assert.ok(respondMethods.includes(method), `tools/list must name respond method ${method}`);
    const observe = String(byName.get("codex_observe")!.description);
    for (const term of ["final_result_pending", "final_result_meta", "next_cursor"]) assert.ok(observe.includes(term), `codex_observe must describe ${term}`);

    // Every listed tool is dispatched by the runtime; argument validation, not
    // "Unknown tool", rejects the probe before any app-server contact.
    let id = 100;
    for (const name of byName.keys()) {
      const response = await client.request(id += 1, "tools/call", { name, arguments: { discovery_probe: true } });
      assert.equal(response.error, undefined, `${name} must be a known tool`);
      assert.equal((response.result as Record<string, unknown>).isError, true, name);
      assert.doesNotMatch(String(toolPayload(response).error), /Unknown tool/, name);
    }
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("MCP rejects materially different repeated initialize identities", async () => {
  const client = new TestClient();
  try {
    const first = await client.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(first.error, undefined);

    const mismatches: Array<[string, Record<string, unknown>]> = [
      ["protocolVersion", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }],
      ["capabilities", {
        protocolVersion: "2025-03-26",
        capabilities: { sampling: {} },
        clientInfo: { name: "test", version: "1" },
      }],
      ["clientInfo", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "other", version: "1" },
      }],
    ];
    for (const [field, params] of mismatches) {
      const response = await client.request(field, "initialize", params);
      const error = response.error as Record<string, unknown>;
      assert.equal(error.code, -32602);
      assert.match(error.message as string, new RegExp(field));
    }
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("MCP rejects duplicate active typed request ids without disturbing distinct ids", async () => {
  const client = new TestClient();
  try {
    await initialize(client, 1);
    const numeric = client.expect(17, "first numeric tools/list");
    const string = client.expect("17", "distinct string tools/list");
    client.writeRaw(
      `${JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/list", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/list", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "17", method: "tools/list", params: {} })}\n`,
    );
    const [first, distinct] = await Promise.all([numeric, string]);
    assert.equal(first.id, 17);
    assert.equal(distinct.id, "17");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const duplicateErrors = client.takeUnclaimed();
    assert.equal(duplicateErrors.length, 1);
    assert.deepEqual(duplicateErrors[0]?.error, {
      code: -32600,
      message: "Duplicate request id is already active",
    });
    assert.equal(duplicateErrors[0]?.id, 17);
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("MCP duplicate active typed id preserves cancellation suppression and safe reuse", async () => {
  const runtime = new RuntimeStore();
  const threadId = "thread-duplicate-cancellation";
  const turnId = "turn-duplicate-cancellation";
  runtime.markTurnAccepted(threadId, turnId);
  const control = new ControlSurface({ runtime } as unknown as AppServerManager);
  const input = new PassThrough();
  const output = new PassThrough();
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  const messages: Record<string, unknown>[] = [];
  const waiting: Array<{
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    }
  });
  const nextMessage = (): Promise<Record<string, unknown>> => {
    const message = messages.shift();
    if (message) {
      return Promise.resolve(message);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timeout waiting for MCP response"));
      }, 2_000);
      timer.unref();
      waiting.push({ resolve, reject, timer });
    });
  };
  const send = (message: Record<string, unknown>): void => {
    input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const tick = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  let server: McpStdioServer | undefined;

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  try {
    server = new McpStdioServer(control, { onClose: () => undefined });
    server.start();
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "direct-test", version: "1" },
      },
    });
    assert.equal((await nextMessage()).error, undefined);

    const observe = {
      name: "codex_observe",
      arguments: { thread_id: threadId, cursor: 0, wait_ms: 1_000 },
    };
    send({ id: 17, method: "tools/call", params: observe });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    // Keep the original request active while cancellation and the duplicate
    // arrive in the same input batch. The duplicate error must not consume
    // the cancellation marker that suppresses the original response.
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 17, reason: "deterministic duplicate lifecycle test" },
      })}\n` +
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: observe,
      })}\n`,
    );
    const duplicate = await nextMessage();
    assert.equal(duplicate.id, 17);
    assert.deepEqual(duplicate.error, {
      code: -32600,
      message: "Duplicate request id is already active",
    });

    send({ id: "17", method: "ping" });
    const distinct = await nextMessage();
    assert.equal(distinct.id, "17");
    assert.deepEqual(distinct.result, {});

    assert.equal(messages.length, 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    assert.equal(messages.length, 0, "cancelled first request must not emit a late response");

    // The first request's finally cleanup must release only its own lifecycle;
    // the same typed id can be reused and its new waiter must still wake.
    send({ id: 17, method: "tools/call", params: observe });
    await tick();
    runtime.recordNotification("item/started", {
      threadId,
      turnId,
      item: { type: "commandExecution", id: "after-id-reuse" },
    });
    const replacement = await nextMessage();
    assert.equal(replacement.id, 17);
    assert.equal(replacement.error, undefined);
    const payload = successfulToolPayload(replacement);
    assert.deepEqual(
      (payload.events as Array<Record<string, unknown>>).map((event) => event.method),
      ["item/started"],
    );
  } finally {
    if (server) {
      await server.close();
    }
    input.destroy();
    output.destroy();
    if (stdinDescriptor) {
      Object.defineProperty(process, "stdin", stdinDescriptor);
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process, "stdout", stdoutDescriptor);
    }
  }
});

test("MCP reports protocol errors and domain tool errors without stdout noise", async () => {
  const client = new TestClient();
  try {
    await client.request(1, "initialize", {
      protocolVersion: "2099-01-01",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const unknownMethod = await client.request(2, "missing/method");
    assert.equal((unknownMethod.error as Record<string, unknown>).code, -32601);
    const unknownTool = await client.request(3, "tools/call", { name: "not_a_tool", arguments: {} });
    assert.equal((unknownTool.error as Record<string, unknown>).code, -32602);
    const invalidTool = await client.request(4, "tools/call", {
      name: "codex_observe",
      arguments: {},
    });
    assert.equal((invalidTool.result as Record<string, unknown>).isError, true);
  } finally {
    assert.equal(await client.close(), 0);
  }
});
