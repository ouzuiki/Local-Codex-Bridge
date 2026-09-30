import type { AppServerManager } from "./app-server.js";
import { isSecretKey, redactText, sanitizeForTransport } from "./runtime.js";
import type { PlatformPolicy } from "./platform.js";

type FieldKind = "id" | "nullableId" | "text" | "cursor" | "cwd" | "cwdFilter" | "count" | "boolean" | "nullableBoolean" | "ids" | "strings" | "cwds" | "input" | "rawItems" | "object" | "reviewer" | "approval" | "sandbox" | "direction" | "itemsView" | "multiAgent" | "reviewTarget" | "gitInfo" | "appearance" | "jsonValue" | "featureMap" | "inline";
type NativeSpec = { fields: Record<string, FieldKind>; required?: readonly string[] };
const threadId = { threadId: "id" } as const;
const page = { cursor: "cursor", limit: "count" } as const;
const reviewerFields = { approvalPolicy: "approval", approvalsReviewer: "reviewer", sandbox: "sandbox" } as const;

const STABLE_READ: Record<string, NativeSpec> = {
  "thread/list": { fields: { ...page, cwd: "cwdFilter", searchTerm: "text", archived: "nullableBoolean", sortDirection: "direction", sortKey: "text", modelProviders: "strings", originators: "strings", sectionId: "nullableId", sourceKinds: "strings", useStateDbOnly: "boolean" } },
  "thread/read": { fields: { ...threadId, includeTurns: "boolean" }, required: ["threadId"] },
  "thread/turns/list": { fields: { ...threadId, ...page, sortDirection: "direction", itemsView: "itemsView" }, required: ["threadId"] },
  "thread/items/list": { fields: { ...threadId, turnId: "id", ...page, sortDirection: "direction" }, required: ["threadId"] },
  "thread/loaded/list": { fields: { ...page } },
  "thread/attachment/list": { fields: { ...threadId, ...page }, required: ["threadId"] },
  "threadSection/list": { fields: { ...page } },
  "hooks/list": { fields: { cwds: "cwds" } },
  "skills/list": { fields: { cwds: "cwds" } },
  "config/read": { fields: { cwd: "cwd", includeLayers: "boolean" } },
  "configRequirements/read": { fields: {} },
  "account/read": { fields: {} },
  "account/usage/read": { fields: {} },
  "account/workspaceMessages/read": { fields: {} },
  "modelProvider/capabilities/read": { fields: {} },
  "experimentalFeature/list": { fields: { ...page, ...threadId } },
  "permissionProfile/list": { fields: { ...page, cwd: "cwd" } },
  "mcpServerStatus/list": { fields: { ...page, ...threadId } },
  "plugin/list": { fields: { cwds: "cwds" } },
  "plugin/installed": { fields: { cwds: "cwds" } },
  "plugin/read": { fields: { pluginName: "id", marketplacePath: "cwd", remoteMarketplaceName: "id" }, required: ["pluginName"] },
  "plugin/skill/read": { fields: { remoteMarketplaceName: "id", remotePluginId: "id", skillName: "id" }, required: ["remoteMarketplaceName", "remotePluginId", "skillName"] },
  "app/list": { fields: { ...page, ...threadId } },
  "app/installed": { fields: { ...threadId } },
  "app/read": { fields: { appIds: "ids", includeTools: "boolean", ...threadId }, required: ["appIds"] },
  "windowsSandbox/readiness": { fields: {} },
};

const STABLE_ACTION: Record<string, NativeSpec> = {
  "thread/start": { fields: { cwd: "cwd", model: "text", modelProvider: "text", serviceTier: "text", personality: "text", threadSource: "jsonValue", ...reviewerFields, ephemeral: "boolean" }, required: ["cwd"] },
  "thread/resume": { fields: { ...threadId, cwd: "cwd", model: "text", modelProvider: "text", serviceTier: "text", personality: "text", excludeTurns: "boolean", ...reviewerFields }, required: ["threadId"] },
  "thread/fork": { fields: { ...threadId, cwd: "cwd", lastTurnId: "id", ephemeral: "boolean", excludeTurns: "boolean", model: "text", modelProvider: "text", serviceTier: "text", threadSource: "jsonValue", ...reviewerFields }, required: ["threadId"] },
  "thread/archive": { fields: { ...threadId }, required: ["threadId"] },
  "thread/unarchive": { fields: { ...threadId }, required: ["threadId"] },
  "thread/name/set": { fields: { ...threadId, name: "text" }, required: ["threadId", "name"] },
  "thread/compact/start": { fields: { ...threadId }, required: ["threadId"] },
  "thread/revert": { fields: { ...threadId, beforeTurnId: "id" }, required: ["threadId", "beforeTurnId"] },
  "thread/delete": { fields: { ...threadId }, required: ["threadId"] },
  "thread/unsubscribe": { fields: { ...threadId }, required: ["threadId"] },
  "review/start": { fields: { ...threadId, target: "reviewTarget", delivery: "inline" }, required: ["threadId", "target"] },
  "thread/metadata/update": { fields: { ...threadId, gitInfo: "gitInfo" }, required: ["threadId"] },
  "thread/attachment/add": { fields: { ...threadId, attachmentType: "id", identityKey: "id", payload: "jsonValue" }, required: ["threadId", "attachmentType", "identityKey", "payload"] },
  "thread/attachment/remove": { fields: { ...threadId, attachmentType: "id", identityKey: "id" }, required: ["threadId", "attachmentType", "identityKey"] },
  "threadSection/create": { fields: { name: "text", appearance: "appearance" }, required: ["name"] },
  "threadSection/update": { fields: { sectionId: "id", name: "text", appearance: "appearance" }, required: ["sectionId", "name"] },
  "threadSection/delete": { fields: { sectionId: "id" }, required: ["sectionId"] },
  "thread/section/move": { fields: { ...threadId, sectionId: "nullableId", beforeThreadId: "nullableId" }, required: ["threadId", "sectionId"] },
  "skills/extraRoots/set": { fields: { extraRoots: "cwds" }, required: ["extraRoots"] },
  "skills/config/write": { fields: { enabled: "boolean", name: "text", path: "cwd" }, required: ["enabled"] },
  "experimentalFeature/enablement/set": { fields: { enablement: "featureMap" }, required: ["enablement"] },
  "thread/inject_items": { fields: { ...threadId, items: "rawItems" }, required: ["threadId", "items"] },
};

const EXPERIMENTAL_READ: Record<string, NativeSpec> = {
  "collaborationMode/list": { fields: {} },
  "thread/queue/list": { fields: { ...threadId, ...page }, required: ["threadId"] },
  "thread/timeline/list": { fields: { ...threadId, ...page }, required: ["threadId"] },
  "thread/search": { fields: { searchTerm: "text", ...page, archived: "boolean", sortDirection: "direction" }, required: ["searchTerm"] },
  "thread/backgroundTerminals/list": { fields: { ...threadId, ...page }, required: ["threadId"] },
  "thread/searchOccurrences": { fields: { ...threadId, searchTerm: "text", ...page }, required: ["threadId", "searchTerm"] },
  "memory/status": { fields: { minConsolidatedThreads: "count" } },
  "plugin/search": { fields: { searchTerm: "text", ...page, cwds: "cwds", scope: "text" }, required: ["searchTerm"] },
  "project/list": { fields: { ...page, sortDirection: "direction", sortKey: "text" } },
  "project/read": { fields: { projectId: "id" }, required: ["projectId"] },
  "server/diagnostics": { fields: {} },
  "environment/status": { fields: { environmentId: "id" }, required: ["environmentId"] },
  "environment/info": { fields: { environmentId: "id" }, required: ["environmentId"] },
};

const EXPERIMENTAL_ACTION: Record<string, NativeSpec> = {
  "thread/start": { fields: { cwd: "cwd", model: "text", modelProvider: "text", serviceTier: "text", personality: "text", threadSource: "jsonValue", ...reviewerFields, ephemeral: "boolean", multiAgentMode: "multiAgent", dynamicTools: "jsonValue", permissions: "jsonValue", runtimeWorkspaceRoots: "cwds", selectedCapabilityRoots: "cwds", projectId: "id", environments: "jsonValue", daybreakEnabled: "boolean" }, required: ["cwd"] },
  "thread/fork": { fields: { ...threadId, cwd: "cwd", beforeTurnId: "id", lastTurnId: "id", deferGoalContinuation: "boolean", ephemeral: "boolean", excludeTurns: "boolean", model: "text", modelProvider: "text", serviceTier: "text", threadSource: "jsonValue", permissions: "jsonValue", runtimeWorkspaceRoots: "cwds", ...reviewerFields }, required: ["threadId"] },
  "thread/queue/add": { fields: { ...threadId, clientUserMessageId: "id", input: "input" }, required: ["threadId", "clientUserMessageId", "input"] },
  "thread/queue/update": { fields: { ...threadId, queuedSubmissionId: "id", input: "input" }, required: ["threadId", "queuedSubmissionId", "input"] },
  "thread/queue/delete": { fields: { ...threadId, queuedSubmissionId: "id" }, required: ["threadId", "queuedSubmissionId"] },
  "thread/queue/reorder": { fields: { ...threadId, queuedSubmissionIds: "ids" }, required: ["threadId", "queuedSubmissionIds"] },
  "thread/queue/start": { fields: { ...threadId, queuedSubmissionId: "id" }, required: ["threadId"] },
  "thread/settings/update": { fields: { ...threadId, approvalPolicy: "approval", approvalsReviewer: "reviewer", collaborationMode: "object", cwd: "cwd", model: "text", effort: "text", multiAgentMode: "multiAgent", permissions: "jsonValue", disabledPluginIds: "strings", personality: "text", sandboxPolicy: "jsonValue", serviceTier: "text", summary: "text" }, required: ["threadId"] },
  "turn/settings/update": { fields: { ...threadId, turnId: "id", approvalsReviewer: "reviewer", model: "text", effort: "text", serviceTier: "text", summary: "text" }, required: ["threadId", "turnId"] },
  "thread/memoryMode/set": { fields: { ...threadId, mode: "text" }, required: ["threadId", "mode"] },
};

export const NATIVE_GROUPS = {
  codex_native_read: STABLE_READ,
  codex_native_action: STABLE_ACTION,
  codex_experimental_read: EXPERIMENTAL_READ,
  codex_experimental_action: EXPERIMENTAL_ACTION,
} as const;

// Exact delivery is a result-body bound for read groups, separate from live
// observe sanitizer budgets. It returns the native result unchanged or fails
// whole; secret-shaped content fails closed rather than being exposed.
export const MAX_EXACT_RESULT_BYTES = 256 * 1024;
// Defensive serialization guard, not a native depth contract.
const MAX_EXACT_DEPTH = 256;

const DELIVERY_SCHEMA = {
  type: "string",
  enum: ["bounded", "exact"],
  default: "bounded",
  description: "bounded (default) sanitizes and bounds the result; delivery.lossless reports whether anything was redacted or truncated. exact returns the unaltered native result or fails whole with exact_delivery_failed (content_policy, structure, or size); never partial pages, synthetic cursors, or redacted text, and secret-shaped content is refused rather than exposed.",
};

function fieldSchema(kind: FieldKind): Record<string, unknown> {
  switch (kind) {
    case "id": return { type: "string", minLength: 1, maxLength: 200 };
    case "nullableId": return { anyOf: [fieldSchema("id"), { type: "null" }] };
    case "text": return { type: "string", minLength: 1, maxLength: 2000 };
    case "cursor": return { type: "string", minLength: 1, maxLength: 10000 };
    case "cwd": return { type: "string", minLength: 1, maxLength: 1000 };
    case "cwdFilter": return { oneOf: [fieldSchema("cwd"), { type: "array", maxItems: 20, items: fieldSchema("cwd") }] };
    case "count": return { type: "integer", minimum: 1, maximum: 100 };
    case "boolean": return { type: "boolean" };
    case "nullableBoolean": return { type: ["boolean", "null"] };
    case "ids": return { type: "array", minItems: 1, maxItems: 100, items: fieldSchema("id") };
    case "strings": return { type: "array", maxItems: 100, items: fieldSchema("id") };
    case "cwds": return { type: "array", maxItems: 20, items: fieldSchema("cwd") };
    case "input": return { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: true } };
    case "rawItems": return { type: "array", minItems: 1, maxItems: 20, items: { description: "Raw native Responses API item; total serialized payload limited to 20000 characters." } };
    case "object": return { type: "object", maxProperties: 20, additionalProperties: true };
    case "reviewer": return { type: "string", enum: ["user", "auto_review", "guardian_subagent"] };
    case "approval": return { oneOf: [
      { type: "string", enum: ["untrusted", "on-request", "never"] },
      { type: "object", properties: { granular: { type: "object", properties: { mcp_elicitations: { type: "boolean" }, rules: { type: "boolean" }, sandbox_approval: { type: "boolean" }, request_permissions: { type: "boolean" }, skill_approval: { type: "boolean" } }, required: ["mcp_elicitations", "rules", "sandbox_approval"], additionalProperties: false } }, required: ["granular"], additionalProperties: false },
    ] };
    case "sandbox": return { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] };
    case "direction": return { type: "string", enum: ["asc", "desc"] };
    case "itemsView": return { type: "string", enum: ["notLoaded", "summary", "full"] };
    case "multiAgent": return { oneOf: [{ type: "string", enum: ["explicitRequestOnly", "proactive"] }, { type: "object", properties: { custom: { type: "string", minLength: 1, maxLength: 10000 } }, required: ["custom"], additionalProperties: false }] };
    case "inline": return { type: "string", enum: ["inline"] };
    case "reviewTarget": return { oneOf: [
      { type: "object", properties: { type: { const: "uncommittedChanges" } }, required: ["type"], additionalProperties: false },
      { type: "object", properties: { type: { const: "baseBranch" }, branch: fieldSchema("text") }, required: ["type", "branch"], additionalProperties: false },
      { type: "object", properties: { type: { const: "commit" }, sha: fieldSchema("id"), title: fieldSchema("text") }, required: ["type", "sha"], additionalProperties: false },
      { type: "object", properties: { type: { const: "custom" }, instructions: { type: "string", minLength: 1, maxLength: 20000 } }, required: ["type", "instructions"], additionalProperties: false },
    ] };
    case "gitInfo": return { anyOf: [{ type: "object", properties: { branch: { anyOf: [fieldSchema("text"), { type: "null" }] }, originUrl: { anyOf: [fieldSchema("text"), { type: "null" }] }, sha: { anyOf: [fieldSchema("text"), { type: "null" }] } }, additionalProperties: false }, { type: "null" }] };
    case "appearance": return { anyOf: [{ type: "object", properties: { color: { anyOf: [fieldSchema("text"), { type: "null" }] }, icon: { anyOf: [fieldSchema("text"), { type: "null" }] } }, additionalProperties: false }, { type: "null" }] };
    case "jsonValue": return { description: "Native JSON value bounded to 20000 serialized characters." };
    case "featureMap": return { type: "object", maxProperties: 30, additionalProperties: { type: "boolean" } };
  }
}

export function nativeInputSchema(group: keyof typeof NATIVE_GROUPS): Record<string, unknown> {
  const specs = NATIVE_GROUPS[group];
  return {
    type: "object",
    oneOf: Object.entries(specs).map(([operation, spec]) => ({
      type: "object",
      properties: {
        operation: { const: operation },
        params: { type: "object", properties: Object.fromEntries(Object.entries(spec.fields).map(([key, kind]) => [key, fieldSchema(kind)])), required: spec.required ?? [], additionalProperties: false },
        ...(group.endsWith("_read") ? { delivery: DELIVERY_SCHEMA } : {}),
      },
      required: ["operation", "params"],
      additionalProperties: false,
    })),
  };
}

function validate(kind: FieldKind, value: unknown, key: string, platform: PlatformPolicy): unknown {
  const schema = fieldSchema(kind);
  if (kind === "nullableId" && value === null) return null;
  if (kind === "nullableBoolean" && value === null) return null;
  if (kind === "nullableBoolean") return validate("boolean", value, key, platform);
  if (kind === "nullableId") return validate("id", value, key, platform);
  if (kind === "cwdFilter") return Array.isArray(value) ? validate("cwds", value, key, platform) : validate("cwd", value, key, platform);
  if (kind === "approval" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const approval = value as Record<string, unknown>;
    if (Object.keys(approval).length !== 1 || !approval.granular || typeof approval.granular !== "object" || Array.isArray(approval.granular)) throw new Error(`${key} has invalid granular policy`);
    const granular = approval.granular as Record<string, unknown>;
    const required = ["mcp_elicitations", "rules", "sandbox_approval"];
    const allowed = [...required, "request_permissions", "skill_approval"];
    if (required.some((field) => typeof granular[field] !== "boolean") || Object.entries(granular).some(([field, entry]) => !allowed.includes(field) || typeof entry !== "boolean")) throw new Error(`${key} has invalid granular policy`);
    return value;
  }
  if (kind === "multiAgent" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const mode = value as Record<string, unknown>;
    if (Object.keys(mode).length !== 1 || typeof mode.custom !== "string" || mode.custom.length < 1 || mode.custom.length > 10000) throw new Error(`${key} has invalid custom mode`);
    return value;
  }
  if (kind === "rawItems") {
    if (!Array.isArray(value) || value.length < 1 || value.length > 20 || JSON.stringify(value).length > 20000) throw new Error(`${key} must be 1..20 raw items within 20000 JSON characters`);
    return value;
  }
  if (kind === "reviewTarget") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be a review target`);
    const target = value as Record<string, unknown>;
    const expected = target.type === "uncommittedChanges" ? ["type"] : target.type === "baseBranch" ? ["type", "branch"] : target.type === "commit" ? ["type", "sha", "title"] : target.type === "custom" ? ["type", "instructions"] : [];
    if (!expected.length || Object.keys(target).some((field) => !expected.includes(field))) throw new Error(`${key} has invalid review target`);
    for (const field of expected.filter((field) => field !== "type" && target[field] !== undefined)) {
      if (field === "title" && target[field] === null) continue;
      if (field === "instructions") {
        if (typeof target[field] !== "string" || target[field].length < 1 || target[field].length > 20000) throw new Error(`${key}.instructions is invalid`);
      } else validate("text", target[field], `${key}.${field}`, platform);
    }
    if ((target.type === "baseBranch" && !target.branch) || (target.type === "commit" && !target.sha) || (target.type === "custom" && !target.instructions)) throw new Error(`${key} is missing review target fields`);
    return value;
  }
  if (kind === "gitInfo" || kind === "appearance" || kind === "featureMap") {
    if (value === null && kind !== "featureMap") return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`);
    const record = value as Record<string, unknown>;
    const allowed = kind === "gitInfo" ? ["branch", "originUrl", "sha"] : kind === "appearance" ? ["color", "icon"] : Object.keys(record);
    if (Object.keys(record).length > (kind === "featureMap" ? 30 : 3) || Object.entries(record).some(([field, entry]) => !allowed.includes(field) || (kind === "featureMap" ? !/^[a-z][a-z0-9_]{0,79}$/.test(field) || typeof entry !== "boolean" : entry !== null && (typeof entry !== "string" || entry.length < 1 || entry.length > 2000)))) throw new Error(`${key} has invalid fields`);
    return value;
  }
  if (kind === "jsonValue") {
    if (value === undefined || JSON.stringify(value).length > 20000) throw new Error(`${key} exceeds 20000 JSON characters`);
    return value;
  }
  if (kind === "cwd") {
    if (typeof value !== "string" || value.length > 1000) throw new Error(`${key} must be a native absolute path`);
    return platform.validateCwd(value);
  }
  if (kind === "cwds") {
    if (!Array.isArray(value) || value.length > 20) throw new Error(`${key} must be an array of at most 20 paths`);
    return value.map((path) => validate("cwd", path, key, platform));
  }
  if (kind === "ids" || kind === "strings" || kind === "input") {
    if (!Array.isArray(value) || value.length < (kind === "strings" ? 0 : 1) || value.length > (kind === "input" ? 20 : 100)) throw new Error(`${key} has invalid array length`);
    if (kind === "ids" || kind === "strings") return value.map((id) => validate("id", id, key, platform));
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${key} entries must be objects`);
      if (!(["text", "image", "localImage", "audio", "localAudio", "mention", "skill"].includes((item as Record<string, unknown>).type as string))) throw new Error(`${key} contains unsupported input type`);
    }
    if (JSON.stringify(value).length > 200_000) throw new Error(`${key} exceeds 200000 characters`);
    return value;
  }
  if (kind === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 10000) throw new Error(`${key} must be a bounded object`);
    return value;
  }
  if (kind === "boolean") { if (typeof value !== "boolean") throw new Error(`${key} must be boolean`); return value; }
  if (kind === "count") { if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100) throw new Error(`${key} must be 1..100`); return value; }
  if (typeof value !== "string" || value.length < 1 || value.length > (schema.maxLength as number ?? 100)) throw new Error(`${key} must be a bounded string`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${key} is unsupported`);
  return value;
}

function exactDeliveryError(reason: "content_policy" | "structure" | "size", detail: string): Error {
  return new Error(`exact_delivery_failed: ${reason}: ${detail} The native read succeeded; no partial data, cursor, redacted substitute, or fallback read was returned.`);
}

// Validates without rewriting. Anything the bounded sanitizer would redact is
// refused, so exact never weakens the transport redaction boundary.
function assertExactJson(value: unknown, depth = 0, active = new Set<object>()): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw exactDeliveryError("structure", "non-finite number.");
    return;
  }
  if (typeof value === "string") {
    if (redactText(value) !== value) throw exactDeliveryError("content_policy", "secret-shaped text would require redaction; use bounded delivery for a redacted projection.");
    return;
  }
  if (typeof value !== "object" || depth >= MAX_EXACT_DEPTH || active.has(value)) {
    throw exactDeliveryError("structure", "value is not JSON-safe or exceeds the defensive nesting guard.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw exactDeliveryError("structure", "value is not a plain JSON object.");
  }
  active.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key) && child !== null && typeof child !== "boolean") {
      throw exactDeliveryError("content_policy", "a secret-named field would require redaction; use bounded delivery for a redacted projection.");
    }
    assertExactJson(child, depth + 1, active);
  }
  active.delete(value);
}

export async function nativeCall(appServer: AppServerManager, platform: PlatformPolicy, group: keyof typeof NATIVE_GROUPS, raw: unknown): Promise<unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("arguments must be an object");
  const args = raw as Record<string, unknown>;
  const readGroup = group.endsWith("_read");
  if (Object.keys(args).some((key) => key !== "operation" && key !== "params" && !(readGroup && key === "delivery"))) throw new Error("Unknown top-level argument");
  const delivery = args.delivery ?? "bounded";
  if (delivery !== "bounded" && delivery !== "exact") throw new Error("delivery must be bounded or exact");
  if (typeof args.operation !== "string" || !Object.hasOwn(NATIVE_GROUPS[group], args.operation)) throw new Error("Unknown native operation for this tool");
  const operation = args.operation;
  const spec = (NATIVE_GROUPS[group] as Record<string, NativeSpec>)[operation]!;
  if (!args.params || typeof args.params !== "object" || Array.isArray(args.params)) throw new Error("params must be an object");
  const input = args.params as Record<string, unknown>;
  if (Object.keys(input).some((key) => !Object.hasOwn(spec.fields, key))) throw new Error("Unsupported native parameter");
  for (const key of spec.required ?? []) if (input[key] === undefined) throw new Error(`${key} is required`);
  const params = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, validate(spec.fields[key]!, value, key, platform)]));
  if (operation === "thread/start") params.serviceName = "local-codex-bridge";
  const result = await appServer.request(operation, ["account/workspaceMessages/read", "windowsSandbox/readiness", "configRequirements/read"].includes(operation) ? null : params);
  if (["thread/start", "thread/fork", "thread/resume", "thread/read"].includes(operation)) {
    const envelope = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
    const thread = envelope?.thread && typeof envelope.thread === "object" && !Array.isArray(envelope.thread) ? envelope.thread as Record<string, unknown> : null;
    const id = thread?.id;
    if (typeof id !== "string" || id.length < 1 || id.length > 200) throw new Error(`${operation} returned no usable thread id; native outcome requires reconciliation`);
    if ((operation === "thread/resume" || operation === "thread/read") && id !== params.threadId) throw new Error(`${operation} returned a different thread id; native outcome requires reconciliation`);
    if (operation === "thread/fork" && id === params.threadId) throw new Error("thread/fork returned the source thread id; native outcome requires reconciliation");
    if (operation !== "thread/read") appServer.runtime.ensureThread(id);
  }
  const envelope = { source: "codex_app_server", stability: group.startsWith("codex_experimental") ? "experimental" : "stable", operation };
  if (delivery === "exact") {
    assertExactJson(result);
    const exact = { ...envelope, delivery: { mode: "exact", lossless: true }, result };
    const bytes = Buffer.byteLength(JSON.stringify(exact), "utf8");
    if (bytes > MAX_EXACT_RESULT_BYTES) {
      throw exactDeliveryError("size", `result body is ${bytes} bytes, above the ${MAX_EXACT_RESULT_BYTES}-byte bound; request a smaller native page or narrower scope (for example thread/items/list for one turn).`);
    }
    return exact;
  }
  const projected = sanitizeForTransport(result);
  return { ...envelope, delivery: { mode: "bounded", lossless: JSON.stringify(projected) === JSON.stringify(result) }, result: projected };
}
