import { SocketTransport } from "./socket-transport.js";
import { sanitizeForTransport } from "./runtime.js";

if (process.env.LCB_SOCKET_FD?.trim() !== "3") throw new Error("LCB_SOCKET_FD must be exactly 3");
const transport = new SocketTransport();
let stopping = false;

function safe(error: unknown): string { const value = sanitizeForTransport(error instanceof Error ? error.message : String(error), { maxStringChars: 4_000, totalCharBudget: 4_000 }); return typeof value === "string" ? value : "failure"; }
function fatal(error: unknown): void { process.stderr.write(`local-codex-bridge: ${safe(error)}\n`); void shutdown(1); }
async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true; process.exitCode = Math.max(typeof process.exitCode === "number" ? process.exitCode : 0, code);
  await transport.shutdown();
}
transport.listener.on("error", fatal);
transport.listener.listen({ fd: 3 });
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("uncaughtException", fatal);
process.once("unhandledRejection", fatal);
