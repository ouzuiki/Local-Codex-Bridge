import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { defaultProjectionPath, parseProjection } from "./projection-watch.js";
import { defaultSocketPath } from "./socket-relay.js";
import { evaluateWiring, type WiringFacts } from "./wiring-check.js";

// usage: wiring-check-cli --entry <absolute launcher> [--service <unit>] [--socket-unit <unit>]
//                         [--projection <path>] [--expect-version <x.y.z>]
// Linux/systemd user services only. Sends MCP initialize and nothing else:
// no tool call, no thread, no turn. Prints one JSON verdict; exit 1 on problems.

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function systemctlShow(unit: string, property: string): string {
  try {
    return execFileSync("systemctl", ["--user", "show", unit, "-p", property, "--value"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function descendants(rootPid: number): { args: string | null; count: number } {
  const table = execFileSync("ps", ["-e", "-o", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]! }));
  const children = new Set<number>([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (!children.has(row.pid) && children.has(row.ppid)) {
        children.add(row.pid);
        grew = true;
      }
    }
  }
  return { args: table.find((row) => row.pid === rootPid)?.args ?? null, count: children.size - 1 };
}

async function initializeThrough(entry: string): Promise<{ serverInfo: WiringFacts["serverInfo"]; tree: ReturnType<typeof descendants> }> {
  const child = spawn(entry, [], { stdio: ["pipe", "pipe", "pipe"], shell: false });
  let buffer = "";
  const response = new Promise<WiringFacts["serverInfo"]>((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((candidate) => candidate.includes('"id":1'));
      if (!line) return;
      clearTimeout(timer);
      try {
        const info = (JSON.parse(line) as { result?: { serverInfo?: { name?: unknown; version?: unknown } } }).result?.serverInfo;
        resolve(typeof info?.name === "string" && typeof info.version === "string" ? { name: info.name, version: info.version } : null);
      } catch {
        resolve(null);
      }
    });
    child.once("exit", () => resolve(null));
  });
  child.stderr.resume();
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "lcb-wiring-check", version: "1" } } })}\n`);
  const serverInfo = await response;
  // Give a per-session Bridge the chance to show its app-server child, if any.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const tree = child.pid === undefined ? { args: null, count: 0 } : descendants(child.pid);
  child.stdin.end();
  child.kill("SIGTERM");
  return { serverInfo, tree };
}

const entry = option("--entry");
if (!entry || !entry.startsWith("/")) {
  process.stderr.write("wiring-check-cli: --entry <absolute MCP launcher path> is required\n");
  process.exit(2);
}
const service = option("--service") ?? "local-codex-bridge.service";
const socketUnit = option("--socket-unit") ?? "local-codex-bridge.socket";
const projectionPath = option("--projection") ?? defaultProjectionPath();
const expectedVersion = option("--expect-version");

const { serverInfo, tree } = await initializeThrough(entry);
let projectionPid: number | null = null;
try {
  const text = readFileSync(projectionPath, "utf8");
  const pid = (JSON.parse(text) as { generation?: { pid?: unknown } }).generation?.pid;
  if (parseProjection(text) && typeof pid === "number") projectionPid = pid;
} catch {
  projectionPid = null;
}
let relaySocketPath: string | null = null;
try {
  relaySocketPath = defaultSocketPath();
} catch {
  relaySocketPath = null;
}
const listen = systemctlShow(socketUnit, "Listen").match(/^(\/\S+)\s+\(Stream\)/m)?.[1] ?? null;

const facts: WiringFacts = {
  launchedArgs: tree.args,
  launchedDescendants: tree.count,
  serverInfo,
  serviceMainPid: Number(systemctlShow(service, "MainPID")) || 0,
  projectionPid,
  relaySocketPath,
  serviceListenPath: listen,
  ...(expectedVersion ? { expectedVersion } : {}),
};
const verdict = evaluateWiring(facts);
process.stdout.write(`${JSON.stringify({ ...verdict, facts })}\n`);
process.exitCode = verdict.ok ? 0 : 1;
