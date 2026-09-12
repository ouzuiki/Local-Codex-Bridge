import { createServer, type Socket } from "node:net";
import { AppServerManager } from "./app-server.js";
import { McpStdioServer } from "./mcp.js";
import { sanitizeForTransport, RuntimeStore } from "./runtime.js";
import { ControlSurface } from "./tools.js";
import { createUxProjectionFromEnvironment } from "./ux-projection.js";

if (process.env.LCB_SOCKET_FD?.trim() !== "3") throw new Error("LCB_SOCKET_FD must be exactly 3");
const appServer = new AppServerManager(new RuntimeStore(256, createUxProjectionFromEnvironment()));
const control = new ControlSurface(appServer);
const sessions = new Set<McpStdioServer>();
const sockets = new Set<Socket>();
let stopping = false;
const listener = createServer((socket) => {
  if (stopping) return socket.destroy();
  sockets.add(socket);
  let session: McpStdioServer;
  session = new McpStdioServer(control, { input: socket, output: socket, onClose: async () => { sessions.delete(session); sockets.delete(socket); await session.close(); socket.destroy(); } });
  sessions.add(session); session.start();
});

function safe(error: unknown): string { const value = sanitizeForTransport(error instanceof Error ? error.message : String(error), { maxStringChars: 4_000, totalCharBudget: 4_000 }); return typeof value === "string" ? value : "failure"; }
function fatal(error: unknown): void { process.stderr.write(`local-codex-bridge: ${safe(error)}\n`); void shutdown(1); }
async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true; process.exitCode = Math.max(typeof process.exitCode === "number" ? process.exitCode : 0, code);
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  for (const socket of sockets) socket.destroy();
  await Promise.all([...sessions].map((session) => session.close()));
  await appServer.close(); appServer.runtime.closeUxProjection();
}
listener.on("error", fatal);
listener.listen({ fd: 3 });
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("uncaughtException", fatal);
process.once("unhandledRejection", fatal);
