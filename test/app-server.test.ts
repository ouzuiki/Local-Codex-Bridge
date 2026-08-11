import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AppServerManager,
  createSerializedWriter,
  writeWithBackpressure,
} from "../src/app-server.js";
import { ControlSurface } from "../src/tools.js";

const fakeCodex = fileURLToPath(new URL("../../test/fake-codex.mjs", import.meta.url));

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RejectingResponseManager extends AppServerManager {
  lastResponseId: string | number | undefined;

  override async respond(id: string | number, _result: unknown): Promise<void> {
    this.lastResponseId = id;
    throw new Error("synthetic app-server response write failure");
  }
}

class ControlledBackpressureSink extends EventEmitter {
  writable = true;
  writableEnded = false;
  destroyed = false;
  readonly chunks: string[] = [];
  #callback: ((error?: Error | null) => void) | null = null;

  write(
    chunk: string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): boolean {
    this.chunks.push(chunk);
    this.#callback = callback;
    return false;
  }

  completeWrite(error?: Error): void {
    const callback = this.#callback;
    if (!callback) {
      throw new Error("No controlled write is pending");
    }
    this.#callback = null;
    callback(error);
  }
}

test("control surface starts asynchronously, steers the same turn, uses raw request id, and observes final", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
  });
  const control = new ControlSurface(manager);
  try {
    const started = await control.call("codex_turn", {
      text: "read only",
      cwd: "D:\\Bridge",
      sandbox: "read-only",
      approval_policy: "never",
    }) as Record<string, unknown>;
    assert.equal(started.accepted, true);
    assert.equal(started.thread_id, "thread-1");
    assert.equal(started.turn_id, "turn-1");

    const steered = await control.call("codex_steer", {
      thread_id: "thread-1",
      expected_turn_id: "turn-1",
      text: "read another file",
    }) as Record<string, unknown>;
    assert.equal(steered.turn_id, "turn-1");

    await delay(30);
    const active = await control.call("codex_observe", {
      thread_id: "thread-1",
      cursor: 0,
    }) as Record<string, unknown>;
    const pending = active.pending_requests as Array<Record<string, unknown>>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.request_id, "approval-1");
    assert.equal((pending[0]?.params as Record<string, unknown>).api_key, "[REDACTED]");

    const responded = await control.call("codex_respond", {
      request_id: "approval-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      method: "item/commandExecution/requestApproval",
      decision: "decline",
    }) as Record<string, unknown>;
    assert.equal(responded.request_id, "approval-1");
    await assert.rejects(
      control.call("codex_respond", {
        request_id: "approval-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        method: "item/commandExecution/requestApproval",
        decision: "decline",
      }),
      /No pending/,
    );

    await delay(30);
    const completed = await control.call("codex_observe", {
      thread_id: "thread-1",
    }) as Record<string, unknown>;
    assert.equal(completed.runtime_status, "completed");
    assert.equal((completed.terminal as Record<string, unknown>).final_result, "FAKE_FINAL");
  } finally {
    await manager.close();
  }
});

test("unexpected app-server death is latched and never auto-restarted", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
  });
  try {
    await assert.rejects(manager.request("test/exit", {}), /exited unexpectedly/);
    await assert.rejects(manager.request("thread/list", {}), /will not be auto-restarted/);
  } finally {
    await manager.close();
  }
});

test("failed app-server response write restores the original pending request", async () => {
  const manager = new RejectingResponseManager();
  const control = new ControlSurface(manager);
  manager.runtime.markTurnAccepted("thread-restore", "turn-restore");
  manager.runtime.recordServerRequest(41, "item/fileChange/requestApproval", {
    threadId: "thread-restore",
    turnId: "turn-restore",
  });

  try {
    await assert.rejects(
      control.call("codex_respond", {
        request_id: 41,
        thread_id: "thread-restore",
        turn_id: "turn-restore",
        method: "item/fileChange/requestApproval",
        decision: "decline",
      }),
      /synthetic app-server response write failure/,
    );
    assert.equal(manager.lastResponseId, 41);
    const pending = manager.runtime.pendingForThread("thread-restore") as Array<Record<string, unknown>>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.request_id, 41);
  } finally {
    await manager.close();
  }
});

test("threadless app-server server request receives an explicit JSON-RPC error", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
  });
  try {
    const result = await manager.request("test/threadless", {}) as Record<string, unknown>;
    assert.equal(result.clientErrorId, "threadless-1");
    assert.deepEqual(result.clientError, {
      code: -32601,
      message: "Unsupported app-server request without thread context",
    });
    const listed = await manager.request("thread/list", {}) as Record<string, unknown>;
    assert.equal(Array.isArray(listed.data), true);
  } finally {
    await manager.close();
  }
});

test("serialized app-server writes preserve order and wait for drain", async () => {
  const sink = new ControlledBackpressureSink();
  const write = createSerializedWriter((chunk) =>
    writeWithBackpressure(sink as unknown as Writable, chunk),
  );
  let firstResolved = false;
  const first = write("first\n").then(() => {
    firstResolved = true;
  });
  const second = write("second\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sink.chunks, ["first\n"]);
  sink.completeWrite();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstResolved, false);
  assert.deepEqual(sink.chunks, ["first\n"]);
  sink.emit("drain");
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstResolved, true);
  assert.deepEqual(sink.chunks, ["first\n", "second\n"]);
  sink.completeWrite();
  sink.emit("drain");
  await second;
});

test("app-server stream writes reject on error or close and the chain recovers", async () => {
  const errorSink = new ControlledBackpressureSink();
  const errorWrite = writeWithBackpressure(
    errorSink as unknown as Writable,
    "error\n",
  );
  const errorAssertion = assert.rejects(errorWrite, /synthetic stream failure/);
  errorSink.emit("error", new Error("synthetic stream failure"));
  await errorAssertion;

  const closedSink = new ControlledBackpressureSink();
  const closedWrite = writeWithBackpressure(
    closedSink as unknown as Writable,
    "closed\n",
  );
  const closeAssertion = assert.rejects(closedWrite, /stdin closed during write/);
  closedSink.emit("close");
  await closeAssertion;

  let attempts = 0;
  const recoveringWrite = createSerializedWriter(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("synthetic queued failure");
    }
  });
  await assert.rejects(recoveringWrite("first\n"), /synthetic queued failure/);
  await recoveringWrite("second\n");
  assert.equal(attempts, 2);
});
