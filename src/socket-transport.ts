import { createServer, type Server, type Socket } from "node:net";
import { AppServerManager } from "./app-server.js";
import { McpStdioServer } from "./mcp.js";
import { RuntimeStore } from "./runtime.js";
import { ControlSurface } from "./tools.js";
import { createUxProjectionFromEnvironment } from "./ux-projection.js";

/**
 * Durable Unix socket transport for the MCP boundary.
 *
 * The listener is created with `createServer` and is expected to be started by
 * the entry point (normally against an inherited socket-activation fd), which
 * keeps this class usable with an ordinary path-bound listener in tests.
 */
export class SocketTransport {
  readonly #appServer: AppServerManager;
  readonly #control: ControlSurface;
  readonly #listener: Server;
  readonly #sessions = new Set<McpStdioServer>();
  readonly #sockets = new Set<Socket>();
  #stopping = false;

  constructor() {
    this.#appServer = new AppServerManager(
      new RuntimeStore(256, createUxProjectionFromEnvironment()),
    );
    this.#control = new ControlSurface(this.#appServer);
    this.#listener = createServer((socket) => this.#onConnection(socket));
  }

  get listener(): Server {
    return this.#listener;
  }

  #onConnection(socket: Socket): void {
    if (this.#stopping) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    let session: McpStdioServer;
    session = new McpStdioServer(this.#control, {
      input: socket,
      output: socket,
      onClose: async () => {
        this.#sessions.delete(session);
        this.#sockets.delete(socket);
        await session.close();
        socket.destroy();
      },
    });
    this.#sessions.add(session);
    session.start();
  }

  /**
   * Stop accepting, tear down live client connections, then wait for the
   * listener and sessions to finish.
   *
   * `Server.close()` only invokes its callback once every established
   * connection has ended, so a connected client must be destroyed *before*
   * awaiting it. Awaiting the callback first deadlocks shutdown indefinitely
   * while any MCP client stays connected.
   */
  async shutdown(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;
    const listenerClosed = new Promise<void>((resolve) => {
      this.#listener.close(() => resolve());
    });
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    await listenerClosed;
    await Promise.all([...this.#sessions].map((session) => session.close()));
    await this.#appServer.close();
    this.#appServer.runtime.closeUxProjection();
  }
}
