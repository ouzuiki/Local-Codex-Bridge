import { defaultSocketPath, runRelay } from "./socket-relay.js";

// Strict MCP stdio entry: stdout carries only bytes relayed from the Bridge socket.
let code: number;
try {
  code = await runRelay(defaultSocketPath(), {
    input: process.stdin,
    output: process.stdout,
    diagnostics: process.stderr,
  });
} catch (error) {
  process.stderr.write(`local-codex-bridge relay: ${error instanceof Error ? error.message : String(error)}\n`);
  code = 2;
}
process.exitCode = code;
process.stdin.destroy();
