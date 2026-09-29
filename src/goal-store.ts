import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type GoalStatus = "active" | "complete";
export type ReconnectStatus = "started" | "already_in_progress" | "terminal" | "unknown";

export interface ReconnectReceipt {
  schema: "CodexGoalReconnectReceipt";
  version: 1;
  thread_id: string;
  goal_id?: string;
  goal_digest: string;
  goal_status: GoalStatus;
  turn_id: string | null;
  status: ReconnectStatus;
  before_turn_id?: string | null;
}

export interface GoalRecord {
  schema: "CodexReconnectBinding";
  version: 3;
  threadId: string;
  id: string;
  objectiveDigest: string;
  nativeGoalCreatedAt: number;
  reconnect: ReconnectReceipt | null;
}

interface ClearedGoal { schema: "CodexBridgeGoalCleared"; version: 1; threadId: string }

export function goalDigest(objective: string): string {
  return `sha256:${createHash("sha256").update(objective).digest("hex")}`;
}

function defaultDirectory(): string {
  const explicit = process.env.LCB_GOAL_STATE_DIR;
  if (explicit) return resolve(explicit);
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || homedir(), "LocalCodexBridge", "goals-v1");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "local-codex-bridge", "goals-v1");
}

export class GoalStore {
  constructor(private readonly directory = defaultDirectory()) {}

  private path(threadId: string): string {
    return join(this.directory, `${createHash("sha256").update(threadId).digest("hex")}.json`);
  }

  async read(threadId: string): Promise<GoalRecord | null> {
    let value: Record<string, unknown>;
    try { value = JSON.parse(await readFile(this.path(threadId), "utf8")) as Record<string, unknown>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (value.schema === "CodexBridgeGoalCleared" && value.version === 1 && value.threadId === threadId) return null;
    // Older bindings lack a usable native instance identity and cannot supply a receipt.
    if (value.threadId === threadId && ((value.schema === "CodexReconnectBinding" && value.version === 2)
      || (value.schema === "CodexBridgeGoal" && value.version === 1))) return null;
    if (value.schema !== "CodexReconnectBinding" || value.version !== 3 || value.threadId !== threadId
      || typeof value.id !== "string" || !/^[0-9a-f-]{8,100}$/.test(value.id)
      || typeof value.objectiveDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.objectiveDigest)
      || !Number.isSafeInteger(value.nativeGoalCreatedAt) || (value.nativeGoalCreatedAt as number) < 0) {
      throw new Error("Stored goal binding is invalid");
    }
    const reconnect = value.reconnect as ReconnectReceipt | null;
    if (reconnect === undefined || reconnect !== null && (typeof reconnect !== "object" || reconnect.schema !== "CodexGoalReconnectReceipt" || reconnect.version !== 1
      || reconnect.thread_id !== threadId || reconnect.goal_digest !== value.objectiveDigest
      || !["started", "already_in_progress", "terminal", "unknown"].includes(reconnect.status)
      || reconnect.turn_id !== null && typeof reconnect.turn_id !== "string")) throw new Error("Stored reconnect receipt is invalid");
    return { schema: "CodexReconnectBinding", version: 3, threadId,
      id: value.id as string, objectiveDigest: value.objectiveDigest as string,
      nativeGoalCreatedAt: value.nativeGoalCreatedAt as number, reconnect };
  }

  async isCleared(threadId: string): Promise<boolean> {
    try {
      const value = JSON.parse(await readFile(this.path(threadId), "utf8")) as Record<string, unknown>;
      return value.schema === "CodexBridgeGoalCleared" && value.version === 1 && value.threadId === threadId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async write(record: GoalRecord): Promise<void> { await this.writeValue(record.threadId, record); }

  private async writeValue(threadId: string, value: GoalRecord | ClearedGoal): Promise<void> {
    const path = this.path(threadId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async clear(threadId: string): Promise<void> {
    await this.writeValue(threadId, { schema: "CodexBridgeGoalCleared", version: 1, threadId });
  }

  async claim(record: GoalRecord): Promise<boolean> {
    const path = `${this.path(record.threadId)}.${record.id}.reconnect`;
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return null;
      throw error;
    });
    if (!file) return false;
    try { await file.writeFile(record.id); await file.sync(); }
    finally { await file.close(); }
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  }
}
