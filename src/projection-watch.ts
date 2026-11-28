import { watch, readFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { LEGACY_UX_PROJECTION_ENV, UX_PROJECTION_ENV } from "./ux-projection.js";

/**
 * Local-only watcher over the optional UX projection file.
 *
 * It turns projection signals into one NDJSON line per supervision-relevant
 * change (approval/input requested, request resolved, turn terminal, Bridge
 * generation changes) and prints nothing while the worker is quiet. It is a
 * wake-up hint only: native Codex state read through `codex_observe` remains
 * the source of truth, and the watcher never answers or decides anything.
 */

export interface ProjectionSignal {
  sequence: number;
  kind: string;
  thread_id: string;
  turn_id: string | null;
  status: string;
  at: string;
  request_id?: string | number;
}

export interface ProjectionSnapshot {
  generation: string;
  sequence: number;
  waiting: number;
  signals: ProjectionSignal[];
}

export type WatchLine = Record<string, unknown> & { event: string };

interface OpenRequest {
  key: string;
  signal: ProjectionSignal;
}

export interface WatchState {
  initialized: boolean;
  generation: string | null;
  sequence: number;
  open: Map<string, OpenRequest>;
}

export function initialWatchState(): WatchState {
  return { initialized: false, generation: null, sequence: 0, open: new Map() };
}

const MAX_ID_CHARS = 256;
const OBSERVE_HINT = "call codex_observe to read native state";

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS ? value : null;
}

function parseSignal(value: unknown): ProjectionSignal | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const sequence = record.sequence;
  const threadId = boundedId(record.thread_id);
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1 || threadId === null) return null;
  const kind = typeof record.kind === "string" ? record.kind.slice(0, 64) : null;
  if (kind === null) return null;
  const signal: ProjectionSignal = {
    sequence: sequence as number,
    kind,
    thread_id: threadId,
    turn_id: boundedId(record.turn_id),
    status: typeof record.status === "string" ? record.status.slice(0, 64) : "unknown",
    at: typeof record.at === "string" ? record.at.slice(0, 64) : "",
  };
  const requestId = record.request_id;
  if (
    (typeof requestId === "string" && requestId.length > 0 && requestId.length <= MAX_ID_CHARS) ||
    (typeof requestId === "number" && Number.isFinite(requestId))
  ) {
    signal.request_id = requestId;
  }
  return signal;
}

/** Parse projection JSON; returns null for anything that is not a v1 document. */
export function parseProjection(text: string): ProjectionSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const document = raw as Record<string, unknown>;
  if (document.schema_version !== 1) return null;
  const generation = boundedId((document.generation as Record<string, unknown> | undefined)?.id);
  const sequence = document.sequence;
  if (generation === null || !Number.isSafeInteger(sequence) || (sequence as number) < 0) return null;
  const waitingRaw = (document.counts as Record<string, unknown> | undefined)?.waiting;
  const waiting = Number.isSafeInteger(waitingRaw) && (waitingRaw as number) >= 0 ? (waitingRaw as number) : 0;
  const signals = Array.isArray(document.signals)
    ? document.signals
        .map(parseSignal)
        .filter((signal): signal is ProjectionSignal => signal !== null)
        .sort((left, right) => left.sequence - right.sequence)
    : [];
  return { generation, sequence: sequence as number, waiting, signals };
}

function requestKey(signal: ProjectionSignal): string {
  return signal.request_id === undefined
    ? `seq:${signal.sequence}`
    : `${typeof signal.request_id}:${String(signal.request_id)}`;
}

function signalLine(signal: ProjectionSignal, extra: Record<string, unknown> = {}): WatchLine | null {
  const base = {
    thread_id: signal.thread_id,
    turn_id: signal.turn_id,
    ...(signal.request_id === undefined ? {} : { request_id: signal.request_id }),
    sequence: signal.sequence,
    at: signal.at,
  };
  switch (signal.kind) {
    case "waiting_approval":
      return { event: "approval_requested", ...base, ...extra };
    case "waiting_user_input":
      return { event: "input_requested", ...base, ...extra };
    case "request_resolved":
      return { event: "request_resolved", ...base, status: signal.status, ...extra };
    case "terminal":
      return { event: "turn_terminal", ...base, status: signal.status, ...extra };
    default:
      return null;
  }
}

function applyToOpen(open: Map<string, OpenRequest>, signal: ProjectionSignal): void {
  if (signal.kind === "waiting_approval" || signal.kind === "waiting_user_input") {
    const key = requestKey(signal);
    open.set(key, { key, signal });
  } else if (signal.kind === "request_resolved") {
    open.delete(requestKey(signal));
  } else if (signal.kind === "terminal") {
    for (const [key, request] of open) {
      if (
        request.signal.thread_id === signal.thread_id &&
        (request.signal.turn_id === null || request.signal.turn_id === signal.turn_id)
      ) {
        open.delete(key);
      }
    }
  }
}

export interface WatchFilter {
  threads?: ReadonlySet<string>;
}

function matches(filter: WatchFilter, threadId: string): boolean {
  return !filter.threads || filter.threads.size === 0 || filter.threads.has(threadId);
}

/**
 * Pure transition: apply one read of the projection (null = file absent) and
 * return the lines to print. Quiet reads return no lines.
 */
export function reduceProjection(
  state: WatchState,
  snapshot: ProjectionSnapshot | null,
  filter: WatchFilter = {},
): WatchLine[] {
  const lines: WatchLine[] = [];

  if (!state.initialized) {
    state.initialized = true;
    if (snapshot === null) {
      lines.push({ event: "projection_unavailable", hint: "Bridge projection file is absent; is LOCAL_CODEX_BRIDGE_UX_PROJECTION enabled?" });
      return lines;
    }
    // Baseline: earlier signals are history, but still-open requests matter.
    state.generation = snapshot.generation;
    state.sequence = snapshot.sequence;
    for (const signal of snapshot.signals) applyToOpen(state.open, signal);
    for (const request of state.open.values()) {
      if (!matches(filter, request.signal.thread_id)) continue;
      const line = signalLine(request.signal, { replayed: true });
      if (line) lines.push(line);
    }
    // More live requests than the bounded history explains: some were dropped.
    if (snapshot.waiting > state.open.size) {
      lines.push({ event: "signal_gap", reason: "history_truncated", waiting: snapshot.waiting, hint: OBSERVE_HINT });
    }
    return lines;
  }

  if (snapshot === null) {
    if (state.generation !== null) {
      lines.push({ event: "bridge_stopped", hint: "live pending state is gone; " + OBSERVE_HINT });
      state.generation = null;
      state.open.clear();
    }
    return lines;
  }

  if (snapshot.generation !== state.generation || snapshot.sequence < state.sequence) {
    // A new Bridge process: every signal in it is new, but live state was lost.
    lines.push({
      event: state.generation === null && state.sequence === 0 ? "projection_available" : "bridge_restarted",
      hint: "earlier live pending state is gone; " + OBSERVE_HINT,
    });
    state.generation = snapshot.generation;
    state.sequence = 0;
    state.open.clear();
  }

  const fresh = snapshot.signals.filter((signal) => signal.sequence > state.sequence);
  const first = fresh[0];
  if (first && first.sequence > state.sequence + 1) {
    lines.push({
      event: "signal_gap",
      reason: "signals_dropped",
      missed_from: state.sequence + 1,
      missed_to: first.sequence - 1,
      hint: OBSERVE_HINT,
    });
  } else if (!first && snapshot.sequence > state.sequence) {
    lines.push({
      event: "signal_gap",
      reason: "signals_dropped",
      missed_from: state.sequence + 1,
      missed_to: snapshot.sequence,
      hint: OBSERVE_HINT,
    });
  }
  for (const signal of fresh) {
    applyToOpen(state.open, signal);
    if (!matches(filter, signal.thread_id)) continue;
    const line = signalLine(signal);
    if (line) lines.push(line);
  }
  state.sequence = Math.max(state.sequence, snapshot.sequence);
  return lines;
}

export function defaultProjectionPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = environment[UX_PROJECTION_ENV]?.trim() || environment[LEGACY_UX_PROJECTION_ENV]?.trim();
  if (configured) return resolve(configured);
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim();
    if (localAppData) return join(localAppData, "LocalCodexBridge", "ux-projection.json");
  }
  return join(homedir(), ".local", "state", "LocalCodexBridge", "ux-projection.json");
}

export interface WatchOptions {
  projectionPath: string;
  threads: ReadonlySet<string>;
  untilTerminal: boolean;
  pollMs: number;
  write: (line: string) => void;
}

export interface CliParseResult {
  options?: Omit<WatchOptions, "write">;
  error?: string;
  help?: boolean;
}

export const WATCH_USAGE = `usage: watch-cli [--thread <id>]... [--projection <absolute path>] [--until-terminal] [--poll-ms <ms>]

Prints one NDJSON line per approval/input request, request resolution, turn
terminal state, or Bridge restart seen in the local UX projection file, and
nothing while quiet. Wake-up hint only; read details with codex_observe.`;

export function parseWatchArgs(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): CliParseResult {
  const threads = new Set<string>();
  let projectionPath: string | undefined;
  let untilTerminal = false;
  let pollMs = 30_000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string | undefined => argv[++index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--thread") {
      const value = boundedId(next());
      if (value === null) return { error: "--thread requires a non-empty thread id" };
      threads.add(value);
    } else if (arg === "--projection") {
      const value = next();
      if (!value || !isAbsolute(value)) return { error: "--projection requires an absolute path" };
      projectionPath = value;
    } else if (arg === "--until-terminal") {
      untilTerminal = true;
    } else if (arg === "--poll-ms") {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 100 || value > 600_000) return { error: "--poll-ms must be an integer from 100 to 600000" };
      pollMs = value;
    } else {
      return { error: `unknown argument: ${String(arg)}` };
    }
  }
  if (untilTerminal && threads.size === 0) return { error: "--until-terminal requires --thread" };
  return {
    options: {
      projectionPath: projectionPath ?? defaultProjectionPath(environment),
      threads,
      untilTerminal,
      pollMs,
    },
  };
}

function readSnapshot(path: string): ProjectionSnapshot | null | "invalid" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "invalid";
  }
  return parseProjection(text) ?? "invalid";
}

/**
 * Run the watcher until stopped. Change detection uses fs.watch on the parent
 * directory (the projection is replaced by rename) with a slow periodic
 * re-read as a safety net. Resolves when --until-terminal is satisfied or
 * the returned stop() is called.
 */
export function runWatch(options: WatchOptions): { done: Promise<void>; stop: () => void } {
  const state = initialWatchState();
  const filter: WatchFilter = { threads: options.threads };
  const directory = dirname(options.projectionPath);
  const fileName = basename(options.projectionPath);
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let stopped = false;
  let finish!: () => void;
  const done = new Promise<void>((resolveDone) => (finish = resolveDone));

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(debounce);
    clearInterval(poll);
    watcher?.close();
    finish();
  };

  const ensureWatcher = (): void => {
    if (watcher || stopped) return;
    try {
      watcher = watch(directory, { persistent: true }, (_event, changed) => {
        if (changed === null || String(changed) === fileName) schedule();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined; // Directory not there yet; the periodic read retries.
    }
  };

  const check = (): void => {
    if (stopped) return;
    ensureWatcher();
    const snapshot = readSnapshot(options.projectionPath);
    if (snapshot === "invalid") return;
    if (snapshot === null) rearm(); // The directory may have been replaced.
    for (const line of reduceProjection(state, snapshot, filter)) {
      options.write(`${JSON.stringify(line)}\n`);
      if (
        options.untilTerminal &&
        line.event === "turn_terminal" &&
        typeof line.thread_id === "string" &&
        options.threads.has(line.thread_id)
      ) {
        stop();
        return;
      }
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    clearTimeout(debounce);
    debounce = setTimeout(check, 25);
  };

  const rearm = (): void => {
    watcher?.close();
    watcher = undefined;
    ensureWatcher();
  };

  // Periodic safety net: re-arm (a replaced directory leaves a dead watch) and re-read.
  const poll = setInterval(() => {
    rearm();
    check();
  }, options.pollMs);
  check();
  return { done, stop };
}
