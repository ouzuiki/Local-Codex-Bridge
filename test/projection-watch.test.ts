import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultProjectionPath,
  initialWatchState,
  parseProjection,
  parseWatchArgs,
  reduceProjection,
  type ProjectionSnapshot,
  type ProjectionSignal,
} from "../src/projection-watch.js";
import { RuntimeStore } from "../src/runtime.js";
import { AtomicUxProjection, type UxProjectionDocument } from "../src/ux-projection.js";

// Private root: other suites remove the shared _test_tmp directory concurrently.
const suiteRoot = mkdtempSync(join(tmpdir(), "lcb-projection-watch-"));
const testRoot = join(suiteRoot, "case");
const cliPath = fileURLToPath(new URL("../src/watch-cli.js", import.meta.url));

test.beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
});

test.after(() => rmSync(suiteRoot, { recursive: true, force: true }));

function signal(sequence: number, kind: string, extra: Partial<ProjectionSignal> = {}): ProjectionSignal {
  return { sequence, kind, thread_id: "thread-a", turn_id: "turn-1", status: "waiting", at: "t", ...extra };
}

function snapshot(signals: ProjectionSignal[], extra: Partial<ProjectionSnapshot> = {}): ProjectionSnapshot {
  return {
    generation: "gen-1",
    sequence: signals.at(-1)?.sequence ?? 0,
    waiting: 0,
    signals,
    ...extra,
  };
}

test("runtime projects request_resolved with raw request id and no request content", () => {
  const path = join(testRoot, "projection.json");
  const projection = new AtomicUxProjection(path);
  const runtime = new RuntimeStore(8, projection);
  runtime.markTurnAccepted("thread-a", "turn-1");
  runtime.recordServerRequest(7, "item/commandExecution/requestApproval", {
    threadId: "thread-a",
    turnId: "turn-1",
    command: "DO_NOT_PROJECT_COMMAND supabase migration new",
  });
  runtime.recordServerRequest("file-1", "item/fileChange/requestApproval", {
    threadId: "thread-a",
    turnId: "turn-1",
    reason: "DO_NOT_PROJECT_REASON",
  });
  const claimed = runtime.claimPending(7, {
    threadId: "thread-a",
    method: "item/commandExecution/requestApproval",
    turnId: "turn-1",
  });
  runtime.completePending(claimed);
  runtime.recordNotification("serverRequest/resolved", { threadId: "thread-a", requestId: "file-1" });
  // A second resolution for an already-gone request must not add a signal.
  runtime.recordNotification("serverRequest/resolved", { threadId: "thread-a", requestId: 7 });

  const raw = readFileSync(path, "utf8");
  const document = JSON.parse(raw) as UxProjectionDocument;
  assert.doesNotMatch(raw, /DO_NOT_PROJECT|supabase/);
  assert.deepEqual(
    document.signals.map((entry) => [entry.kind, entry.request_id, entry.status]),
    [
      ["waiting_approval", 7, "waiting"],
      ["waiting_approval", "file-1", "waiting"],
      ["request_resolved", 7, "responded"],
      ["request_resolved", "file-1", "resolved"],
    ],
  );
  assert.equal(document.counts.waiting, 0);
  projection.close();
});

test("parseProjection accepts v1 documents and rejects anything else", () => {
  assert.equal(parseProjection("not json"), null);
  assert.equal(parseProjection(JSON.stringify({ schema_version: 2 })), null);
  const parsed = parseProjection(
    JSON.stringify({
      schema_version: 1,
      generation: { id: "g", pid: 1, started_at: "x" },
      sequence: 2,
      counts: { active: 1, waiting: 1, terminal: 0 },
      signals: [
        { sequence: 2, kind: "request_resolved", thread_id: "t", turn_id: null, status: "responded", at: "b", request_id: 3 },
        { sequence: 1, kind: "waiting_approval", thread_id: "t", turn_id: "u", status: "waiting", at: "a", request_id: 3, params: "x" },
        { sequence: "bad", kind: "terminal", thread_id: "t" },
      ],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.waiting, 1);
  assert.deepEqual(parsed.signals.map((entry) => entry.sequence), [1, 2]);
  assert.equal("params" in parsed.signals[0]!, false);
});

test("startup baselines history but replays still-open requests for watched threads", () => {
  const state = initialWatchState();
  const lines = reduceProjection(
    state,
    snapshot(
      [
        signal(1, "waiting_approval", { request_id: 1 }),
        signal(2, "request_resolved", { request_id: 1, status: "responded" }),
        signal(3, "waiting_approval", { request_id: 2 }),
        signal(4, "waiting_user_input", { request_id: 3, thread_id: "thread-b" }),
      ],
      { waiting: 2 },
    ),
    { threads: new Set(["thread-a"]) },
  );
  assert.deepEqual(lines.map((line) => [line.event, line.request_id, line.replayed]), [
    ["approval_requested", 2, true],
  ]);
  assert.equal(state.sequence, 4);
  assert.deepEqual(reduceProjection(state, snapshot([signal(4, "waiting_user_input")]), {}), []);
});

test("new signals become one line each, filtered by thread; quiet reads print nothing", () => {
  const state = initialWatchState();
  reduceProjection(state, snapshot([]));
  const filter = { threads: new Set(["thread-a"]) };
  const lines = reduceProjection(
    state,
    snapshot([
      signal(1, "waiting_approval", { request_id: 5 }),
      signal(2, "waiting_approval", { request_id: 6, thread_id: "thread-b" }),
      signal(3, "request_resolved", { request_id: 5, status: "responded" }),
      signal(4, "terminal", { status: "completed" }),
    ]),
    filter,
  );
  assert.deepEqual(lines.map((line) => [line.event, line.status ?? null]), [
    ["approval_requested", null],
    ["request_resolved", "responded"],
    ["turn_terminal", "completed"],
  ]);
  assert.deepEqual(reduceProjection(state, snapshot([signal(4, "terminal")]), filter), []);
});

test("gaps, stop, restart, and an absent projection are reported", () => {
  const state = initialWatchState();
  assert.deepEqual(reduceProjection(state, null).map((line) => line.event), ["projection_unavailable"]);
  assert.deepEqual(reduceProjection(state, null), []);
  assert.deepEqual(
    reduceProjection(state, snapshot([signal(1, "waiting_approval", { request_id: 1 })])).map((line) => line.event),
    ["projection_available", "approval_requested"],
  );
  const gap = reduceProjection(state, snapshot([signal(5, "terminal", { status: "failed" })]));
  assert.deepEqual(gap.map((line) => line.event), ["signal_gap", "turn_terminal"]);
  assert.equal(gap[0]!.missed_from, 2);
  assert.equal(gap[0]!.missed_to, 4);
  assert.deepEqual(reduceProjection(state, null).map((line) => line.event), ["bridge_stopped"]);
  const restarted = reduceProjection(
    state,
    snapshot([signal(1, "waiting_user_input", { request_id: 9 })], { generation: "gen-2" }),
  );
  assert.deepEqual(restarted.map((line) => line.event), ["bridge_restarted", "input_requested"]);
});

test("startup reports truncated history when live waiting exceeds the visible requests", () => {
  const lines = reduceProjection(initialWatchState(), snapshot([signal(40, "terminal")], { waiting: 1 }));
  assert.deepEqual(lines.map((line) => [line.event, line.reason]), [["signal_gap", "history_truncated"]]);
});

test("argument parsing and default path follow projection environment conventions", () => {
  assert.equal(parseWatchArgs(["--until-terminal"]).error, "--until-terminal requires --thread");
  assert.match(parseWatchArgs(["--projection", "relative.json"]).error ?? "", /absolute/);
  assert.match(parseWatchArgs(["--bogus"]).error ?? "", /unknown argument/);
  const parsed = parseWatchArgs(["--thread", "a", "--thread", "b", "--poll-ms", "500"], {
    LOCAL_CODEX_BRIDGE_UX_PROJECTION: "/x/p.json",
  });
  assert.deepEqual([...parsed.options!.threads], ["a", "b"]);
  assert.equal(parsed.options!.projectionPath, "/x/p.json");
  assert.equal(parsed.options!.pollMs, 500);
  assert.equal(defaultProjectionPath({ LUMEN_CODEX_V2_UX_PROJECTION: "/legacy.json" }, "linux"), "/legacy.json");
  assert.equal(
    defaultProjectionPath({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32").endsWith("ux-projection.json"),
    true,
  );
});

test("watch-cli prints only on projection changes and exits on --until-terminal", async (t) => {
  const path = join(testRoot, "state", "ux-projection.json");
  mkdirSync(join(testRoot, "state"), { recursive: true });
  const projection = new AtomicUxProjection(path);
  const runtime = new RuntimeStore(8, projection);
  runtime.markTurnAccepted("thread-a", "turn-1");

  const child = spawn(process.execPath, [cliPath, "--projection", path, "--thread", "thread-a", "--until-terminal"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  const waitFor = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (stdout.split("\n").filter(Boolean).length < count) {
      if (Date.now() > deadline) throw new Error(`timed out; stdout=${stdout} stderr=${stderr}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  };

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  assert.equal(stdout, "", "quiet projection must print nothing");

  runtime.recordServerRequest(11, "item/commandExecution/requestApproval", {
    threadId: "thread-a",
    turnId: "turn-1",
    command: "DO_NOT_PRINT_COMMAND",
  });
  await waitFor(1);
  runtime.recordServerRequest(12, "item/commandExecution/requestApproval", { threadId: "thread-other", turnId: "x" });
  const claimed = runtime.claimPending(11, {
    threadId: "thread-a",
    method: "item/commandExecution/requestApproval",
  });
  runtime.completePending(claimed);
  await waitFor(2);
  runtime.recordNotification("turn/completed", { threadId: "thread-a", turn: { id: "turn-1", status: "completed" } });

  assert.equal(await exited, 0);
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events.map((event) => event.event), ["approval_requested", "request_resolved", "turn_terminal"]);
  assert.equal(events[0]!.request_id, 11);
  assert.doesNotMatch(stdout, /DO_NOT_PRINT|thread-other/);
  assert.equal(stderr, "");
  projection.close();
});
