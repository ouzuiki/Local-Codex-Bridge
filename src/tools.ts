import { AppServerManager } from "./app-server.js";
import { randomUUID } from "node:crypto";
import { GoalStore, goalDigest, type GoalRecord, type ReconnectReceipt } from "./goal-store.js";
import {
  CompletedWriteback,
  readMemoryPolicy,
  recallForFreshRun,
  type MemoryPort,
  type RecallAcknowledgement,
} from "@ouzuiki/worker-memory-contract";
import {
  MAX_OBSERVE_WAIT_MS,
  sanitizeForTransport,
  type TerminalNotification,
  type RpcId,
} from "./runtime.js";
import { platformPolicyFor, type PlatformPolicy } from "./platform.js";
import type { MemoryCoreClient } from "./memory-core-client.js";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const approvalPolicySchema = {
  type: "string",
  enum: ["untrusted", "on-request", "never"],
  description: "Codex app-server approval policy override.",
};

const sandboxSchema = {
  type: "string",
  enum: ["read-only", "workspace-write", "danger-full-access"],
  description: "Codex app-server sandbox mode override.",
};

const NATIVE_SANDBOX_POLICY_TYPE_BY_MODE = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess",
} as const;

type PublicSandboxMode = keyof typeof NATIVE_SANDBOX_POLICY_TYPE_BY_MODE;

const NATIVE_APPROVAL_POLICIES = new Set([
  "untrusted",
  "on-request",
  "never",
]);

const BOUNDED_TOOL_CONFIG = { features: { shell_tool: false, unified_exec: false }, web_search: "disabled" };
const DELIVERY_ACTION_DYNAMIC_TOOL = { type: "function", name: "delivery_action",
  description: "Request one exact typed DeliveryContract effect from the Host.",
  inputSchema: { type: "object", additionalProperties: false, required: ["capability", "input"],
    properties: { capability: { type: "object" }, input: { type: "object" },
      candidate_digest: { type: ["string", "null"], pattern: "^sha256:[0-9a-f]{64}$" } } } };
const REVIEW_SOURCE_DYNAMIC_TOOL = { type: "function", name: "review_source",
  description: "Inspect the frozen Candidate by relative path or run one bounded disposable test.",
  inputSchema: { type: "object", additionalProperties: false, required: ["operation"],
    properties: { operation: { type: "string", enum: ["list", "read", "test"] },
      path: { type: "string" }, offset: { type: "integer" }, argv: { type: "array", items: { type: "string" } } } } };

type PublicApprovalPolicy = "untrusted" | "on-request" | "never";

const SUPPORTED_RESPOND_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/tool/requestUserInput",
]);

const MODEL_LIST_PAGE_LIMIT = 100;
const MAX_MODEL_CATALOG_PAGES = 100;
const MAX_MODEL_CATALOG_ENTRIES = 10_000;
const MAX_RATE_LIMIT_ENTRIES = 100;
const MAX_RESET_CREDIT_ENTRIES = 20;

interface MemoryRecallResult {
  text: string;
  acknowledgement: RecallAcknowledgement;
}

interface PendingMemoryWriteback {
  threadId: string;
  turnId: string;
  handle: CompletedWriteback;
}

interface ModelListPage {
  data: Record<string, unknown>[];
  nextCursor: string | null;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "codex_threads",
    title: "Codex Threads",
    description:
      "List or search persistent local Codex threads through thread/list, or read one thread through thread/read. This does not reconstruct live Bridge events.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "When supplied, read this exact Codex thread instead of listing threads.",
        },
        include_turns: {
          type: "boolean",
          default: false,
          description: "Include persisted turns when reading one thread.",
        },
        cwd: {
          type: "string",
          maxLength: 1000,
          description: "Optional exact absolute native cwd filter for thread/list.",
        },
        search_term: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional Codex title substring filter for thread/list.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
          description: "Opaque cursor returned by a prior thread/list call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum threads in the returned page.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Threads",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_goal",
    title: "Codex Goal Compatibility",
    description: "Durable goal bound to one native thread. Reconnect owns one idempotent lifecycle attempt and returns an exact receipt; unknown outcomes are never replayed.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["set", "get", "clear", "reconnect"] },
        thread_id: { type: "string", minLength: 1, maxLength: 200 },
        objective: { type: "string", minLength: 1, maxLength: 200000 },
        sandbox: sandboxSchema,
        approval_policy: approvalPolicySchema,
      },
      required: ["operation", "thread_id"],
      additionalProperties: false,
    },
    annotations: { title: "Codex Goal Compatibility", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "codex_models",
    title: "Codex Models",
    description:
      "Read one current model/list page directly from Codex app-server. Results are bounded and sanitized, cursors are opaque, hidden models are omitted unless include_hidden is true, and the Bridge keeps no model catalog cache or current-model registry.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
          description: "Opaque cursor returned by a prior model/list call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MODEL_LIST_PAGE_LIMIT,
          default: 20,
          description: "Maximum models in the returned page.",
        },
        include_hidden: {
          type: "boolean",
          default: false,
          description: "Request hidden models through native model/list includeHidden.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Models",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_rate_limits",
    title: "Codex Rate Limits",
    description:
      "Read current ChatGPT Codex quota state directly through account/rateLimits/read. This read-only path starts no native thread or turn and invokes no model. Results are normalized, bounded, and sanitized; opaque reset-credit IDs are omitted.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Rate Limits",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "codex_turn",
    title: "Start or Continue Codex Turn",
    description:
      "Start a persistent Codex thread and turn, or resume an existing thread and start a turn. Prefer continuing the same native thread when its context remains useful, but a fresh thread is allowed; thread_id is not a permanent task identity. Explicit model or effort overrides are validated against a fresh model/list catalog without caching. Effort alone is checked only against efforts advertised somewhere in that catalog; the Bridge does not infer the current thread model, so app-server remains authoritative for current-model compatibility. Returns as soon as turn/start is accepted; observe separately for events and completion. If an already-sent mutating acknowledgement times out, the outcome is UNKNOWN and the request was possibly accepted; observe/read before any retry, and never directly retry it.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 200000,
          description: "User text passed directly to Codex as one text input item.",
        },
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Existing persistent Codex thread to resume. Omit to create a new thread.",
        },
        cwd: {
          type: "string",
          maxLength: 1000,
          description: "Absolute native cwd. Required for a new thread; optional override for resume.",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional model/list id or model identifier, validated on demand and passed through unchanged.",
        },
        effort: {
          type: "string",
          minLength: 1,
          maxLength: 32,
          description: "Optional reasoning effort. With no model, only catalog-wide token existence is checked; current-model compatibility remains native-authoritative.",
        },
        sandbox: sandboxSchema,
        approval_policy: approvalPolicySchema,
        delivery_action_tool: { type: "object", properties: { version: { type: "integer", enum: [2, 3] } }, required: ["version"], additionalProperties: false },
      },
      required: ["text"],
      anyOf: [{ required: ["thread_id"] }, { required: ["cwd"] }],
      additionalProperties: false,
    },
    annotations: {
      title: "Start or Continue Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_observe",
    title: "Observe Codex Turn",
    description:
      "Read bounded incremental sanitized Bridge runtime events, live semantic progress, pending requests, and terminal output for a thread. Optional wait_ms performs one bounded event-driven wait only when the live turn is active and the current snapshot has nothing useful; it is not polling or stall detection. After Bridge process loss, falls back to persistent thread/read history and marks live state and semantic progress unreconstructable. A long interval with no new command or output can still mean Codex is actively reasoning; absence of new command activity alone is not evidence of a stall. Normal supervision lets the authorized turn run autonomously and observes for pending requests or completion. Steer only for a concrete semantic correction or changed intent, and interrupt only for explicit cancellation or an exceptional safety/recovery need.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Codex thread to observe." },
        cursor: {
          type: "integer",
          minimum: 0,
          description: "Return runtime events with a cursor greater than this value.",
        },
        stream_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional stream identity from a prior observe. A mismatch is disclosed as stream_changed/cursor_lost.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
          description: "Maximum runtime events to return.",
        },
        wait_ms: {
          type: "integer",
          minimum: 0,
          maximum: MAX_OBSERVE_WAIT_MS,
          default: 0,
          description:
            "Optional per-call wait for the next live runtime change when nothing useful is ready; 0 returns immediately. This is event-driven waiting, not stall detection.",
        },
      },
      required: ["thread_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Observe Codex Turn",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_steer",
    title: "Steer Active Codex Turn",
    description:
      "Exceptional control: append text to the same active Codex turn using turn/steer with an expected turn-id precondition. This does not create a new turn and is not part of normal progress supervision. Do not steer merely because reasoning is taking a long time or no new command has appeared; steer only for a semantic redirect or correction based on new evidence or changed user intent. If an already-sent mutating acknowledgement times out, the outcome is UNKNOWN and the request was possibly accepted; observe/read before any retry, and never directly retry it.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Active Codex thread." },
        expected_turn_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Exact active turn id required by app-server.",
        },
        text: { type: "string", minLength: 1, maxLength: 200000, description: "Additional user text." },
      },
      required: ["thread_id", "expected_turn_id", "text"],
      additionalProperties: false,
    },
    annotations: {
      title: "Steer Active Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_respond",
    title: "Respond to Codex Request",
    description:
      "Answer one currently pending app-server server request by its original raw JSON-RPC id and exact thread/method scope. Supports stable item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval, and item/tool/requestUserInput contracts, plus existing legacy execCommandApproval/applyPatchApproval compatibility. Unsupported or unknown methods fail locally and remain pending; do not guess a future response contract.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          oneOf: [{ type: "string", minLength: 1 }, { type: "integer" }],
          description: "Original app-server JSON-RPC request id, preserving string or integer type.",
        },
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact pending-request thread scope." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact turn scope when the pending request has one." },
        method: { type: "string", minLength: 1, maxLength: 300, description: "Exact app-server request method." },
        decision: {
          type: "string",
          enum: ["accept", "acceptForSession", "decline", "cancel"],
          description: "Command or file approval decision.",
        },
        execpolicy_amendment: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Command approval exec-policy amendment; encoded in app-server's native decision shape.",
        },
        answers: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              answers: { type: "array", items: { type: "string" } },
            },
            required: ["answers"],
            additionalProperties: false,
          },
          description: "request_user_input question-id to answer-array mapping.",
        },
        permissions: {
          type: "object",
          additionalProperties: true,
          description: "Granted subset for item/permissions/requestApproval. An empty object grants none of the requested permissions.",
        },
        scope: {
          type: "string",
          enum: ["turn", "session"],
          description: "Optional permission grant scope; omit or use turn for the current turn, or session for the session.",
        },
        response: {
          type: "object",
          additionalProperties: true,
          description: "Exact generic result object for item/tool/requestUserInput; unsupported or future methods remain pending and are rejected locally.",
        },
      },
      required: ["request_id", "thread_id", "method"],
      anyOf: [
        { required: ["decision"] },
        { required: ["execpolicy_amendment"] },
        { required: ["answers"] },
        { required: ["permissions"] },
        { required: ["response"] },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Respond to Codex Request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_interrupt",
    title: "Interrupt Codex Turn",
    description:
      "Exceptional control: directly request turn/interrupt for the specified active Codex thread and turn after explicit cancellation or a concrete safety/recovery need. It is not a progress timer and does not stop or restart the Bridge or Codex app-server processes. If an already-sent mutating acknowledgement times out, the outcome is UNKNOWN and the request was possibly accepted; observe/read before any retry, and never directly retry it.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Active Codex thread." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, description: "Active Codex turn to interrupt." },
      },
      required: ["thread_id", "turn_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Interrupt Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_search",
    title: "Search Advisory Memory",
    description:
      "Search advisory L1 memory from TencentDB MemoryCore. Recalled memory is not authoritative project truth; verify Git/DB/docs/contracts when correctness depends on it.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: { type: "string", minLength: 1, maxLength: 200 },
        agent_id: { type: "string", minLength: 1, maxLength: 200 },
        user_id: { type: "string", minLength: 1, maxLength: 200 },
        session_id: { type: "string", minLength: 1, maxLength: 500 },
        query: { type: "string", minLength: 1, maxLength: 10_000 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        type: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["team_id", "agent_id", "user_id", "session_id", "query"],
      additionalProperties: false,
    },
    annotations: {
      title: "Search Advisory Memory",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "memory_record_turn",
    title: "Record Conversation Context",
    description:
      "Record raw L0 conversation or verified execution context for asynchronous memory extraction. This does not create authoritative project truth or directly create L1 memory.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: { type: "string", minLength: 1, maxLength: 200 },
        agent_id: { type: "string", minLength: 1, maxLength: 200 },
        user_id: { type: "string", minLength: 1, maxLength: 200 },
        session_id: { type: "string", minLength: 1, maxLength: 500 },
        messages: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant"] },
              content: { type: "string", minLength: 1, maxLength: 200_000 },
            },
            required: ["role", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["team_id", "agent_id", "user_id", "session_id", "messages"],
      additionalProperties: false,
    },
    annotations: {
      title: "Record Conversation Context",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
] as const;

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

function asObject(value: unknown, label = "arguments"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extras = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`Unknown argument field: ${extras[0]}`);
  }
}

function requiredString(args: Record<string, unknown>, key: string, max = 200_000): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new Error(`${key} exceeds ${max} characters`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  max = 200_000,
): string | undefined {
  if (args[key] === undefined) {
    return undefined;
  }
  return requiredString(args, key, max);
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function enumValue<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function responseRecord(value: unknown, method: string): Record<string, unknown> {
  const record = asObject(value, `${method} response`);
  return record;
}

function modelListPage(value: unknown, maximumEntries: number): ModelListPage {
  const page = responseRecord(value, "model/list");
  if (!Array.isArray(page.data)) {
    throw new Error("model/list returned no data array");
  }
  if (page.data.length > maximumEntries) {
    throw new Error(`model/list returned more than the requested ${maximumEntries} entries`);
  }
  const data = page.data.map((entry, index) => asObject(entry, `model/list data[${index}]`));
  const rawNextCursor = page.nextCursor;
  if (rawNextCursor === undefined || rawNextCursor === null) {
    return { data, nextCursor: null };
  }
  if (
    typeof rawNextCursor !== "string" ||
    rawNextCursor.length === 0 ||
    rawNextCursor.length > 10_000
  ) {
    throw new Error("model/list returned an invalid nextCursor");
  }
  return { data, nextCursor: rawNextCursor };
}

function sanitizedModelEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return asObject(
    sanitizeForTransport(entry, {
      maxStringChars: 4_000,
      maxDepth: 8,
      maxArrayItems: 40,
      maxObjectKeys: 80,
      totalCharBudget: 24_000,
    }),
    "sanitized model/list entry",
  );
}

function nullableBoundedString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length > 4_000) {
    throw new Error(`${label} returned an invalid string`);
  }
  const sanitized = sanitizeForTransport(value, {
    maxStringChars: 4_000,
    totalCharBudget: 4_000,
  });
  return typeof sanitized === "string" ? sanitized : null;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} returned an invalid boolean`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} returned an invalid number`);
  }
  return value;
}

function normalizedRateWindow(value: unknown, label: string): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }
  const window = asObject(value, label);
  const usedPercent = Math.min(100, Math.max(0, finiteNumber(window.usedPercent, `${label}.usedPercent`)));
  const windowDurationMins = finiteNumber(
    window.windowDurationMins,
    `${label}.windowDurationMins`,
  );
  const resetsAt = finiteNumber(window.resetsAt, `${label}.resetsAt`);
  if (windowDurationMins < 0 || resetsAt < 0) {
    throw new Error(`${label} returned an invalid window boundary`);
  }
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins,
    resetsAt,
  };
}

function sanitizedCredits(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  return sanitizeForTransport(value, {
    maxStringChars: 1_000,
    maxDepth: 5,
    maxArrayItems: 20,
    maxObjectKeys: 30,
    totalCharBudget: 8_000,
  });
}

function normalizedRateLimit(
  value: unknown,
  label: string,
  fallbackLimitId?: string,
): Record<string, unknown> {
  const limit = asObject(value, label);
  const rawLimitId = limit.limitId ?? fallbackLimitId;
  if (typeof rawLimitId !== "string" || rawLimitId.length === 0 || rawLimitId.length > 200) {
    throw new Error(`${label}.limitId returned an invalid string`);
  }
  return {
    limitId: rawLimitId,
    limitName: nullableBoundedString(limit.limitName, `${label}.limitName`),
    planType: nullableBoundedString(limit.planType, `${label}.planType`),
    rateLimitReachedType: nullableBoundedString(
      limit.rateLimitReachedType,
      `${label}.rateLimitReachedType`,
    ),
    spendControlReached: nullableBoolean(
      limit.spendControlReached,
      `${label}.spendControlReached`,
    ),
    credits: sanitizedCredits(limit.credits),
    primary: normalizedRateWindow(limit.primary, `${label}.primary`),
    secondary: normalizedRateWindow(limit.secondary, `${label}.secondary`),
  };
}

function normalizedResetCredit(value: unknown, index: number): Record<string, unknown> {
  const credit = asObject(value, `account/rateLimits/read rateLimitResetCredits.credits[${index}]`);
  const output: Record<string, unknown> = {};
  for (const key of [
    "resetType",
    "status",
    "grantedAt",
    "expiresAt",
    "title",
    "description",
  ] as const) {
    const field = credit[key];
    if (field === undefined) {
      continue;
    }
    if (
      field !== null &&
      typeof field !== "string" &&
      (typeof field !== "number" || !Number.isFinite(field)) &&
      typeof field !== "boolean"
    ) {
      throw new Error(`account/rateLimits/read reset credit ${key} is invalid`);
    }
    output[key] = field;
  }
  return asObject(
    sanitizeForTransport(output, {
      maxStringChars: 1_000,
      maxDepth: 3,
      maxArrayItems: 1,
      maxObjectKeys: 10,
      totalCharBudget: 4_000,
    }),
    "sanitized account/rateLimits/read reset credit",
  );
}

function normalizedRateLimitsResponse(value: unknown): Record<string, unknown> {
  const response = responseRecord(value, "account/rateLimits/read");
  const rawMap = response.rateLimitsByLimitId === undefined
    ? undefined
    : asObject(response.rateLimitsByLimitId, "account/rateLimits/read rateLimitsByLimitId");
  const rawMain = response.rateLimits ?? rawMap?.codex;
  if (rawMain === undefined || rawMain === null) {
    throw new Error("account/rateLimits/read returned no rateLimits object");
  }
  const main = normalizedRateLimit(rawMain, "account/rateLimits/read rateLimits", "codex");
  const entries = rawMap ? Object.entries(rawMap) : [[String(main.limitId), rawMain] as const];
  const normalizedMap = Object.create(null) as Record<string, unknown>;
  for (const [limitId, rawLimit] of entries.slice(0, MAX_RATE_LIMIT_ENTRIES)) {
    if (limitId.length === 0 || limitId.length > 200) {
      throw new Error("account/rateLimits/read returned an invalid limit id");
    }
    normalizedMap[limitId] = normalizedRateLimit(
      rawLimit,
      `account/rateLimits/read rateLimitsByLimitId.${limitId}`,
      limitId,
    );
  }

  let rateLimitResetCredits: Record<string, unknown> | null = null;
  if (response.rateLimitResetCredits !== undefined && response.rateLimitResetCredits !== null) {
    const resetCredits = asObject(
      response.rateLimitResetCredits,
      "account/rateLimits/read rateLimitResetCredits",
    );
    const availableCount = finiteNumber(
      resetCredits.availableCount,
      "account/rateLimits/read rateLimitResetCredits.availableCount",
    );
    if (!Number.isInteger(availableCount) || availableCount < 0) {
      throw new Error("account/rateLimits/read returned an invalid reset-credit count");
    }
    if (
      resetCredits.credits !== undefined &&
      resetCredits.credits !== null &&
      !Array.isArray(resetCredits.credits)
    ) {
      throw new Error("account/rateLimits/read returned invalid reset-credit details");
    }
    const detailRows = Array.isArray(resetCredits.credits)
      ? resetCredits.credits.slice(0, MAX_RESET_CREDIT_ENTRIES).map(normalizedResetCredit)
      : null;
    rateLimitResetCredits = {
      availableCount,
      credits: detailRows,
      ...(Array.isArray(resetCredits.credits) && resetCredits.credits.length > MAX_RESET_CREDIT_ENTRIES
        ? { truncatedCreditCount: resetCredits.credits.length - MAX_RESET_CREDIT_ENTRIES }
        : {}),
    };
  }

  return {
    source: "codex_app_server_rate_limits",
    planType: nullableBoundedString(
      response.planType ?? main.planType,
      "account/rateLimits/read planType",
    ),
    rateLimitReachedType: nullableBoundedString(
      response.rateLimitReachedType ?? main.rateLimitReachedType,
      "account/rateLimits/read rateLimitReachedType",
    ),
    spendControlReached: nullableBoolean(
      response.spendControlReached ?? main.spendControlReached,
      "account/rateLimits/read spendControlReached",
    ),
    credits: sanitizedCredits(response.credits ?? main.credits),
    rateLimits: main,
    rateLimitsByLimitId: normalizedMap,
    ...(entries.length > MAX_RATE_LIMIT_ENTRIES
      ? { truncatedLimitCount: entries.length - MAX_RATE_LIMIT_ENTRIES }
      : {}),
    rateLimitResetCredits,
  };
}

function modelIdentifiers(entry: Record<string, unknown>): string[] {
  return [entry.id, entry.model].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function advertisedReasoningEfforts(
  entry: Record<string, unknown>,
): Set<string> | undefined {
  const advertised = entry.supportedReasoningEfforts;
  if (!Array.isArray(advertised)) {
    return undefined;
  }
  const efforts = new Set<string>();
  for (const option of advertised) {
    if (typeof option === "string" && option.length > 0) {
      efforts.add(option);
      continue;
    }
    if (option !== null && typeof option === "object" && !Array.isArray(option)) {
      const reasoningEffort = (option as Record<string, unknown>).reasoningEffort;
      if (typeof reasoningEffort === "string" && reasoningEffort.length > 0) {
        efforts.add(reasoningEffort);
        continue;
      }
    }
    return undefined;
  }
  return efforts;
}

function formattedEfforts(efforts: ReadonlySet<string>): string {
  const sorted = [...efforts].sort();
  return sorted.length > 0 ? sorted.join(", ") : "(none advertised)";
}

function extractThreadId(result: unknown, method: string): string {
  const thread = asObject(asObject(result, `${method} result`).thread, `${method} result.thread`);
  if (typeof thread.id !== "string" || thread.id.length === 0) {
    throw new Error(`${method} returned no thread id`);
  }
  return thread.id;
}

function extractTurnId(result: unknown, method: string): string {
  const turn = asObject(asObject(result, `${method} result`).turn, `${method} result.turn`);
  if (typeof turn.id !== "string" || turn.id.length === 0) {
    throw new Error(`${method} returned no turn id`);
  }
  return turn.id;
}

function extractSandboxPolicy(
  result: unknown,
  method: string,
  requestedSandbox: PublicSandboxMode,
): Record<string, unknown> {
  const policy = asObject(
    asObject(result, `${method} result`).sandbox,
    `${method} result.sandbox`,
  );
  const expectedType = NATIVE_SANDBOX_POLICY_TYPE_BY_MODE[requestedSandbox];
  if (policy.type !== expectedType) {
    throw new Error(
      `${method} returned sandbox policy type ${String(policy.type)} for requested ${requestedSandbox}`,
    );
  }
  return policy;
}

function extractApprovalPolicy(
  result: unknown,
  method: string,
  requestedApprovalPolicy: PublicApprovalPolicy,
): PublicApprovalPolicy {
  const effectiveApprovalPolicy = asObject(result, `${method} result`).approvalPolicy;
  if (typeof effectiveApprovalPolicy !== "string") {
    throw new Error(
      `${method} returned no usable effective approvalPolicy for requested ${requestedApprovalPolicy}`,
    );
  }
  if (!NATIVE_APPROVAL_POLICIES.has(effectiveApprovalPolicy)) {
    throw new Error(
      `${method} returned unrecognized effective approvalPolicy ${JSON.stringify(effectiveApprovalPolicy)}`,
    );
  }
  if (effectiveApprovalPolicy !== requestedApprovalPolicy) {
    throw new Error(
      `${method} returned effective approvalPolicy ${JSON.stringify(effectiveApprovalPolicy)} for requested ${JSON.stringify(requestedApprovalPolicy)}`,
    );
  }
  return effectiveApprovalPolicy;
}

function storedTerminal(threadResult: unknown): unknown {
  const result = asObject(threadResult, "thread/read result");
  const thread = asObject(result.thread, "thread/read result.thread");
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const turn = turns.length > 0 ? asObject(turns.at(-1), "stored turn") : null;
  if (!turn || typeof turn.id !== "string") {
    return null;
  }
  const status = typeof turn.status === "string" ? turn.status : "unknown";
  if (!["completed", "failed", "interrupted"].includes(status)) {
    return null;
  }
  const items = Array.isArray(turn.items) ? turn.items : [];
  let finalResult: string | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "agentMessage" &&
      typeof (item as Record<string, unknown>).text === "string"
    ) {
      finalResult = (item as Record<string, unknown>).text as string;
      break;
    }
  }
  return sanitizeForTransport({
    turn_id: turn.id,
    status,
    completed_at: null,
    final_result: finalResult,
    error: turn.error ?? null,
    source: "codex_app_server_thread_read",
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("MCP request cancelled");
  }
}

type MemoryClientLike = Pick<MemoryCoreClient, "atomicSearch" | "conversationAdd">;

export class ControlSurface {
  private readonly memoryClient: MemoryClientLike | undefined;
  private readonly pendingMemoryWritebacks = new Map<string, PendingMemoryWriteback>();

  constructor(
    private readonly appServer: AppServerManager,
    _retiredCheckpointStore?: never,
    private readonly platformPolicy: PlatformPolicy = platformPolicyFor(),
    memoryClient?: MemoryClientLike,
    private readonly goalStore: GoalStore = new GoalStore(),
  ) {
    this.memoryClient = memoryClient;
    this.appServer.runtime?.onTerminal?.((notification) => this.#onTerminal(notification));
  }

  #memoryPort(): MemoryPort {
    return {
      atomicSearch: async (input) => (await this.#getMemoryClient()).atomicSearch(input),
      conversationAdd: async (input) => (await this.#getMemoryClient()).conversationAdd(input),
    };
  }

  #onTerminal(notification: TerminalNotification): void {
    const key = notification.terminal.turn_id;
    const pending = this.pendingMemoryWritebacks.get(key);
    if (!pending || pending.threadId !== notification.threadId) return;
    this.pendingMemoryWritebacks.delete(key);
    if (notification.terminal.status !== "completed" || !notification.terminal.final_result) {
      void pending.handle.skip();
      this.appServer.runtime.setMemoryWritebackStatus(notification.threadId, key, "skipped");
      return;
    }
    this.appServer.runtime.setMemoryWritebackStatus(notification.threadId, key, "queued");
    void this.#writeMemory(pending, notification.terminal.final_result);
  }

  async #writeMemory(pending: PendingMemoryWriteback, finalResult: string): Promise<void> {
    const status = await pending.handle.complete(finalResult);
    this.appServer.runtime.setMemoryWritebackStatus(
      pending.threadId,
      pending.turnId,
      status === "disabled" ? "skipped" : status,
    );
  }

  #cwd(args: Record<string, unknown>): string | undefined {
    const input = optionalString(args, "cwd", 1_000);
    return input ? this.platformPolicy.validateCwd(input) : undefined;
  }

  async call(name: string, rawArguments: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = asObject(rawArguments ?? {});
    switch (name) {
      case "codex_threads":
        return await this.#threads(args);
      case "codex_models":
        return await this.#models(args);
      case "codex_rate_limits":
        return await this.#rateLimits(args);
      case "codex_turn":
        return await this.#turn(args);
      case "codex_goal":
        return await this.#goal(args);
      case "codex_observe":
        return await this.#observe(args, signal);
      case "codex_steer":
        return await this.#steer(args);
      case "codex_respond":
        return await this.#respond(args);
      case "codex_interrupt":
        return await this.#interrupt(args);
      case "memory_search":
        return await this.#memorySearch(args);
      case "memory_record_turn":
        return await this.#memoryRecordTurn(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async #getMemoryClient(): Promise<MemoryClientLike> {
    if (this.memoryClient) {
      return this.memoryClient;
    }
    const gatewayKey = process.env.TDAI_GATEWAY_API_KEY?.trim();
    if (!gatewayKey) {
      throw new Error("TencentDB memory is not configured: TDAI_GATEWAY_API_KEY is missing");
    }
    const { MemoryCoreClient } = await import("./memory-core-client.js");
    return new MemoryCoreClient({
      gatewayKey,
      baseUrl: process.env.TDAI_MEMORY_CORE_URL?.trim() || "http://127.0.0.1:8420",
      serviceId: process.env.TDAI_MEMORY_SERVICE_ID?.trim() || "local-memory-core",
    });
  }

  async #memorySearch(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["team_id", "agent_id", "user_id", "session_id", "query", "limit", "type"]);
    const result = await (await this.#getMemoryClient()).atomicSearch({
      teamId: requiredString(args, "team_id", 200).trim(),
      agentId: requiredString(args, "agent_id", 200).trim(),
      userId: requiredString(args, "user_id", 200).trim(),
      sessionId: requiredString(args, "session_id", 500).trim(),
      query: requiredString(args, "query", 10_000).trim(),
      limit: optionalInteger(args, "limit", 1, 100) ?? 20,
      ...(args.type === undefined
        ? {}
        : { type: requiredString(args, "type", 100).trim() }),
    });
    return { source: "tencentdb_memory_l1", advisory: true, items: result.items };
  }

  async #memoryRecordTurn(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["team_id", "agent_id", "user_id", "session_id", "messages"]);
    if (!Array.isArray(args.messages) || args.messages.length < 1 || args.messages.length > 100) {
      throw new Error("messages must contain from 1 to 100 items");
    }
    const messages = args.messages.map((value, index) => {
      const message = asObject(value, `messages[${index}]`);
      onlyKeys(message, ["role", "content"]);
      const role = enumValue(message, "role", ["user", "assistant"] as const);
      if (!role) {
        throw new Error(`messages[${index}].role is required`);
      }
      const content = requiredString(message, "content", 200_000);
      return { role, content };
    });
    const result = await (await this.#getMemoryClient()).conversationAdd({
      teamId: requiredString(args, "team_id", 200).trim(),
      agentId: requiredString(args, "agent_id", 200).trim(),
      userId: requiredString(args, "user_id", 200).trim(),
      sessionId: requiredString(args, "session_id", 500).trim(),
      messages,
    });
    return {
      source: "tencentdb_memory_l0",
      accepted_count: result.acceptedIds.length,
      pipeline_async: true,
    };
  }

  async #autoRecall(text: string, requestedThreadId: string | undefined, cwd: string | undefined): Promise<MemoryRecallResult> {
    const recalled = await recallForFreshRun({
      originalTask: text,
      cwd: cwd ?? "",
      resumed: requestedThreadId !== undefined,
      client: this.#memoryPort(),
    });
    return { text: recalled.effectiveTask, acknowledgement: recalled.acknowledgement };
  }

  async #threads(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "include_turns", "cwd", "search_term", "cursor", "limit"]);
    const threadId = optionalString(args, "thread_id", 200);
    if (threadId) {
      if (args.cwd !== undefined || args.search_term !== undefined || args.cursor !== undefined || args.limit !== undefined) {
        throw new Error("thread_id cannot be combined with list/search fields");
      }
      const includeTurns = optionalBoolean(args, "include_turns") ?? false;
      const result = await this.appServer.request("thread/read", {
        threadId,
        includeTurns,
      });
      return sanitizeForTransport({ source: "codex_app_server", mode: "read", ...responseRecord(result, "thread/read") });
    }
    if (args.include_turns !== undefined) {
      throw new Error("include_turns is valid only with thread_id");
    }
    const cwd = this.#cwd(args);
    const searchTerm = optionalString(args, "search_term", 500);
    const cursor = optionalString(args, "cursor", 10_000);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 20;
    const result = await this.appServer.request("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      ...(cwd ? { cwd } : {}),
      ...(searchTerm ? { searchTerm } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const page = responseRecord(result, "thread/list");
    if (!Array.isArray(page.data)) {
      throw new Error("thread/list returned no data array");
    }
    return {
      source: "codex_app_server",
      mode: "list",
      nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
      backwardsCursor: typeof page.backwardsCursor === "string" ? page.backwardsCursor : null,
      data: page.data.map((thread) => sanitizeForTransport(thread, {
        maxStringChars: 4_000,
        maxDepth: 6,
        maxArrayItems: 20,
        maxObjectKeys: 60,
        totalCharBudget: 12_000,
      })),
    };
  }

  async #models(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["cursor", "limit", "include_hidden"]);
    const cursor = optionalString(args, "cursor", 10_000);
    const limit = optionalInteger(args, "limit", 1, MODEL_LIST_PAGE_LIMIT) ?? 20;
    const includeHidden = optionalBoolean(args, "include_hidden") ?? false;
    const page = modelListPage(
      await this.appServer.request("model/list", {
        limit,
        includeHidden,
        ...(cursor ? { cursor } : {}),
      }),
      limit,
    );
    return {
      source: "codex_app_server_model_list",
      data: page.data.map(sanitizedModelEntry),
      nextCursor: page.nextCursor,
    };
  }

  async #rateLimits(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, []);
    return normalizedRateLimitsResponse(
      await this.appServer.request("account/rateLimits/read", {}),
    );
  }

  async #fullModelCatalog(): Promise<Record<string, unknown>[]> {
    const catalog: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_MODEL_CATALOG_PAGES; pageNumber += 1) {
      const page = modelListPage(
        await this.appServer.request("model/list", {
          limit: MODEL_LIST_PAGE_LIMIT,
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        }),
        MODEL_LIST_PAGE_LIMIT,
      );
      catalog.push(...page.data);
      if (catalog.length > MAX_MODEL_CATALOG_ENTRIES) {
        throw new Error(`model/list catalog exceeded ${MAX_MODEL_CATALOG_ENTRIES} entries`);
      }
      if (page.nextCursor === null) {
        return catalog;
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("model/list pagination cursor cycle detected");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`model/list catalog exceeded ${MAX_MODEL_CATALOG_PAGES} pages`);
  }

  async #validateExecutionOverrides(
    model: string | undefined,
    effort: string | undefined,
  ): Promise<void> {
    if (!model && !effort) {
      return;
    }
    const catalog = await this.#fullModelCatalog();
    if (model) {
      const matches = catalog.filter((entry) => modelIdentifiers(entry).includes(model));
      if (matches.length === 0) {
        throw new Error(
          `Unknown model override ${JSON.stringify(model)}; current model/list catalog contains no matching id or model`,
        );
      }
      if (!effort) {
        return;
      }
      const advertised = matches.map(advertisedReasoningEfforts);
      if (advertised.some((efforts) => efforts === undefined)) {
        return;
      }
      const supported = new Set(advertised.flatMap((efforts) => [...efforts!]));
      if (!supported.has(effort)) {
        throw new Error(
          `Unsupported effort ${JSON.stringify(effort)} for model ${JSON.stringify(model)}; advertised supportedReasoningEfforts: ${formattedEfforts(supported)}`,
        );
      }
      return;
    }

    const advertised = new Set<string>();
    for (const entry of catalog) {
      const efforts = advertisedReasoningEfforts(entry);
      if (efforts) {
        for (const candidate of efforts) {
          advertised.add(candidate);
        }
      }
    }
    if (!advertised.has(effort!)) {
      throw new Error(
        `Unknown effort override ${JSON.stringify(effort)}; it is absent from all advertised supportedReasoningEfforts in the current model/list catalog. The Bridge does not infer the current thread model. Advertised efforts: ${formattedEfforts(advertised)}`,
      );
    }
  }

  async #turn(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["text", "thread_id", "cwd", "model", "effort", "sandbox", "approval_policy", "delivery_action_tool"]);
    const text = requiredString(args, "text");
    const requestedThreadId = optionalString(args, "thread_id", 200);
    const cwd = this.#cwd(args);
    if (!requestedThreadId && !cwd) {
      throw new Error(
        `cwd is required when thread_id is omitted and must be an ${this.platformPolicy.nativeCwdDescription}`,
      );
    }
    const model = optionalString(args, "model", 100);
    const effort = optionalString(args, "effort", 32);
    const sandbox = enumValue(args, "sandbox", ["read-only", "workspace-write", "danger-full-access"] as const);
    const approvalPolicy = enumValue(args, "approval_policy", ["untrusted", "on-request", "never"] as const);
    let deliveryVersion: 2 | 3 | undefined;
    if (args.delivery_action_tool !== undefined) {
      const boundary = asObject(args.delivery_action_tool, "delivery_action_tool");
      onlyKeys(boundary, ["version"]);
      if (Object.keys(boundary).length !== 1 || (boundary.version !== 2 && boundary.version !== 3)) {
        throw new Error("delivery_action_tool requires exact version 2 or 3");
      }
      deliveryVersion = boundary.version;
      if (sandbox !== (deliveryVersion === 2 ? "workspace-write" : "read-only") || approvalPolicy !== "never") {
        throw new Error(`delivery_action_tool v${deliveryVersion} requires exact sandbox and never approval policy`);
      }
    }
    await this.#validateExecutionOverrides(model, effort);
    const memoryRecall = await this.#autoRecall(text, requestedThreadId, cwd);
    const overrides = {
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
    };

    const threadResult = requestedThreadId
      ? await this.appServer.request("thread/resume", {
          threadId: requestedThreadId,
          ...overrides,
          ...(deliveryVersion ? { config: BOUNDED_TOOL_CONFIG } : {}),
        })
      : await this.appServer.request("thread/start", {
          ...overrides,
          ...(deliveryVersion ? { config: BOUNDED_TOOL_CONFIG,
            dynamicTools: [deliveryVersion === 2 ? DELIVERY_ACTION_DYNAMIC_TOOL : REVIEW_SOURCE_DYNAMIC_TOOL] } : {}),
          serviceName: "local-codex-bridge",
        });
    const threadMethod = requestedThreadId ? "thread/resume" : "thread/start";
    const threadId = extractThreadId(threadResult, threadMethod);
    if (requestedThreadId && threadId !== requestedThreadId) {
      throw new Error("thread/resume returned a different thread id");
    }
    const sandboxPolicy = sandbox
      ? extractSandboxPolicy(threadResult, threadMethod, sandbox)
      : undefined;
    const effectiveApprovalPolicy = approvalPolicy
      ? extractApprovalPolicy(threadResult, threadMethod, approvalPolicy)
      : undefined;
    this.appServer.runtime.ensureThread(threadId);
    const turnResult = await this.appServer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: memoryRecall.text, text_elements: [] }],
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(effectiveApprovalPolicy ? { approvalPolicy: effectiveApprovalPolicy } : {}),
    });
    const turnId = extractTurnId(turnResult, "turn/start");
    this.appServer.runtime.markTurnAccepted(threadId, turnId);
    if (readMemoryPolicy().writebackEnabled && cwd) {
      this.pendingMemoryWritebacks.set(turnId, {
        threadId,
        turnId,
        handle: new CompletedWriteback({ originalTask: text, cwd, client: this.#memoryPort() }),
      });
      const terminal = this.appServer.runtime.observe(threadId, undefined, 1)?.terminal;
      if (terminal?.turn_id === turnId) {
        this.#onTerminal({ threadId, terminal });
      }
    }
    const turn = asObject(turnResult, "turn/start result").turn as Record<string, unknown>;
    return {
      accepted: true,
      thread_id: threadId,
      turn_id: turnId,
      event_cursor: this.appServer.runtime.currentCursor(threadId),
      status: typeof turn.status === "string" ? turn.status : "inProgress",
      memory_recall: memoryRecall.acknowledgement,
      ...(deliveryVersion ? { delivery_boundary: deliveryVersion === 2
        ? "structured-effects-no-native-shell-v1" : "review-source-no-native-shell-v1" } : {}),
    };
  }

  async #goal(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["operation", "thread_id", "objective", "sandbox", "approval_policy"]);
    const operation = enumValue(args, "operation", ["set", "get", "clear", "reconnect"] as const);
    if (!operation) throw new Error("operation is required");
    const threadId = requiredString(args, "thread_id", 200);
    if (operation !== "set" && args.objective !== undefined) {
      throw new Error("objective is valid only for set");
    }
    if (operation !== "reconnect" && (args.sandbox !== undefined || args.approval_policy !== undefined)) {
      throw new Error("sandbox and approval_policy are valid only for reconnect");
    }
    if (operation === "set") {
      const objective = optionalString(args, "objective", 200_000);
      const prior = await this.goalStore.read(threadId);
      if (!objective) throw new Error("set requires objective");
      const read = responseRecord(await this.appServer.request("thread/read", { threadId, includeTurns: false }), "thread/read");
      if (asObject(read.thread, "thread/read thread").id !== threadId) throw new Error("thread/read returned a different thread id");
      const nativeSet = responseRecord(await this.appServer.request("thread/goal/set", { threadId, objective }), "thread/goal/set");
      const nativeGoal = asObject(nativeSet.goal, "thread/goal/set goal");
      if (nativeGoal.threadId !== threadId) throw new Error("thread/goal/set returned a different thread id");
      const changed = objective !== prior?.objective;
      const record: GoalRecord = { schema: "CodexBridgeGoal", version: 1, threadId,
        id: changed || !prior ? randomUUID() : prior.id,
        objective,
        objectiveDigest: goalDigest(objective),
        ...(typeof nativeGoal.id === "string" && nativeGoal.id.length > 0 ? { nativeGoalId: nativeGoal.id } : {}),
        status: changed ? "active" : prior!.status,
        initialTurnId: changed || !prior ? this.appServer.runtime.observe(threadId, undefined, 1)?.active_turn_id ?? null : prior.initialTurnId,
        reconnect: changed ? null : prior?.reconnect ?? null, nativeGoalImported: true };
      await this.goalStore.write(record);
      return { source: "codex_app_server", operation, goal: this.#goalProjection(record), reconnect_receipt: record.reconnect };
    }
    if (operation === "clear") {
      const prior = await this.goalStore.read(threadId);
      if (prior?.nativeGoalImported) await this.#clearImportedNativeGoal(threadId);
      await this.goalStore.clear(threadId);
      return { source: "codex_app_server", operation, thread_id: threadId, cleared: true };
    }
    const record = await this.#readGoalRecord(threadId);
    if (operation === "get") {
      if (record) await this.#syncNativeGoal(record);
      if (record) await this.#refreshGoalTerminal(record);
      const lifecycle = await this.#goalLifecycle(threadId, record);
      const nativeStatus = (lifecycle.native_goal as Record<string, unknown> | null)?.status;
      return { source: "codex_app_server", operation,
        goal: record ? { ...this.#goalProjection(record), ...(typeof nativeStatus === "string" ? { status: nativeStatus } : {}) } : null,
        reconnect_receipt: record?.reconnect ?? null, lifecycle };
    }
    if (!record) throw new Error("No durable goal for exact thread");
    const sandbox = enumValue(args, "sandbox", ["read-only", "workspace-write", "danger-full-access"] as const);
    const approvalPolicy = enumValue(args, "approval_policy", ["untrusted", "on-request", "never"] as const);
    const nativeStatus = await this.#syncNativeGoal(record);
    if (nativeStatus !== "active" && nativeStatus !== "complete") throw new Error("Native goal status does not permit reconnect");
    await this.#refreshGoalTerminal(record);
    if (record.reconnect) return this.#reconnectResponse(record);
    const unknown: ReconnectReceipt = { schema: "CodexGoalReconnectReceipt", version: 1,
      thread_id: threadId, goal_digest: record.objectiveDigest,
      goal_status: record.status, turn_id: null, status: "unknown" };
    if (!await this.goalStore.claim(record)) {
      const existing = await this.goalStore.read(threadId);
      if (existing?.id !== record.id) throw new Error("Goal changed during reconnect");
      if (!existing.reconnect) {
        existing.reconnect = unknown;
        await this.goalStore.write(existing);
      }
      return this.#reconnectResponse(existing);
    }
    record.reconnect = unknown;
    await this.goalStore.write(record);
    try {
      const runtime = this.appServer.runtime.observe(threadId, undefined, 1);
      if (record.status === "complete" && record.initialTurnId) {
        record.reconnect = { ...unknown, turn_id: record.initialTurnId, status: "terminal" };
      } else if (record.status === "complete" && runtime?.active_turn_id) {
        record.reconnect = { ...unknown, status: "terminal" };
      } else if (runtime?.active_turn_id) {
        record.reconnect = { ...unknown, turn_id: runtime.active_turn_id, status: "already_in_progress" };
      } else {
        const read = responseRecord(await this.appServer.request("thread/read", { threadId, includeTurns: true }), "thread/read");
        const thread = asObject(read.thread, "thread/read thread");
        if (thread.id !== threadId || !Array.isArray(thread.turns)) throw new Error("Exact native thread status is unavailable");
        const turns = thread.turns as unknown[];
        const last = turns.length ? asObject(turns.at(-1), "last native turn") : null;
        const lastId = typeof last?.id === "string" ? last.id : null;
        record.reconnect = { ...unknown, before_turn_id: lastId };
        await this.goalStore.write(record);
        if (record.status === "complete" && lastId && lastId === record.initialTurnId) {
          record.reconnect = { ...unknown, turn_id: lastId, status: "terminal" };
        } else if (record.status === "complete") {
          record.reconnect = { ...unknown, turn_id: record.initialTurnId ?? lastId, status: "terminal" };
        } else if (last && last.status === "inProgress") {
          // A persisted inProgress status cannot prove an active turn after runtime loss.
          record.reconnect = { ...unknown, turn_id: lastId };
        } else if (last && !["completed", "failed", "interrupted"].includes(String(last.status))) {
          record.reconnect = { ...unknown, turn_id: lastId };
        } else {
          const resumed = await this.appServer.request("thread/resume", { threadId, excludeTurns: true,
            ...(sandbox ? { sandbox } : {}), ...(approvalPolicy ? { approvalPolicy } : {}),
            ...(sandbox === "workspace-write" && approvalPolicy === "never" ? { config: BOUNDED_TOOL_CONFIG } : {}) });
          if (extractThreadId(resumed, "thread/resume") !== threadId) throw new Error("thread/resume returned a different thread id");
          if (sandbox) extractSandboxPolicy(resumed, "thread/resume", sandbox);
          if (approvalPolicy) extractApprovalPolicy(resumed, "thread/resume", approvalPolicy);
          const nativeTurn = (resumed as Record<string, unknown>).turn;
          const turnId = nativeTurn && typeof nativeTurn === "object" && !Array.isArray(nativeTurn)
            ? (nativeTurn as Record<string, unknown>).id : undefined;
          if (typeof turnId === "string" && turnId.length > 0 && turnId !== lastId) {
            record.reconnect = { ...record.reconnect, turn_id: turnId, status: "started" };
          }
        }
      }
    } catch {
      // The durable unknown claim prevents an automatic replay after any ambiguous native mutation.
    }
    await this.goalStore.write(record);
    return this.#reconnectResponse(record);
  }

  #goalProjection(record: GoalRecord): Record<string, unknown> {
    return { threadId: record.threadId, objective: record.objective, status: record.status,
      digest: record.objectiveDigest, ...(record.nativeGoalId ? { id: record.nativeGoalId } : {}) };
  }

  async #syncNativeGoal(record: GoalRecord): Promise<string> {
    const result = responseRecord(await this.appServer.request("thread/goal/get", { threadId: record.threadId }), "thread/goal/get");
    const goal = asObject(result.goal, "thread/goal/get goal");
    if (goal.threadId !== record.threadId) throw new Error("thread/goal/get returned a different thread id");
    if (goal.objective !== record.objective) throw new Error("Native goal objective differs from durable record");
    if (typeof goal.status !== "string") throw new Error("Native goal status is unavailable");
    if (typeof goal.id === "string" && goal.id.length > 0 && goal.id !== record.nativeGoalId) {
      record.nativeGoalId = goal.id;
      await this.goalStore.write(record);
    }
    if (goal.status === "complete" && record.status !== "complete") {
      record.status = "complete";
      await this.goalStore.write(record);
    }
    return goal.status;
  }

  async #goalLifecycle(threadId: string, record: GoalRecord | null): Promise<Record<string, unknown>> {
    const uncertainty: string[] = [];
    let nativeGoal: Record<string, unknown> | null = null;
    try {
      const result = responseRecord(await this.appServer.request("thread/goal/get", { threadId }), "thread/goal/get");
      if (result.goal !== null) {
        nativeGoal = asObject(result.goal, "thread/goal/get goal");
        if (nativeGoal.threadId !== threadId) throw new Error("thread/goal/get returned a different thread id");
      }
    } catch (error) {
      if (String(error).includes("different thread id")) throw error;
      uncertainty.push("native_goal_unavailable");
    }
    if (record && nativeGoal && (nativeGoal.objective !== record.objective || nativeGoal.status !== record.status)) {
      uncertainty.push("native_goal_differs_from_durable_record");
    }
    const runtime = this.appServer.runtime.observe(threadId, undefined, 1);
    let latestTurnId: string | null = null;
    let latestTurnStatus: string | null = null;
    try {
      const result = responseRecord(await this.appServer.request("thread/read", { threadId, includeTurns: true }), "thread/read");
      const thread = asObject(result.thread, "thread/read thread");
      if (thread.id !== threadId) throw new Error("thread/read returned a different thread id");
      if (!Array.isArray(thread.turns)) throw new Error("thread/read returned no native turns");
      const latest = thread.turns.length ? asObject(thread.turns.at(-1), "latest native turn") : null;
      if (latest && (typeof latest.id !== "string" || latest.id.length === 0)) throw new Error("latest native turn has no id");
      latestTurnId = latest ? latest.id as string : null;
      latestTurnStatus = latest && typeof latest.status === "string" ? latest.status : null;
    } catch (error) {
      if (String(error).includes("different thread id")) throw error;
      uncertainty.push("native_turn_history_unavailable");
    }
    const activeTurnId = runtime?.active_turn_id ?? null;
    if (!activeTurnId && latestTurnStatus === "inProgress") uncertainty.push("persisted_in_progress_is_not_live_proof");
    const receipt = record?.reconnect ?? null;
    let outcome = receipt?.status ?? "none";
    if (receipt?.status === "unknown") {
      // History identifies candidates, but cannot attribute a turn to a lost mutation acknowledgement.
      uncertainty.push("reconnect_outcome_not_proven");
      outcome = "unknown";
    }
    return { thread_id: threadId, native_goal: nativeGoal, goal_digest: nativeGoal && typeof nativeGoal.objective === "string"
      ? goalDigest(nativeGoal.objective) : record?.objectiveDigest ?? null,
      active_turn_id: activeTurnId, latest_turn_id: latestTurnId, latest_turn_status: latestTurnStatus,
      reconnect_outcome: outcome, reconnect_receipt: receipt,
      candidate_turn_id: receipt?.status === "unknown" && latestTurnId !== receipt.before_turn_id ? latestTurnId : null,
      uncertainty };
  }

  async #readGoalRecord(threadId: string): Promise<GoalRecord | null> {
    const stored = await this.goalStore.read(threadId);
    if (stored) return stored;
    if (await this.goalStore.isCleared(threadId)) return null;
    // Deployed LCB wrote native goals before this bridge-owned record existed.
    // Import only a proven exact-thread native goal; unsupported native methods leave no record.
    let native: unknown;
    try { native = await this.appServer.request("thread/goal/get", { threadId }); }
    catch { return null; }
    const result = responseRecord(native, "thread/goal/get");
    if (result.goal === null) return null;
    const goal = asObject(result.goal, "thread/goal/get goal");
    if (goal.threadId !== threadId) throw new Error("thread/goal/get returned a different thread id");
    if (typeof goal.objective !== "string" || goal.objective.trim().length === 0 || goal.objective.length > 200_000
      || (goal.status !== "active" && goal.status !== "complete")) throw new Error("Native goal cannot be bound to compatibility record");
    const record: GoalRecord = { schema: "CodexBridgeGoal", version: 1, threadId,
      id: randomUUID(), objective: goal.objective, objectiveDigest: goalDigest(goal.objective),
      ...(typeof goal.id === "string" && goal.id.length > 0 ? { nativeGoalId: goal.id } : {}),
      status: goal.status, initialTurnId: null, reconnect: null, nativeGoalImported: true };
    await this.goalStore.write(record);
    return record;
  }

  async #clearImportedNativeGoal(threadId: string): Promise<void> {
    const cleared = responseRecord(await this.appServer.request("thread/goal/clear", { threadId }), "thread/goal/clear");
    if (cleared.cleared !== true) throw new Error("Imported native goal clear was not confirmed");
  }

  async #refreshGoalTerminal(record: GoalRecord): Promise<void> {
    const boundTurnId = record.reconnect?.turn_id ?? record.initialTurnId;
    if (!boundTurnId || record.status !== "active") return;
    try {
      const read = responseRecord(await this.appServer.request("thread/read", { threadId: record.threadId, includeTurns: true }), "thread/read");
      const thread = asObject(read.thread, "thread/read thread");
      if (thread.id !== record.threadId || !Array.isArray(thread.turns)) return;
      const exact = thread.turns.find((item: unknown) => item !== null && typeof item === "object"
        && !Array.isArray(item) && (item as Record<string, unknown>).id === boundTurnId);
      if (exact && asObject(exact, "bound native turn").status === "completed") {
        record.status = "complete";
        await this.goalStore.write(record);
      }
    } catch { /* An unavailable native read cannot prove completion. */ }
  }

  #reconnectResponse(record: GoalRecord): Record<string, unknown> {
    return { source: "codex_app_server", operation: "reconnect", thread_id: record.threadId,
      resumed: record.reconnect?.status === "started" || record.reconnect?.status === "already_in_progress",
      receipt: record.reconnect };
  }

  async #observe(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    onlyKeys(args, ["thread_id", "cursor", "stream_id", "limit", "wait_ms"]);
    const threadId = requiredString(args, "thread_id", 200);
    const cursor = optionalInteger(args, "cursor", 0, Number.MAX_SAFE_INTEGER);
    const streamId = optionalString(args, "stream_id", 200);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 50;
    const waitMs = optionalInteger(args, "wait_ms", 0, MAX_OBSERVE_WAIT_MS) ?? 0;
    const runtime = waitMs === 0
      ? this.appServer.runtime.observe(threadId, cursor, limit, streamId)
      : await this.appServer.runtime.observeWithWait(threadId, cursor, limit, waitMs, signal, streamId);
    throwIfAborted(signal);
    if (runtime) {
      return runtime;
    }
    throwIfAborted(signal);
    const result = await this.appServer.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    throwIfAborted(signal);
    return sanitizeForTransport({
      runtime_available: false,
      live_state_reconstructable: false,
      note: "This Bridge process has no in-memory runtime for the thread. Live event ring and pending requests cannot be reconstructed after process loss.",
      runtime_status: "not_reconstructable",
      active_turn_id: null,
      stream_id: null,
      requested_stream_id: streamId ?? null,
      stream_changed: streamId !== undefined,
      events: [],
      next_cursor: 0,
      current_cursor: 0,
      cursor_floor: 0,
      cursor_lost: false,
      has_more: false,
      pending_requests: [],
      terminal: storedTerminal(result),
      semantic_progress: null,
      semantic_progress_reconstructable: false,
      stored_thread: responseRecord(result, "thread/read").thread,
      source: "codex_app_server_thread_read",
    });
  }

  async #steer(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "expected_turn_id", "text"]);
    const threadId = requiredString(args, "thread_id", 200);
    const expectedTurnId = requiredString(args, "expected_turn_id", 200);
    const text = requiredString(args, "text");
    const result = responseRecord(
      await this.appServer.request("turn/steer", {
        threadId,
        expectedTurnId,
        input: [{ type: "text", text, text_elements: [] }],
      }),
      "turn/steer",
    );
    if (typeof result.turnId !== "string" || result.turnId.length === 0) {
      throw new Error("turn/steer returned no turn id");
    }
    if (result.turnId !== expectedTurnId) {
      throw new Error("turn/steer returned a different turn id");
    }
    return { accepted: true, thread_id: threadId, turn_id: result.turnId };
  }

  async #respond(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, [
      "request_id",
      "thread_id",
      "turn_id",
      "method",
      "decision",
      "execpolicy_amendment",
      "answers",
      "permissions",
      "scope",
      "response",
    ]);
    const requestIdValue = args.request_id;
    if (
      !(
        (typeof requestIdValue === "string" && requestIdValue.length > 0) ||
        (typeof requestIdValue === "number" && Number.isInteger(requestIdValue))
      )
    ) {
      throw new Error("request_id must preserve the original non-empty string or integer id");
    }
    const requestId = requestIdValue as RpcId;
    const threadId = requiredString(args, "thread_id", 200);
    const turnId = optionalString(args, "turn_id", 200);
    const method = requiredString(args, "method", 300);
    if (!SUPPORTED_RESPOND_METHODS.has(method)) {
      throw new Error(`Unsupported app-server request method: ${method}; pending request remains observable`);
    }
    const decision = enumValue(args, "decision", ["accept", "acceptForSession", "decline", "cancel"] as const);
    const amendment = args.execpolicy_amendment;
    const answers = args.answers;
    const permissions = args.permissions;
    const scope = enumValue(args, "scope", ["turn", "session"] as const);
    const generic = args.response;

    let response: Record<string, unknown> | undefined;
    if (method === "item/permissions/requestApproval") {
      if (permissions === undefined) {
        throw new Error("item/permissions/requestApproval requires permissions");
      }
      if (
        decision !== undefined ||
        amendment !== undefined ||
        answers !== undefined ||
        generic !== undefined
      ) {
        throw new Error("item/permissions/requestApproval accepts only permissions and optional scope");
      }
      response = {
        permissions: asObject(permissions, "permissions"),
        ...(scope ? { scope } : {}),
      };
    } else {
      if (permissions !== undefined || scope !== undefined) {
        throw new Error("permissions and scope are valid only for item/permissions/requestApproval");
      }
      const supplied = [
        decision !== undefined,
        amendment !== undefined,
        answers !== undefined,
        generic !== undefined,
      ].filter(Boolean).length;
      if (supplied !== 1) {
        throw new Error("Provide exactly one of decision, execpolicy_amendment, answers, or response");
      }
    }

    if (method === "item/permissions/requestApproval") {
      // The exact stable response object was constructed above.
    } else if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval"
    ) {
      if (amendment !== undefined) {
        if (method !== "item/commandExecution/requestApproval" && method !== "execCommandApproval") {
          throw new Error("execpolicy_amendment is valid only for command approval");
        }
        if (!Array.isArray(amendment) || amendment.length === 0 || amendment.some((item) => typeof item !== "string")) {
          throw new Error("execpolicy_amendment must be a non-empty string array");
        }
        response = method === "execCommandApproval"
          ? {
              decision: {
                approved_execpolicy_amendment: {
                  proposed_execpolicy_amendment: amendment,
                },
              },
            }
          : {
              decision: {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: amendment,
                },
              },
            };
      } else if (decision) {
        if (method === "execCommandApproval" || method === "applyPatchApproval") {
          const legacyDecision = decision === "accept"
            ? "approved"
            : decision === "acceptForSession"
              ? "approved_for_session"
              : decision === "cancel"
                ? "abort"
                : { denied: { rejection: "declined by MCP client" } };
          response = { decision: legacyDecision };
        } else {
          response = { decision };
        }
      } else {
        throw new Error("Approval requests require decision or execpolicy_amendment");
      }
    } else if (method === "item/tool/requestUserInput") {
      response = answers !== undefined ? { answers: asObject(answers, "answers") } : asObject(generic, "response");
    } else {
      if (generic === undefined) {
        throw new Error("This request method requires a generic response object");
      }
      response = asObject(generic, "response");
    }
    if (!response) {
      throw new Error(`No response contract was constructed for ${method}`);
    }

    const pending = this.appServer.runtime.claimPending(requestId, {
      threadId,
      method,
      ...(turnId ? { turnId } : {}),
    });
    if (pending.turnId && !turnId) {
      this.appServer.runtime.releasePending(pending);
      throw new Error("turn_id is required for this pending request");
    }
    try {
      await this.appServer.respond(requestId, response);
    } catch (error) {
      this.appServer.runtime.releasePending(pending);
      throw error;
    }
    this.appServer.runtime.completePending(pending);
    return {
      responded: true,
      acknowledgement: "accepted",
      resolution: "submitted",
      worker: "codex",
      request_id: requestId,
      thread_id: threadId,
      turn_id: pending.turnId ?? null,
      method,
    };
  }

  async #interrupt(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "turn_id"]);
    const threadId = requiredString(args, "thread_id", 200);
    const turnId = requiredString(args, "turn_id", 200);
    await this.appServer.request("turn/interrupt", { threadId, turnId });
    return { interrupted: true, thread_id: threadId, turn_id: turnId };
  }
}
