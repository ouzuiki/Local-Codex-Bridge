import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultSocketPath } from "../src/socket-relay.js";
import { evaluateWiring } from "../src/wiring-check.js";
import { SocketTransport } from "../src/socket-transport.js";

const relayEntry = fileURLToPath(new URL("../src/socket-relay-cli.js", import.meta.url));
const posixOnly = { skip: process.platform === "win32" ? "Unix socket relay is macOS/Linux only" : false } as const;

function runRelay(socketPath: string, input: string[], endInput: boolean) {
  const child = spawn(process.execPath, [relayEntry], {
    env: { ...process.env, LCB_SOCKET_PATH: socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  for (const line of input) child.stdin.write(`${line}\n`);
  if (endInput) child.stdin.end();
  return { child, out: () => stdout, err: () => stderr };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("default socket path follows LCB_SOCKET_PATH, then XDG_RUNTIME_DIR, then Linux /run/user", () => {
  assert.equal(defaultSocketPath({ LCB_SOCKET_PATH: "/s/codex.sock" }, "linux", 1000), "/s/codex.sock");
  assert.equal(
    defaultSocketPath({ XDG_RUNTIME_DIR: "/run/user/7" }, "linux", 1000),
    "/run/user/7/worker-neutral-supervisor/codex.sock",
  );
  assert.equal(defaultSocketPath({}, "linux", 1000), "/run/user/1000/worker-neutral-supervisor/codex.sock");
  assert.throws(() => defaultSocketPath({}, "darwin", 501), /cannot resolve/);
  assert.throws(() => defaultSocketPath({ LCB_SOCKET_PATH: "relative.sock" }, "linux", 1000), /absolute/);
  assert.throws(() => defaultSocketPath({}, "linux", null), /cannot resolve/);
  assert.throws(() => defaultSocketPath({}, "win32", null), /macOS and Linux/);
});

test("relay carries MCP initialize and tools/list to the shared socket Bridge with clean stdout", posixOnly, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lcb-relay-"));
  const socketPath = join(directory, "codex.sock");
  const transport = new SocketTransport();
  transport.listener.listen(socketPath);
  await once(transport.listener, "listening");
  t.after(async () => {
    await transport.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });

  const relay = runRelay(
    socketPath,
    [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "relay-test", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ],
    false,
  );
  t.after(() => {
    if (relay.child.exitCode === null) relay.child.kill("SIGKILL");
  });
  await until(() => relay.out().split("\n").filter(Boolean).length >= 2, "two responses");
  const exited = once(relay.child, "exit");
  relay.child.stdin.end();
  const [code] = await exited;

  const messages = relay.out().trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
  assert.deepEqual(messages.map((message) => message.id), [1, 2]);
  assert.equal(messages[0]!.result.serverInfo.name, "local-codex-bridge");
  assert.equal(messages[1]!.result.tools.length, 18);
  assert.equal(code, 0);
  assert.equal(relay.err(), "");
});

test("relay fails closed with empty stdout when the Bridge socket is absent", posixOnly, async () => {
  const directory = mkdtempSync(join(tmpdir(), "lcb-relay-missing-"));
  try {
    const relay = runRelay(join(directory, "absent.sock"), [], false);
    const [code] = await once(relay.child, "exit");
    assert.equal(code, 1);
    assert.equal(relay.out(), "");
    assert.match(relay.err(), /ENOENT on Bridge socket/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const healthy = {
  launchedArgs: "/usr/bin/node /deploy/dist/src/socket-relay-cli.js",
  launchedDescendants: 0,
  serverInfo: { name: "local-codex-bridge", version: "2.2.0" },
  serviceMainPid: 42,
  projectionPid: 42,
  relaySocketPath: "/run/user/1000/worker-neutral-supervisor/codex.sock",
  serviceListenPath: "/run/user/1000/worker-neutral-supervisor/codex.sock",
};

test("wiring check accepts a relay that reaches the projection-owning service", () => {
  assert.deepEqual(evaluateWiring({ ...healthy, expectedVersion: "2.2.0" }), { ok: true, problems: [] });
});

test("wiring check rejects the per-session stdio Bridge regression", () => {
  const verdict = evaluateWiring({
    ...healthy,
    launchedArgs: "/usr/bin/node /repo/dist/src/index.js",
    launchedDescendants: 1,
    projectionPid: 7,
    expectedVersion: "2.3.0",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems.length, 4);
  assert.match(verdict.problems.join("\n"), /does not exec the socket relay/);
  assert.match(verdict.problems.join("\n"), /projection belongs to pid 7/);
});

test("wiring check rejects a missing projection sink or a mismatched socket", () => {
  const verdict = evaluateWiring({ ...healthy, projectionPid: null, relaySocketPath: "/tmp/other.sock" });
  assert.deepEqual(verdict.problems.length, 2);
  assert.match(verdict.problems[0]!, /no projection sink/);
  assert.match(verdict.problems[1]!, /not the service listen socket/);
});
