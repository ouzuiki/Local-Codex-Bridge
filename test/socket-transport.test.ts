import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SocketTransport } from "../src/socket-transport.js";

const socketIndexEntry = fileURLToPath(new URL("../src/socket-index.js", import.meta.url));
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function settleWithin<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${milliseconds}ms`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

interface McpClient {
  readonly socket: ReturnType<typeof connect>;
  request(id: number, method: string, params: unknown): Promise<Record<string, unknown>>;
}

function openMcpClient(socket: ReturnType<typeof connect>): McpClient {
  socket.setEncoding("utf8");
  const responses = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === "number") {
        responses.get(message.id)?.(message);
        responses.delete(message.id);
      }
    }
  });
  return {
    socket,
    request(id, method, params) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 3_000);
        responses.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

async function initialize(client: McpClient): Promise<void> {
  const response = await client.request(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "socket-transport-test", version: "1" },
  });
  assert.equal(response.error, undefined);
}

test("socket transport shutdown completes with an active client", {
  skip: process.platform === "win32",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "lcb-sock-"));
  const socketPath = join(directory, "mcp.sock");
  const transport = new SocketTransport();
  let client: McpClient | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      transport.listener.once("error", reject);
      transport.listener.listen(socketPath, () => resolve());
    });
    const raw = connect(socketPath);
    client = openMcpClient(raw);
    await once(raw, "connect");
    await initialize(client);
    assert.equal(raw.destroyed, false);

    const closed = once(raw, "close");
    await settleWithin(transport.shutdown(), 3_000, "socket transport shutdown");

    assert.equal(transport.listener.listening, false);
    await settleWithin(closed, 3_000, "client socket close");
    assert.equal(raw.destroyed, true);

    // Shutdown is idempotent; a repeat must not re-enter teardown or hang.
    await settleWithin(transport.shutdown(), 1_000, "repeat socket transport shutdown");
  } finally {
    client?.socket.destroy();
    await transport.shutdown().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("socket-index rejects any LCB_SOCKET_FD other than 3", async () => {
  const child = spawn(process.execPath, [socketIndexEntry], {
    env: { ...process.env, LCB_SOCKET_FD: "4" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const exit = await settleWithin(exited, 5_000, "LCB_SOCKET_FD rejection");
  assert.equal(exit.code, 1);
  assert.match(stderr, /LCB_SOCKET_FD must be exactly 3/);
  assert.equal(stdout, "");
});

test("socket-index exits on SIGTERM while an MCP client stays connected", {
  skip: process.platform !== "linux",
}, async () => {
  const socketName = `\0lcb-signal-${process.pid}-${randomUUID()}`;
  const listener = createServer((socket) => {
    // The child must own every connection; the parent only lends fd 3.
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(socketName, () => resolve());
  });
  const inheritedFd = (listener as unknown as { _handle: { fd: number } })._handle.fd;
  assert.equal(Number.isInteger(inheritedFd), true);

  let child: ChildProcess | undefined;
  let client: McpClient | undefined;
  try {
    child = spawn(process.execPath, [socketIndexEntry], {
      env: { ...process.env, LCB_SOCKET_FD: "3" },
      stdio: ["ignore", "pipe", "pipe", inheritedFd],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // Hand the listening socket to the child exclusively before any client
    // connects, so the parent can never accept the MCP session.
    await settleWithin(
      new Promise<void>((resolve) => listener.close(() => resolve())),
      3_000,
      "parent listener handoff",
    );

    const raw = connect(socketName);
    client = openMcpClient(raw);
    await once(raw, "connect");
    await initialize(client);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child?.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.kill("SIGTERM");
    const exit = await settleWithin(exited, 5_000, "SIGTERM shutdown");

    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stdout, "", "socket transport must keep stdout clean");
    assert.equal(stderr, "");
  } finally {
    client?.socket.destroy();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
      await delay(0);
    }
    if (listener.listening) {
      listener.close();
    }
  }
});
