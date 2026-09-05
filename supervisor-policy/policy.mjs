import capabilitiesManifest from "./worker-capabilities.json" with { type: "json" };

export const WORKERS = Object.freeze(["claude", "codex", "pi"]);
export const AVAILABILITY_STATES = Object.freeze(["available", "unknown", "degraded", "unavailable"]);
export const BUDGET_PRESSURE_STATES = Object.freeze(["normal", "unknown", "caution", "critical", "exhausted"]);

// CR1 v0 worker-neutral routing contract: task-shape (task_class/scope/risk_class)
// plus capability/quota state now decides ordering. `budget_mode` (quality/
// balanced/economy) is accepted for input compatibility but no longer drives
// ordering: Pi is not assumed cheap, so a cost "mode" must not silently
// override task-class defaults or capability/quota eligibility.
export const BUDGET_MODES = Object.freeze(["quality", "balanced", "economy"]);
export const TASK_CLASSES = Object.freeze([
  "evidence_gathering",
  "general_engineering",
  "expert_review",
  "extension_capability",
  "mixed",
]);
export const SCOPES = Object.freeze(["tiny", "small", "medium", "large"]);
export const RISK_CLASSES = Object.freeze(["read_only", "bounded_mutation", "broad_mutation"]);
export const STAGE_PURPOSES = Object.freeze([
  "evidence_acquisition",
  "expert_review",
  "extension_capability",
  "engineering_execution",
]);

// The generic CR1 capability vocabulary a TaskProfile can require, matching
// the keys `worker-capabilities.json` publishes per worker. `required_capabilities`
// lets a caller request any of these directly instead of only the legacy
// boolean shortcuts below (which remain for backward compatibility and map
// onto this same vocabulary).
export const CAPABILITY_KEYS = Object.freeze([
  "coding",
  "approval_hitl",
  "health_probe",
  "enforced_read_only",
  "bounded_mutation_scope",
  "model_override",
  "provider_override",
  "quota_probe",
  "post_run_cost",
  "post_run_usage",
  "native_persistent_thread_inventory",
  "extension_capability",
]);

// Known/named Codex quota windows. Any other window id observed at runtime is
// still accepted by WorkerState (future workers may add their own probes),
// but this is the bounded allowlist telemetry (CR3) uses to admit a
// quota-window snapshot key; unlisted ids are dropped rather than logged.
export const QUOTA_WINDOW_IDS = Object.freeze(["primary", "secondary"]);

// CR1 WorkerState cost/latency bands are explicit dynamic signals, carried
// through as data even though CR2 v0 does not yet score on them: they are
// preference signals for a future routing refinement, not eligibility gates.
export const COST_LATENCY_BANDS = Object.freeze(["low", "medium", "high", "unknown"]);

// The finite, machine-readable set of reasons `selectWorker`/`routeTask` can
// ever emit. This is the allowlist CR3 telemetry validates `routing_reason`
// against so a caller can never persist arbitrary/secret-bearing text under
// this field.
export const ROUTING_REASONS = Object.freeze([
  "mutation_ack_unknown",
  "pending_hitl",
  "active_run",
  "no_viable_worker",
  "explicit_preference",
  "mixed_task_decomposed",
  ...TASK_CLASSES.map((taskClass) => `policy_${taskClass}`),
]);

const STAGE_TASK_CLASS = Object.freeze({
  evidence_acquisition: "evidence_gathering",
  expert_review: "expert_review",
  extension_capability: "extension_capability",
  engineering_execution: "general_engineering",
});

const TASK_CLASS_STAGE_PURPOSE = Object.freeze({
  evidence_gathering: "evidence_acquisition",
  expert_review: "expert_review",
  extension_capability: "extension_capability",
  general_engineering: "engineering_execution",
  mixed: "engineering_execution",
});

// A task's risk_class implies a minimum capability a worker must support,
// independent of (and consistent with) the legacy `bounded_mutation_scope`
// boolean: risk_class actually participates in eligibility, not just reasons.
const RISK_CLASS_REQUIRED_CAPABILITY = Object.freeze({
  read_only: null,
  bounded_mutation: "bounded_mutation_scope",
  broad_mutation: null,
});

// A "mixed" task_class defaults to exactly these two stages. STAGE_PURPOSES
// also includes "extension_capability" and "engineering_execution" (used by
// routeTask's single-stage RoutingStage projection and by explicit
// stages_requested), but those must never appear in the *default* mixed
// decomposition merely because they exist in the enum.
const DEFAULT_MIXED_STAGES = Object.freeze(["evidence_acquisition", "expert_review"]);

// CR1 v0 default role order per task class. Codex is the default
// engineering/evidence worker; Claude is the scarce expert-review worker;
// Pi is required only when a task explicitly needs its extension capability.
const TASK_CLASS_ORDER = Object.freeze({
  evidence_gathering: Object.freeze(["codex", "claude", "pi"]),
  general_engineering: Object.freeze(["codex", "claude", "pi"]),
  mixed: Object.freeze(["codex", "claude", "pi"]),
  expert_review: Object.freeze(["claude", "codex", "pi"]),
  extension_capability: Object.freeze(["pi", "codex", "claude"]),
});

const AVAILABILITY_RANK = Object.freeze({
  available: 0,
  unknown: 1,
  degraded: 2,
  unavailable: 99,
});

// Unknown quota/cost state is ranked worse than confirmed-normal and better
// than confirmed-degraded: it must not be treated as healthy/free, but it
// must not make a worker unusable on its own either.
const PRESSURE_RANK = Object.freeze({
  normal: 0,
  unknown: 1,
  caution: 2,
  critical: 3,
  exhausted: 99,
});

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireEnum(value, values, label) {
  if (!values.includes(value)) throw new TypeError(`${label} must be one of: ${values.join(", ")}`);
  return value;
}

function bool(value) {
  return value === true;
}

function normalizeTask(task = {}) {
  const value = requireObject(task, "task");
  const taskClass = value.task_class === undefined
    ? "general_engineering"
    : requireEnum(value.task_class, TASK_CLASSES, "task.task_class");
  const boundedMutationScope = bool(value.bounded_mutation_scope);
  const mode = value.mode === undefined ? "coding" : requireEnum(value.mode, ["read", "coding"], "task.mode");
  const riskClass = value.risk_class === undefined
    ? (boundedMutationScope ? "bounded_mutation" : mode === "read" ? "read_only" : "broad_mutation")
    : requireEnum(value.risk_class, RISK_CLASSES, "task.risk_class");
  const requiresExtensionCapability = bool(value.requires_extension_capability) || taskClass === "extension_capability";

  let stagesRequested = [];
  if (taskClass === "mixed") {
    if (value.stages_requested === undefined) {
      stagesRequested = [...DEFAULT_MIXED_STAGES];
    } else {
      if (!Array.isArray(value.stages_requested) || value.stages_requested.length === 0) {
        throw new TypeError("task.stages_requested must be a non-empty array when provided");
      }
      stagesRequested = [...new Set(value.stages_requested.map((stage) => requireEnum(stage, STAGE_PURPOSES, "task.stages_requested[]")))];
    }
  }

  const requiredCapabilities = value.required_capabilities === undefined
    ? []
    : (() => {
      if (!Array.isArray(value.required_capabilities)) {
        throw new TypeError("task.required_capabilities must be an array when provided");
      }
      return [...new Set(value.required_capabilities.map((cap) => requireEnum(cap, CAPABILITY_KEYS, "task.required_capabilities[]")))];
    })();

  return {
    mode,
    task_class: taskClass,
    scope: value.scope === undefined ? "small" : requireEnum(value.scope, SCOPES, "task.scope"),
    risk_class: riskClass,
    evidence_ready: bool(value.evidence_ready),
    enforce_read_only: bool(value.enforce_read_only),
    bounded_mutation_scope: boundedMutationScope,
    requires_model_override: bool(value.requires_model_override),
    requires_provider_override: bool(value.requires_provider_override),
    requires_quota_probe: bool(value.requires_quota_probe),
    requires_native_thread_inventory: bool(value.requires_native_thread_inventory),
    requires_extension_capability: requiresExtensionCapability,
    required_capabilities: requiredCapabilities,
    stages_requested: stagesRequested,
  };
}

function worstPressure(states) {
  return states.reduce((worst, state) => (PRESSURE_RANK[state] > PRESSURE_RANK[worst] ? state : worst), "normal");
}

function normalizeWorkerState(worker, raw = {}) {
  requireObject(raw, `state.workers.${worker}`);
  const quotaWindows = {};
  if (raw.quota_windows !== undefined) {
    requireObject(raw.quota_windows, `state.workers.${worker}.quota_windows`);
    for (const [windowId, windowState] of Object.entries(raw.quota_windows)) {
      quotaWindows[windowId] = requireEnum(windowState, BUDGET_PRESSURE_STATES, `state.workers.${worker}.quota_windows.${windowId}`);
    }
  }
  const budgetPressure = Object.keys(quotaWindows).length > 0
    ? worstPressure(Object.values(quotaWindows))
    : requireEnum(raw.budget_pressure ?? "unknown", BUDGET_PRESSURE_STATES, `${worker}.budget_pressure`);

  return {
    availability: requireEnum(raw.availability ?? "unknown", AVAILABILITY_STATES, `${worker}.availability`),
    budget_pressure: budgetPressure,
    quota_windows: quotaWindows,
    // Preference signals only (CR2 v0 does not score on these yet); still
    // explicit rather than silently absent so "unknown" is a real state.
    cost_band: requireEnum(raw.cost_band ?? "unknown", COST_LATENCY_BANDS, `${worker}.cost_band`),
    latency_band: requireEnum(raw.latency_band ?? "unknown", COST_LATENCY_BANDS, `${worker}.latency_band`),
  };
}

function normalizeState(state = {}) {
  const value = requireObject(state, "state");
  const workers = {};
  for (const worker of WORKERS) {
    workers[worker] = normalizeWorkerState(worker, value.workers?.[worker] ?? {});
  }
  const activeWorker = value.active_worker ?? null;
  if (activeWorker !== null) requireEnum(activeWorker, WORKERS, "state.active_worker");
  const mutationAck = value.mutation_ack ?? null;
  if (mutationAck !== null) requireEnum(mutationAck, ["accepted", "rejected", "unknown"], "state.mutation_ack");
  return {
    workers,
    active_worker: activeWorker,
    active_terminal: value.active_terminal === undefined ? true : bool(value.active_terminal),
    pending_hitl: bool(value.pending_hitl),
    mutation_ack: mutationAck,
    failed_workers: Array.isArray(value.failed_workers)
      ? value.failed_workers.map((worker) => requireEnum(worker, WORKERS, "state.failed_workers[]"))
      : [],
  };
}

function normalizePolicy(policy = {}) {
  const value = requireObject(policy, "policy");
  if (value.budget_mode !== undefined) requireEnum(value.budget_mode, BUDGET_MODES, "policy.budget_mode");
  const preferredWorker = value.preferred_worker ?? null;
  if (preferredWorker !== null) requireEnum(preferredWorker, WORKERS, "policy.preferred_worker");
  return { preferred_worker: preferredWorker };
}

function capabilityReasons(worker, task) {
  const capabilities = capabilitiesManifest.workers[worker].capabilities;
  const missing = new Set();
  if (task.mode === "coding" && !capabilities.coding) missing.add("coding");
  if (task.enforce_read_only && !capabilities.enforced_read_only) missing.add("enforced_read_only");
  if (task.bounded_mutation_scope && !capabilities.bounded_mutation_scope) missing.add("bounded_mutation_scope");
  if (task.requires_model_override && !capabilities.model_override) missing.add("model_override");
  if (task.requires_provider_override && !capabilities.provider_override) missing.add("provider_override");
  if (task.requires_quota_probe && !capabilities.quota_probe) missing.add("quota_probe");
  if (task.requires_native_thread_inventory && !capabilities.native_persistent_thread_inventory) {
    missing.add("native_persistent_thread_inventory");
  }
  if (task.requires_extension_capability && !capabilities.extension_capability) missing.add("extension_capability");

  // risk_class participates in eligibility directly: a bounded-mutation task
  // requires the bounded_mutation_scope capability even if the legacy
  // `bounded_mutation_scope` boolean was never set.
  const riskCapability = RISK_CLASS_REQUIRED_CAPABILITY[task.risk_class];
  if (riskCapability && !capabilities[riskCapability]) missing.add(riskCapability);

  // Generic CR1 capability requirements, in addition to the legacy shortcuts
  // above (both ultimately gate the same worker-capabilities.json keys).
  for (const capability of task.required_capabilities ?? []) {
    if (!capabilities[capability]) missing.add(capability);
  }

  return [...missing];
}

function orderedCandidates(task, state, policy) {
  const failed = new Set(state.failed_workers);
  const compatible = [];
  const rejected = [];

  for (const worker of WORKERS) {
    const missing = capabilityReasons(worker, task);
    const workerState = state.workers[worker];
    if (missing.length > 0) {
      rejected.push({ worker, reason: "capability_mismatch", missing });
      continue;
    }
    if (failed.has(worker)) {
      rejected.push({ worker, reason: "previous_attempt_failed" });
      continue;
    }
    if (workerState.availability === "unavailable") {
      rejected.push({ worker, reason: "unavailable" });
      continue;
    }
    if (workerState.budget_pressure === "exhausted") {
      rejected.push({ worker, reason: "budget_exhausted" });
      continue;
    }
    compatible.push(worker);
  }

  const base = [...TASK_CLASS_ORDER[task.task_class]];
  if (policy.preferred_worker && compatible.includes(policy.preferred_worker)) {
    base.splice(base.indexOf(policy.preferred_worker), 1);
    base.unshift(policy.preferred_worker);
  }

  const baseIndex = new Map(base.map((worker, index) => [worker, index]));
  compatible.sort((a, b) => {
    if (policy.preferred_worker === a) return -1;
    if (policy.preferred_worker === b) return 1;
    const aState = state.workers[a];
    const bState = state.workers[b];
    const availability = AVAILABILITY_RANK[aState.availability] - AVAILABILITY_RANK[bState.availability];
    if (availability !== 0) return availability;
    const pressure = PRESSURE_RANK[aState.budget_pressure] - PRESSURE_RANK[bState.budget_pressure];
    if (pressure !== 0) return pressure;
    return baseIndex.get(a) - baseIndex.get(b);
  });

  return { compatible, rejected };
}

export function selectWorker({ task = {}, state = {}, policy = {} } = {}) {
  const normalizedTask = normalizeTask(task);
  const normalizedState = normalizeState(state);
  const normalizedPolicy = normalizePolicy(policy);

  if (normalizedState.active_worker && !normalizedState.active_terminal) {
    if (normalizedState.mutation_ack === "unknown") {
      return {
        action: "reconcile",
        worker: normalizedState.active_worker,
        fallback_chain: [],
        reason: "mutation_ack_unknown",
      };
    }
    if (normalizedState.pending_hitl) {
      return {
        action: "hold",
        worker: normalizedState.active_worker,
        fallback_chain: [],
        reason: "pending_hitl",
      };
    }
    return {
      action: "hold",
      worker: normalizedState.active_worker,
      fallback_chain: [],
      reason: "active_run",
    };
  }

  const { compatible, rejected } = orderedCandidates(normalizedTask, normalizedState, normalizedPolicy);
  if (compatible.length === 0) {
    return {
      action: "no_worker",
      worker: null,
      fallback_chain: [],
      reason: "no_viable_worker",
      rejected,
    };
  }

  const [worker, ...fallbackChain] = compatible;
  return {
    action: "select",
    worker,
    fallback_chain: fallbackChain,
    reason: normalizedPolicy.preferred_worker === worker ? "explicit_preference" : `policy_${normalizedTask.task_class}`,
    rejected,
  };
}

/**
 * CR2 deterministic RoutingDecision entry point. Wraps `selectWorker` with
 * explicit RoutingStage objects and, for `task_class: "mixed"`, decomposes
 * the task into an evidence-acquisition stage and an expert-review stage
 * (each independently routed against the same worker state snapshot) instead
 * of forcing a single-worker decision on a task that actually spans two
 * shapes of work. This function makes no model or network calls.
 */
export function routeTask({ task = {}, state = {}, policy = {} } = {}) {
  const normalizedTask = normalizeTask(task);

  if (normalizedTask.task_class !== "mixed") {
    const selection = selectWorker({ task, state, policy });
    const stage = {
      stage_id: 1,
      purpose: TASK_CLASS_STAGE_PURPOSE[normalizedTask.task_class],
      task_class: normalizedTask.task_class,
      action: selection.action,
      worker: selection.worker,
      fallback_chain: selection.fallback_chain,
      reason: selection.reason,
      rejected: selection.rejected ?? [],
    };
    return {
      action: selection.action === "select" ? "route" : selection.action,
      worker: selection.worker,
      fallback_chain: selection.fallback_chain,
      reason: selection.reason,
      rejected: selection.rejected ?? [],
      stages: [stage],
    };
  }

  const stages = normalizedTask.stages_requested.map((purpose, index) => {
    const stageTask = { ...task, task_class: STAGE_TASK_CLASS[purpose] };
    const selection = selectWorker({ task: stageTask, state, policy });
    return {
      stage_id: index + 1,
      purpose,
      task_class: STAGE_TASK_CLASS[purpose],
      action: selection.action,
      worker: selection.worker,
      fallback_chain: selection.fallback_chain,
      reason: selection.reason,
      rejected: selection.rejected ?? [],
    };
  });

  const blockedStage = stages.find((stage) => stage.action !== "select");
  if (blockedStage) {
    return {
      action: blockedStage.action,
      worker: blockedStage.worker,
      fallback_chain: blockedStage.fallback_chain,
      reason: blockedStage.reason,
      rejected: blockedStage.rejected,
      stages,
    };
  }

  return {
    action: "decompose",
    worker: null,
    fallback_chain: [],
    reason: "mixed_task_decomposed",
    rejected: [],
    stages,
  };
}

function classifyWindow(window) {
  if (window === null || typeof window !== "object" || Array.isArray(window)) {
    return { state: "unknown", remaining_percent: null };
  }
  if (typeof window.remainingPercent !== "number" || !Number.isFinite(window.remainingPercent)) {
    return { state: "unknown", remaining_percent: null };
  }
  const remaining = Math.max(0, Math.min(100, window.remainingPercent));
  const state = remaining <= 0 ? "exhausted" : remaining <= 10 ? "critical" : remaining <= 25 ? "caution" : "normal";
  return { state, remaining_percent: remaining };
}

/**
 * Codex exposes at least two independent rate-limit windows (`primary`,
 * typically the 5-hour window, and `secondary`, typically the weekly
 * window). They are classified independently and combined conservatively:
 * the worst known window wins, so a healthy short window can never mask an
 * exhausted weekly window. A window is `unknown` only when it was not
 * observed; `unknown` never counts as healthy.
 */
export function classifyCodexQuota(rateLimits) {
  if (rateLimits === null || typeof rateLimits !== "object" || Array.isArray(rateLimits)) {
    return {
      pressure: "unknown",
      remaining_percent: null,
      source: "codex_rate_limits",
      windows: { primary: { state: "unknown", remaining_percent: null }, secondary: { state: "unknown", remaining_percent: null } },
    };
  }
  const main = rateLimits.rateLimits !== null && typeof rateLimits.rateLimits === "object" && !Array.isArray(rateLimits.rateLimits)
    ? rateLimits.rateLimits
    : rateLimits;
  const spendControlReached = rateLimits.spendControlReached ?? main.spendControlReached;
  const reachedType = rateLimits.rateLimitReachedType ?? main.rateLimitReachedType;
  if (spendControlReached === true || (typeof reachedType === "string" && reachedType.length > 0)) {
    return {
      pressure: "exhausted",
      remaining_percent: 0,
      source: "codex_rate_limits",
      windows: { primary: { state: "exhausted", remaining_percent: 0 }, secondary: { state: "exhausted", remaining_percent: 0 } },
    };
  }

  const windows = {
    primary: classifyWindow(main.primary),
    secondary: classifyWindow(main.secondary),
  };
  const knownRemaining = Object.values(windows)
    .map((window) => window.remaining_percent)
    .filter((value) => value !== null);
  if (knownRemaining.length === 0) {
    return { pressure: "unknown", remaining_percent: null, source: "codex_rate_limits", windows };
  }
  const pressure = worstPressure(Object.values(windows).map((window) => window.state));
  return { pressure, remaining_percent: Math.min(...knownRemaining), source: "codex_rate_limits", windows };
}

export function observedRunCost(worker, result) {
  requireEnum(worker, WORKERS, "worker");
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  if (worker === "claude") {
    return typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd)
      ? result.total_cost_usd
      : null;
  }
  if (worker === "pi") {
    return typeof result.stats?.cost === "number" && Number.isFinite(result.stats.cost)
      ? result.stats.cost
      : null;
  }
  return null;
}

export function capabilityManifest() {
  return structuredClone(capabilitiesManifest);
}
