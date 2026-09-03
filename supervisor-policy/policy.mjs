import capabilitiesManifest from "./worker-capabilities.json" with { type: "json" };

export const WORKERS = Object.freeze(["claude", "codex", "pi"]);
export const BUDGET_MODES = Object.freeze(["quality", "balanced", "economy"]);
export const AVAILABILITY_STATES = Object.freeze(["available", "unknown", "degraded", "unavailable"]);
export const BUDGET_PRESSURE_STATES = Object.freeze(["normal", "unknown", "caution", "critical", "exhausted"]);

const BASE_ORDER = Object.freeze({
  quality: Object.freeze(["claude", "codex", "pi"]),
  balanced: Object.freeze(["claude", "codex", "pi"]),
  economy: Object.freeze(["pi", "claude", "codex"]),
});

const AVAILABILITY_RANK = Object.freeze({
  available: 0,
  unknown: 1,
  degraded: 2,
  unavailable: 99,
});

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
  return {
    mode: value.mode === undefined ? "coding" : requireEnum(value.mode, ["read", "coding"], "task.mode"),
    enforce_read_only: bool(value.enforce_read_only),
    bounded_mutation_scope: bool(value.bounded_mutation_scope),
    requires_model_override: bool(value.requires_model_override),
    requires_provider_override: bool(value.requires_provider_override),
    requires_quota_probe: bool(value.requires_quota_probe),
    requires_native_thread_inventory: bool(value.requires_native_thread_inventory),
  };
}

function normalizeState(state = {}) {
  const value = requireObject(state, "state");
  const workers = {};
  for (const worker of WORKERS) {
    const raw = value.workers?.[worker] ?? {};
    requireObject(raw, `state.workers.${worker}`);
    workers[worker] = {
      availability: requireEnum(raw.availability ?? "unknown", AVAILABILITY_STATES, `${worker}.availability`),
      budget_pressure: requireEnum(raw.budget_pressure ?? "unknown", BUDGET_PRESSURE_STATES, `${worker}.budget_pressure`),
    };
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
  const budgetMode = requireEnum(value.budget_mode ?? "balanced", BUDGET_MODES, "policy.budget_mode");
  const preferredWorker = value.preferred_worker ?? null;
  if (preferredWorker !== null) requireEnum(preferredWorker, WORKERS, "policy.preferred_worker");
  return { budget_mode: budgetMode, preferred_worker: preferredWorker };
}

function capabilityReasons(worker, task) {
  const capabilities = capabilitiesManifest.workers[worker].capabilities;
  const missing = [];
  if (task.mode === "coding" && !capabilities.coding) missing.push("coding");
  if (task.enforce_read_only && !capabilities.enforced_read_only) missing.push("enforced_read_only");
  if (task.bounded_mutation_scope && !capabilities.bounded_mutation_scope) missing.push("bounded_mutation_scope");
  if (task.requires_model_override && !capabilities.model_override) missing.push("model_override");
  if (task.requires_provider_override && !capabilities.provider_override) missing.push("provider_override");
  if (task.requires_quota_probe && !capabilities.quota_probe) missing.push("quota_probe");
  if (task.requires_native_thread_inventory && !capabilities.native_persistent_thread_inventory) {
    missing.push("native_persistent_thread_inventory");
  }
  return missing;
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

  const base = [...BASE_ORDER[policy.budget_mode]];
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

    if (policy.budget_mode === "quality") {
      const aCritical = aState.budget_pressure === "critical" ? 1 : 0;
      const bCritical = bState.budget_pressure === "critical" ? 1 : 0;
      if (aCritical !== bCritical) return aCritical - bCritical;
      const availability = AVAILABILITY_RANK[aState.availability] - AVAILABILITY_RANK[bState.availability];
      if (availability !== 0) return availability;
    } else {
      const availability = AVAILABILITY_RANK[aState.availability] - AVAILABILITY_RANK[bState.availability];
      if (availability !== 0) return availability;
      const pressure = PRESSURE_RANK[aState.budget_pressure] - PRESSURE_RANK[bState.budget_pressure];
      if (pressure !== 0) return pressure;
    }
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
    reason: normalizedPolicy.preferred_worker === worker ? "explicit_preference" : `policy_${normalizedPolicy.budget_mode}`,
    rejected,
  };
}

function collectRemainingPercent(rateLimits) {
  const values = [];
  const visit = (value) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.remainingPercent === "number" && Number.isFinite(value.remainingPercent)) {
      values.push(Math.max(0, Math.min(100, value.remainingPercent)));
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(rateLimits);
  return values;
}

export function classifyCodexQuota(rateLimits) {
  if (rateLimits === null || typeof rateLimits !== "object" || Array.isArray(rateLimits)) {
    return { pressure: "unknown", remaining_percent: null, source: "codex_rate_limits" };
  }
  const main = rateLimits.rateLimits !== null && typeof rateLimits.rateLimits === "object" && !Array.isArray(rateLimits.rateLimits)
    ? rateLimits.rateLimits
    : rateLimits;
  const spendControlReached = rateLimits.spendControlReached ?? main.spendControlReached;
  const reachedType = rateLimits.rateLimitReachedType ?? main.rateLimitReachedType;
  if (spendControlReached === true || (typeof reachedType === "string" && reachedType.length > 0)) {
    return { pressure: "exhausted", remaining_percent: 0, source: "codex_rate_limits" };
  }
  const values = collectRemainingPercent(main);
  if (values.length === 0) {
    return { pressure: "unknown", remaining_percent: null, source: "codex_rate_limits" };
  }
  const remaining = Math.min(...values);
  const pressure = remaining <= 0 ? "exhausted" : remaining <= 10 ? "critical" : remaining <= 25 ? "caution" : "normal";
  return { pressure, remaining_percent: remaining, source: "codex_rate_limits" };
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
