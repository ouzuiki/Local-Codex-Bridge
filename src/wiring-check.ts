/**
 * Supervisor wiring check: does the MCP entry a supervisor actually launches
 * reach the one socket-activated Bridge whose UX projection watch-cli reads?
 *
 * Fact gathering lives in wiring-check-cli.ts; this module only judges facts,
 * so the rules are testable without a live service.
 */

export interface WiringFacts {
  /** Command line of the launched MCP entry process after exec. */
  launchedArgs: string | null;
  /** Number of descendant processes of the launched entry. */
  launchedDescendants: number;
  /** serverInfo from MCP initialize through the launched entry, or null. */
  serverInfo: { name: string; version: string } | null;
  /** systemd MainPID of the Bridge service (0 when inactive). */
  serviceMainPid: number;
  /** Projection document generation pid, or null when the file is absent/invalid. */
  projectionPid: number | null;
  /** Socket path the relay resolves vs. the socket unit's listen path. */
  relaySocketPath: string | null;
  serviceListenPath: string | null;
  /** Optional expected Bridge version. */
  expectedVersion?: string;
}

export interface WiringVerdict {
  ok: boolean;
  problems: string[];
}

export function evaluateWiring(facts: WiringFacts): WiringVerdict {
  const problems: string[] = [];
  if (!facts.launchedArgs?.includes("socket-relay-cli.js")) {
    problems.push("MCP entry does not exec the socket relay; it likely runs a private per-session Bridge without the shared projection");
  }
  if (facts.launchedDescendants > 0) {
    problems.push("MCP entry spawned child processes; a relay must not start its own app-server");
  }
  if (!facts.serverInfo || facts.serverInfo.name !== "local-codex-bridge") {
    problems.push("MCP initialize through the entry did not reach local-codex-bridge");
  } else if (facts.expectedVersion && facts.serverInfo.version !== facts.expectedVersion) {
    problems.push(`Bridge version ${facts.serverInfo.version} differs from expected ${facts.expectedVersion}`);
  }
  if (facts.serviceMainPid <= 0) {
    problems.push("Bridge service is not running");
  }
  if (facts.projectionPid === null) {
    problems.push("UX projection file is absent or invalid; the serving Bridge has no projection sink");
  } else if (facts.serviceMainPid > 0 && facts.projectionPid !== facts.serviceMainPid) {
    problems.push(`UX projection belongs to pid ${facts.projectionPid}, not the serving Bridge pid ${facts.serviceMainPid}`);
  }
  if (!facts.relaySocketPath || !facts.serviceListenPath || facts.relaySocketPath !== facts.serviceListenPath) {
    problems.push(`relay socket ${facts.relaySocketPath ?? "unknown"} is not the service listen socket ${facts.serviceListenPath ?? "unknown"}`);
  }
  return { ok: problems.length === 0, problems };
}
