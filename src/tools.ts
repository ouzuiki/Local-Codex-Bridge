import { AppServerManager } from "./app-server.js";
import { realpath, stat } from "node:fs/promises";
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
  persistedFinalResult,
  sanitizeForTransport,
  type TerminalNotification,
  type RpcId,
} from "./runtime.js";
import { platformPolicyFor, type PlatformPolicy } from "./platform.js";
import type { MemoryCoreClient } from "./memory-core-client.js";
import { MAX_EXACT_RESULT_BYTES, NATIVE_GROUPS, nativeCall, nativeInputSchema } from "./native.js";

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

export const SUPPORTED_RESPOND_METHODS: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/tool/requestUserInput",
  "item/tool/call",
  "mcpServer/elicitation/request",
]);

const MODEL_LIST_PAGE_LIMIT = 100;
const MAX_MODEL_CATALOG_PAGES = 100;
const MAX_MODEL_CATALOG_ENTRIES = 10_000;
const MAX_RATE_LIMIT_ENTRIES = 100;
const MAX_RESET_CREDIT_ENTRIES = 20;
const MAX_NATIVE_INPUT_ITEMS = 100;

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
  ...(["codex_native_read", "codex_native_action", "codex_experimental_read", "codex_experimental_action"] as const).map((name) => ({
    name,
    title: name.replaceAll("_", " "),
    description: `Bounded ${name.includes("experimental") ? "experimental" : "stable"} native app-server ${name.endsWith("read") ? "read" : "action"} allowlist. Uses exact native method names and parameters. Results report delivery.lossless; false means the bounded projection redacted or truncated native content.${name.endsWith("read") ? ` Optional delivery:"exact" returns the unaltered native result or fails whole with exact_delivery_failed (content_policy, structure, or size; ${MAX_EXACT_RESULT_BYTES} result-body bytes); it never returns partial data or redacted text.` : ""}`,
    inputSchema: nativeInputSchema(name),
    annotations: { title: name, readOnlyHint: name.endsWith("read"), destructiveHint: name.endsWith("action"), idempotentHint: name.endsWith("read"), openWorldHint: false },
  })),
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
    description: "Native Codex Goal is authoritative. Reconnect keeps only an idempotent receipt for an exact native thread/resume attempt; UNKNOWN is never replayed.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["set", "get", "clear", "reconnect"] },
        thread_id: { type: "string", minLength: 1, maxLength: 200 },
        objective: { anyOf: [{ type: "string", minLength: 1, maxLength: 200000 }, { type: "null" }] },
        status: { anyOf: [{ type: "string", enum: ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"] }, { type: "null" }] },
        token_budget: { type: ["integer", "null"], minimum: 0 },
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
    name: "codex_thread_lifecycle",
    title: "Native Thread Lifecycle",
    description: "Fork or compact an exact native thread, returning native acknowledgement and identity.",
    inputSchema: { type: "object", properties: {
      operation: { type: "string", enum: ["fork", "compact"] },
      thread_id: { type: "string", minLength: 1, maxLength: 200 },
    }, required: ["operation", "thread_id"], additionalProperties: false },
    annotations: { title: "Native Thread Lifecycle", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "codex_thread_start",
    title: "Start Native Codex Thread",
    description: "Start one persistent native thread without a turn; return its exact native ID.",
    inputSchema: { type: "object", properties: {
      cwd: { type: "string", minLength: 1, maxLength: 1000 },
      model: { type: "string", minLength: 1, maxLength: 100 },
      sandbox: sandboxSchema, approval_policy: approvalPolicySchema,
    }, required: ["cwd"], additionalProperties: false },
    annotations: { title: "Start Native Codex Thread", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "codex_turn_start",
    title: "Start Native Codex Turn",
    description: "Start one turn on an exact existing idle native thread without resuming or creating a thread.",
    inputSchema: { type: "object", properties: {
      thread_id: { type: "string", minLength: 1, maxLength: 200 },
      text: { type: "string", minLength: 1, maxLength: 200000 },
      input: { type: "array", minItems: 1, maxItems: MAX_NATIVE_INPUT_ITEMS, items: { type: "object", additionalProperties: true } },
      model: { type: "string", minLength: 1, maxLength: 100 },
      effort: { type: "string", minLength: 1, maxLength: 32 },
      output_schema: { type: "object", additionalProperties: true },
      turn_trigger: { type: "string", minLength: 1, maxLength: 200 },
    }, required: ["thread_id"], oneOf: [{ required: ["text"] }, { required: ["input"] }], additionalProperties: false },
    annotations: { title: "Start Native Codex Turn", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "codex_turn",
    title: "Start or Continue Codex Turn",
    description:
      "Start or resume a native thread and start one turn with text or bounded native UserInput. A model identifier is checked against a fresh model/list page sequence; reasoning effort compatibility is decided by native Codex. Returns native acceptance, not completion. Ambiguous mutating acknowledgements are UNKNOWN and are never retried automatically.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 200000,
          description: "User text passed directly to Codex as one text input item.",
        },
        input: { type: "array", minItems: 1, maxItems: MAX_NATIVE_INPUT_ITEMS, items: { type: "object", additionalProperties: true }, description: "Native UserInput items: text, image, localImage, audio, localAudio, skill, or mention." },
        output_schema: { type: "object", additionalProperties: true },
        turn_trigger: { type: "string", minLength: 1, maxLength: 200 },
        native_turn_options: { type: "object", additionalProperties: true, description: "Optional turn/start fields: clientUserMessageId, disabledPluginIds, personality, serviceTier, serviceTierForTurn, summary, multiAgentMode. Unavailable with delivery_action_tool. permissions, environments, runtimeWorkspaceRoots, collaborationMode, toolOutput, and additionalContext are unsupported here." },
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
          description: "Optional native reasoning effort token; app-server validates compatibility.",
        },
        sandbox: sandboxSchema,
        approval_policy: approvalPolicySchema,
        delivery_action_tool: { type: "object", properties: { version: { type: "integer", enum: [2, 3] } }, required: ["version"], additionalProperties: false },
      },
      oneOf: [{ required: ["text"] }, { required: ["input"] }],
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
      "Read bounded incremental sanitized Bridge runtime events, live semantic progress, pending requests, and terminal output for a thread. Optional wait_ms performs one bounded event-driven wait only when the live turn is active and the current snapshot has nothing useful; it is not polling or stall detection. After Bridge process loss, falls back to persistent thread/read history and marks live state and semantic progress unreconstructable. A terminal status is not full delivery: terminal.final_result_pending is true until next_cursor reaches the terminal event, so continue with next_cursor until it is false. terminal.final_result_meta.complete is false when final_result is truncated or partial (for example streamed-only or interrupted text), and redacted marks masked secrets; read the persisted turn through codex_native_read with delivery exact when complete content is needed. A long interval with no new command or output can still mean Codex is actively reasoning; absence of new command activity alone is not evidence of a stall. Normal supervision lets the authorized turn run autonomously and observes for pending requests or completion. Steer only for a concrete semantic correction or changed intent, and interrupt only for explicit cancellation or an exceptional safety/recovery need.",
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
      "Exceptional control: append text or bounded native UserInput to the exact active turn using turn/steer with an expected turn-ID precondition. Use for a semantic correction or changed intent. Ambiguous acknowledgement is UNKNOWN and is never retried automatically.",
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
        input: { type: "array", minItems: 1, maxItems: MAX_NATIVE_INPUT_ITEMS, items: { type: "object", additionalProperties: true }, description: "Native UserInput variants for the active turn." },
        client_user_message_id: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["thread_id", "expected_turn_id"],
      oneOf: [{ required: ["text"] }, { required: ["input"] }],
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
      "Answer one currently pending app-server request by its raw JSON-RPC id and exact thread/method/turn scope, including dynamic tool calls and MCP elicitations. Unknown methods remain pending.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          oneOf: [{ type: "string", minLength: 1 }, { type: "integer" }],
          description: "Original app-server JSON-RPC request id, preserving string or integer type.",
        },
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact pending-request thread scope." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact turn scope when the pending request has one." },
        method: { type: "string", minLength: 1, maxLength: 300, description: `Exact app-server request method. Supported: ${[...SUPPORTED_RESPOND_METHODS].join(", ")}. Other methods are rejected and remain pending and observable.` },
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
          description: "Bounded native response object for user input, dynamic tool call, or MCP elicitation.",
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

function boundedObject(value: unknown, label: string, maxChars = 100_000): Record<string, unknown> {
  const object = asObject(value, label);
  if (JSON.stringify(object).length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  return object;
}

function nativeTurnInput(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_NATIVE_INPUT_ITEMS || JSON.stringify(value).length > 500_000) {
    throw new Error("input must be 1..100 bounded native UserInput items");
  }
  return value.map((raw, index) => {
    const item = boundedObject(raw, `input[${index}]`, 210_000);
    const type = requiredString(item, "type", 32);
    const fields: Record<string, string[]> = {
      text: ["type", "text", "text_elements"], image: ["type", "url", "fileId", "detail"],
      localImage: ["type", "path", "detail"], audio: ["type", "url"],
      localAudio: ["type", "path"], skill: ["type", "name", "path"], mention: ["type", "name", "path"],
    };
    if (!fields[type]) throw new Error(`input[${index}] has unsupported type`);
    onlyKeys(item, fields[type]);
    if (type === "image" && (item.url === undefined) === (item.fileId === undefined)) throw new Error("image requires exactly one of url or fileId");
    for (const key of type === "text" ? ["text"] : type === "image" ? [item.url === undefined ? "fileId" : "url"] : type === "audio" ? ["url"] : type === "localImage" || type === "localAudio" ? ["path"] : ["name", "path"]) {
      requiredString(item, key, key === "path" ? 1_000 : 200_000);
    }
    if (item.detail !== undefined && item.detail !== null && !["auto", "low", "high", "original"].includes(String(item.detail))) throw new Error("detail must be a native ImageDetail or null");
    if (item.text_elements !== undefined && (!Array.isArray(item.text_elements) || item.text_elements.length > 100)) throw new Error("text_elements exceeds bound");
    return item;
  });
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
  // Final text uses the live 48k bound and completeness metadata instead of
  // the generic sanitizer's silent 12k string cut.
  return {
    ...(sanitizeForTransport({ turn_id: turn.id, status, completed_at: null }) as Record<string, unknown>),
    ...persistedFinalResult(finalResult),
    final_result_pending: false,
    error: sanitizeForTransport(turn.error ?? null),
    source: "codex_app_server_thread_read",
  };
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
      case "codex_native_read":
      case "codex_native_action":
      case "codex_experimental_read":
      case "codex_experimental_action":
        return await nativeCall(this.appServer, this.platformPolicy, name, args);
      case "codex_threads":
        return await this.#threads(args);
      case "codex_models":
        return await this.#models(args);
      case "codex_rate_limits":
        return await this.#rateLimits(args);
      case "codex_thread_start":
        return await this.#threadStart(args);
      case "codex_thread_lifecycle":
        return await this.#threadLifecycle(args);
      case "codex_turn_start":
        return await this.#turnStart(args);
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
    if (!model) {
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
      return;
    }
  }

  async #threadLifecycle(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["operation", "thread_id"]);
    const operation = enumValue(args, "operation", ["fork", "compact"] as const);
    if (!operation) throw new Error("operation is required");
    const threadId = requiredString(args, "thread_id", 200);
    const method = operation === "fork" ? "thread/fork" : "thread/compact/start";
    const result = responseRecord(await this.appServer.request(method, { threadId }), method);
    if (operation === "compact") return { accepted: true, operation, thread_id: threadId, result: sanitizeForTransport(result) };
    const forkId = extractThreadId(result, method);
    if (forkId === threadId) throw new Error("thread/fork returned source ID; outcome requires reconciliation");
    this.appServer.runtime.ensureThread(forkId);
    return { accepted: true, operation, source_thread_id: threadId, thread_id: forkId, result: sanitizeForTransport(result) };
  }

  async #threadStart(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["cwd", "model", "sandbox", "approval_policy"]);
    const cwd = this.#cwd(args);
    if (!cwd) throw new Error("cwd is required");
    if (!(await stat(cwd)).isDirectory() || await realpath(cwd) !== cwd) throw new Error("cwd must be an existing canonical directory");
    const model = optionalString(args, "model", 100);
    const sandbox = enumValue(args, "sandbox", ["read-only", "workspace-write", "danger-full-access"] as const);
    const approvalPolicy = enumValue(args, "approval_policy", ["untrusted", "on-request", "never"] as const);
    await this.#validateExecutionOverrides(model, undefined);
    const result = await this.appServer.request("thread/start", { cwd, ephemeral: false,
      ...(model ? { model } : {}), ...(sandbox ? { sandbox } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}), serviceName: "local-codex-bridge" });
    const threadId = extractThreadId(result, "thread/start");
    const thread = asObject(asObject(result, "thread/start result").thread, "thread/start thread");
    if (thread.cwd !== cwd || thread.ephemeral === true) throw new Error("thread/start returned an unexpected workspace or ephemeral thread; outcome requires reconciliation");
    this.appServer.runtime.ensureThread(threadId);
    return { accepted: true, thread_id: threadId, cwd, result: sanitizeForTransport(result) };
  }

  async #turnStart(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "text", "input", "model", "effort", "output_schema", "turn_trigger"]);
    const threadId = requiredString(args, "thread_id", 200);
    if ((args.text === undefined) === (args.input === undefined)) throw new Error("Provide exactly one of text or input");
    const input = args.input === undefined ? [{ type: "text", text: requiredString(args, "text"), text_elements: [] }] : nativeTurnInput(args.input);
    const model = optionalString(args, "model", 100);
    const effort = optionalString(args, "effort", 32);
    const outputSchema = args.output_schema === undefined ? undefined : boundedObject(args.output_schema, "output_schema");
    const turnTrigger = optionalString(args, "turn_trigger", 200);
    await this.#validateExecutionOverrides(model, effort);
    let live = this.appServer.runtime.observe(threadId, undefined, 1);
    if (!live) {
      const read = responseRecord(await this.appServer.request("thread/read", { threadId, includeTurns: false }), "thread/read");
      const thread = asObject(read.thread, "thread/read thread");
      const status = asObject(thread.status, "thread/read thread.status");
      if (thread.id !== threadId || thread.ephemeral !== false || !["idle", "notLoaded"].includes(String(status.type))) {
        throw new Error("Exact persistent idle thread is unavailable");
      }
      this.appServer.runtime.ensureThread(threadId);
      live = this.appServer.runtime.observe(threadId, undefined, 1);
    }
    if (!live || live.active_turn_id || !["idle", "completed"].includes(live.runtime_status)) throw new Error("Native thread is not known idle");
    const result = await this.appServer.request("turn/start", { threadId, input,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      ...(outputSchema ? { outputSchema } : {}), ...(turnTrigger ? { turnTrigger } : {}) });
    const turnId = extractTurnId(result, "turn/start");
    this.appServer.runtime.markTurnAccepted(threadId, turnId);
    return { accepted: true, thread_id: threadId, turn_id: turnId,
      event_cursor: this.appServer.runtime.currentCursor(threadId), result: sanitizeForTransport(result) };
  }

  async #turn(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["text", "input", "thread_id", "cwd", "model", "effort", "sandbox", "approval_policy", "delivery_action_tool", "output_schema", "turn_trigger", "native_turn_options"]);
    if ((args.text === undefined) === (args.input === undefined)) throw new Error("Provide exactly one of text or input");
    const text = args.text === undefined ? undefined : requiredString(args, "text");
    const structuredInput = args.input === undefined ? undefined : nativeTurnInput(args.input);
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
    const outputSchema = args.output_schema === undefined ? undefined : boundedObject(args.output_schema, "output_schema");
    const turnTrigger = optionalString(args, "turn_trigger", 200);
    const nativeTurnOptions = args.native_turn_options === undefined ? {} : boundedObject(args.native_turn_options, "native_turn_options", 20_000);
    onlyKeys(nativeTurnOptions, ["clientUserMessageId", "disabledPluginIds", "personality", "serviceTier", "serviceTierForTurn", "summary", "multiAgentMode"]);
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
      if (Object.keys(nativeTurnOptions).length !== 0) throw new Error("delivery_action_tool does not allow native_turn_options");
    }
    await this.#validateExecutionOverrides(model, effort);
    const memoryRecall = text ? await this.#autoRecall(text, requestedThreadId, cwd) : { text: "", acknowledgement: { status: "disabled" } as RecallAcknowledgement };
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
      input: structuredInput ?? [{ type: "text", text: memoryRecall.text, text_elements: [] }],
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(effectiveApprovalPolicy ? { approvalPolicy: effectiveApprovalPolicy } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      ...(turnTrigger ? { turnTrigger } : {}),
      ...nativeTurnOptions,
    });
    const turnId = extractTurnId(turnResult, "turn/start");
    this.appServer.runtime.markTurnAccepted(threadId, turnId);
    if (readMemoryPolicy().writebackEnabled && cwd && text) {
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
    onlyKeys(args, ["operation", "thread_id", "objective", "status", "token_budget", "sandbox", "approval_policy"]);
    const operation = enumValue(args, "operation", ["set", "get", "clear", "reconnect"] as const);
    if (!operation) throw new Error("operation is required");
    const threadId = requiredString(args, "thread_id", 200);
    if (operation === "set") {
      const objective = args.objective === null ? null : optionalString(args, "objective", 200_000);
      const status = args.status === null ? null : enumValue(args, "status", ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const);
      const tokenBudget = args.token_budget;
      if (tokenBudget !== undefined && tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || (tokenBudget as number) < 0)) throw new Error("token_budget must be a non-negative safe integer or null");
      const result = responseRecord(await this.appServer.request("thread/goal/set", {
        threadId, ...(objective !== undefined ? { objective } : {}), ...(status !== undefined ? { status } : {}), ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      }), "thread/goal/set");
      const nativeGoal = asObject(result.goal, "thread/goal/set goal");
      if (nativeGoal.threadId !== threadId) throw new Error("Native goal thread identity mismatch");
      try { await this.goalStore.clear(threadId); } catch { /* Native Goal acknowledgement remains authoritative. */ }
      return { source: "codex_app_server", operation, goal: sanitizeForTransport(nativeGoal), reconnect_receipt: null };
    }
    if (operation === "clear") {
      const result = responseRecord(await this.appServer.request("thread/goal/clear", { threadId }), "thread/goal/clear");
      try { await this.goalStore.clear(threadId); } catch { /* Native Goal acknowledgement remains authoritative. */ }
      return { source: "codex_app_server", operation, thread_id: threadId, result: sanitizeForTransport(result) };
    }
    if (args.objective !== undefined || args.status !== undefined || args.token_budget !== undefined) throw new Error("Goal mutation fields are valid only for set");
    const read = responseRecord(await this.appServer.request("thread/goal/get", { threadId }), "thread/goal/get");
    const nativeGoal = read.goal === null || read.goal === undefined ? null : asObject(read.goal, "thread/goal/get goal");
    if (nativeGoal && nativeGoal.threadId !== threadId) throw new Error("Native goal thread identity mismatch");
    if (operation === "get") {
      return { source: "codex_app_server", operation, goal: sanitizeForTransport(nativeGoal),
        reconnect_receipt: nativeGoal ? (await this.#matchingReconnectReceipt(threadId, nativeGoal)) : null };
    }
    if (!nativeGoal || typeof nativeGoal.objective !== "string") throw new Error("No native goal for exact thread");
    if (!["active", "complete"].includes(String(nativeGoal.status))) throw new Error("Native goal status does not permit reconnect");
    const sandbox = enumValue(args, "sandbox", ["read-only", "workspace-write", "danger-full-access"] as const);
    const approvalPolicy = enumValue(args, "approval_policy", ["untrusted", "on-request", "never"] as const);
    const digest = goalDigest(nativeGoal.objective);
    if (!Number.isSafeInteger(nativeGoal.createdAt) || (nativeGoal.createdAt as number) < 0) {
      throw new Error("Native goal has no usable createdAt instance identity");
    }
    const createdAt = nativeGoal.createdAt as number;
    const prior = await this.goalStore.read(threadId);
    const same = prior?.objectiveDigest === digest && prior.nativeGoalCreatedAt === createdAt;
    if (same && prior?.reconnect) return { source: "codex_app_server", operation, goal: sanitizeForTransport(nativeGoal), reconnect_receipt: prior.reconnect };
    const record: GoalRecord = { schema: "CodexReconnectBinding", version: 3, threadId,
      id: goalDigest(JSON.stringify([threadId, digest, createdAt])).slice(7), objectiveDigest: digest,
      nativeGoalCreatedAt: createdAt,
      reconnect: null };
    await this.goalStore.write(record);
    const unknown: ReconnectReceipt = { schema: "CodexGoalReconnectReceipt", version: 1,
      thread_id: threadId, goal_digest: digest, goal_status: nativeGoal.status === "complete" ? "complete" : "active", turn_id: null, status: "unknown" };
    if (!await this.goalStore.claim(record)) {
      const latest = await this.goalStore.read(threadId);
      return { source: "codex_app_server", operation, goal: sanitizeForTransport(nativeGoal),
        reconnect_receipt: latest?.objectiveDigest === digest && latest.nativeGoalCreatedAt === createdAt
          ? latest.reconnect ?? unknown : unknown };
    }
    record.reconnect = unknown;
    await this.goalStore.write(record);
    try {
      const runtime = this.appServer.runtime.observe(threadId, undefined, 1);
      if (runtime?.active_turn_id) record.reconnect = { ...unknown, turn_id: runtime.active_turn_id, status: "already_in_progress" };
      else if (nativeGoal.status === "complete") record.reconnect = { ...unknown, status: "terminal" };
      else {
        const resumed = await this.appServer.request("thread/resume", { threadId, excludeTurns: true,
          ...(sandbox ? { sandbox } : {}), ...(approvalPolicy ? { approvalPolicy } : {}) });
        if (extractThreadId(resumed, "thread/resume") !== threadId) throw new Error("thread/resume returned a different native id");
        const nativeTurn = (resumed as Record<string, unknown>).turn;
        const turnId = nativeTurn && typeof nativeTurn === "object" && !Array.isArray(nativeTurn)
          ? (nativeTurn as Record<string, unknown>).id : undefined;
        if (typeof turnId === "string") record.reconnect = { ...unknown, turn_id: turnId, status: "started" };
      }
    } catch {
      // A durable UNKNOWN claim prevents replay after an ambiguous native mutation.
    }
    await this.goalStore.write(record);
    return { source: "codex_app_server", operation, goal: sanitizeForTransport(nativeGoal), reconnect_receipt: record.reconnect };
  }

  async #matchingReconnectReceipt(threadId: string, nativeGoal: Record<string, unknown>): Promise<ReconnectReceipt | null> {
    let record: GoalRecord | null;
    try { record = await this.goalStore.read(threadId); }
    catch { return null; }
    return record && record.threadId === threadId && typeof nativeGoal.objective === "string"
      && Number.isSafeInteger(nativeGoal.createdAt) && (nativeGoal.createdAt as number) >= 0
      && record.objectiveDigest === goalDigest(nativeGoal.objective)
      && record.nativeGoalCreatedAt === nativeGoal.createdAt ? record.reconnect : null;
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
    const degraded = sanitizeForTransport({
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
      terminal: null,
      semantic_progress: null,
      semantic_progress_reconstructable: false,
      stored_thread: responseRecord(result, "thread/read").thread,
      source: "codex_app_server_thread_read",
    }) as Record<string, unknown>;
    // Assigned after the generic sanitizer so its bounded final is not re-cut.
    degraded.terminal = storedTerminal(result);
    return degraded;
  }

  async #steer(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "expected_turn_id", "text", "input", "client_user_message_id"]);
    const threadId = requiredString(args, "thread_id", 200);
    const expectedTurnId = requiredString(args, "expected_turn_id", 200);
    if ((args.text === undefined) === (args.input === undefined)) throw new Error("Provide exactly one of text or input");
    const input = args.input === undefined ? [{ type: "text", text: requiredString(args, "text"), text_elements: [] }] : nativeTurnInput(args.input);
    const clientUserMessageId = optionalString(args, "client_user_message_id", 200);
    const result = responseRecord(
      await this.appServer.request("turn/steer", {
        threadId,
        expectedTurnId,
        input,
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
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
    } else if (method === "item/tool/call") {
      if (decision !== undefined || amendment !== undefined || answers !== undefined || generic === undefined) throw new Error("Dynamic tool call requires response only");
      const value = boundedObject(generic, "response", 200_000);
      onlyKeys(value, ["contentItems", "success"]);
      if (typeof value.success !== "boolean" || !Array.isArray(value.contentItems) || value.contentItems.length > 100) throw new Error("Dynamic tool response requires bounded contentItems and success");
      for (const raw of value.contentItems) {
        const item = boundedObject(raw, "content item", 100_000);
        const type = enumValue(item, "type", ["inputText", "inputImage", "inputAudio"] as const);
        if (!type) throw new Error("Dynamic tool content type is required");
        const field = type === "inputText" ? "text" : type === "inputImage" ? "imageUrl" : "audioUrl";
        onlyKeys(item, ["type", field]);
        requiredString(item, field, 100_000);
      }
      response = value;
    } else if (method === "mcpServer/elicitation/request") {
      if (decision !== undefined || amendment !== undefined || answers !== undefined || generic === undefined) throw new Error("MCP elicitation requires response only");
      const value = boundedObject(generic, "response", 100_000);
      onlyKeys(value, ["action", "content"]);
      const action = enumValue(value, "action", ["accept", "decline", "cancel"] as const);
      if (!action || (action !== "accept" && value.content !== undefined && value.content !== null)) throw new Error("Invalid MCP elicitation action/content");
      response = value;
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
      throw new Error(`App-server response write for ${method} has UNKNOWN outcome; the pending request remains observable and must be reconciled before any retry: ${error instanceof Error ? error.message : String(error)}`);
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
