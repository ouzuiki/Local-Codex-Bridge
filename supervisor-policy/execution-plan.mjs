import { selectWorker } from "./policy.mjs";
import { evaluateRecallPolicy } from "./memory-policy.mjs";
import { CONTEXT_AUTHORITY } from "./context-policy.mjs";

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function stringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

/**
 * Compose existing Supervisor policies into one non-executing task plan.
 *
 * This function deliberately does NOT:
 * - invoke a Bridge or Worker;
 * - perform TencentDB recall;
 * - discover, rank, read, or load Skills;
 * - persist workflow/session state.
 *
 * It only answers whether the Supervisor may proceed, which Worker is selected,
 * and which existing native/context seams must be used by the caller.
 */
export function buildExecutionPlan({
  task = {},
  state = {},
  policy = {},
  context = {},
} = {}) {
  requireObject(context, "context");
  const selection = selectWorker({ task, state, policy });

  if (selection.action !== "select") {
    return {
      action: selection.action,
      worker: selection.worker,
      fallback_chain: selection.fallback_chain,
      reason: selection.reason,
      worker_selection: selection,
      execution_allowed: false,
    };
  }

  const projectContractPresent = optionalBoolean(
    context.project_contract_present,
    true,
    "context.project_contract_present",
  );
  const nativeSessionActive = optionalBoolean(
    context.native_session_active,
    false,
    "context.native_session_active",
  );
  const taskContractConflict = optionalBoolean(
    context.task_contract_conflict,
    false,
    "context.task_contract_conflict",
  );
  const evidence = stringArray(context.evidence, "context.evidence");
  const blockers = [];

  if (!projectContractPresent) blockers.push("project_contract_missing");
  if (taskContractConflict) blockers.push("task_project_contract_conflict_requires_supervisor_resolution");

  const memoryInput = requireObject(context.memory_recall ?? {}, "context.memory_recall");
  const memory = evaluateRecallPolicy({
    ...memoryInput,
    project_scoped: memoryInput.project_scoped ?? true,
    fresh_run: memoryInput.fresh_run ?? !nativeSessionActive,
  });

  return {
    action: blockers.length === 0 ? "ready" : "blocked",
    execution_allowed: blockers.length === 0,
    blockers,
    worker: selection.worker,
    fallback_chain: selection.fallback_chain,
    worker_selection: selection,
    context: {
      project_contract: projectContractPresent
        ? { mode: "native", authority: "project" }
        : { mode: "missing", authority: "project" },
      native_session_history: nativeSessionActive ? "native_active" : "native_new",
      skills: {
        owner: "native_worker",
        discovery: "native_agent_skills",
        supervisor_router: false,
      },
      advisory_memory: memory,
      memory_transport_required: memory.action === "recall",
      evidence,
      authority: [...CONTEXT_AUTHORITY],
    },
    execution_boundary: "caller_invokes_selected_worker_bridge",
  };
}
