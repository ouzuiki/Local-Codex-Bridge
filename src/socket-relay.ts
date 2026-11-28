import { connect, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * Byte-for-byte stdio <-> Unix socket relay for strict MCP stdio clients.
 *
 * It lets a stdio-only client (for example a desktop MCP entry) reach the one
 * long-lived socket-activated Bridge instead of spawning a private Bridge and
 * app-server per client. It parses nothing and owns no state; stdout carries
 * only bytes received from the socket, and diagnostics go to stderr.
 */

export const SOCKET_PATH_ENV = "LCB_SOCKET_PATH";

export function defaultSocketPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  uid: number | null = process.getuid?.() ?? null,
): string {
  if (platform === "win32") {
    throw new Error("socket relay supports macOS and Linux Unix sockets only");
  }
  const configured = environment[SOCKET_PATH_ENV]?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error(`${SOCKET_PATH_ENV} must be an absolute path`);
    return configured;
  }
  // /run/user/<uid> is the Linux systemd runtime directory; macOS has no equivalent.
  const runtimeDirectory =
    environment.XDG_RUNTIME_DIR?.trim() || (platform === "linux" && uid !== null ? `/run/user/${uid}` : "");
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) {
    throw new Error(`cannot resolve the Bridge socket; set ${SOCKET_PATH_ENV} or XDG_RUNTIME_DIR`);
  }
  return join(runtimeDirectory, "worker-neutral-supervisor", "codex.sock");
}

export interface RelayStreams {
  input: Readable;
  output: Writable;
  diagnostics: Writable;
}

/**
 * Relay until either side ends. Resolves with the exit code: 0 when the
 * client or the Bridge closes cleanly, 1 when the socket fails.
 */
export function runRelay(socketPath: string, streams: RelayStreams): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const socket: Socket = connect(socketPath);
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      streams.input.unpipe(socket);
      socket.destroy();
      resolve(code);
    };
    socket.once("connect", () => {
      streams.input.pipe(socket); // stdin EOF half-closes the socket write side.
    });
    socket.pipe(streams.output, { end: false });
    socket.once("end", () => {
      // The Bridge finished this session; flush what it sent, then stop.
      streams.output.write("", () => finish(0));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      streams.diagnostics.write(`local-codex-bridge relay: ${error.code ?? "socket error"} on Bridge socket\n`);
      finish(1);
    });
    socket.once("close", () => finish(0));
  });
}
