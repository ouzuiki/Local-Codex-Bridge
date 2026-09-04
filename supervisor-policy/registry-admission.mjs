const BOOLEAN_FIELDS = [
  "dynamic_registration",
  "external_agent_ownership",
  "tenant_specific_agents",
  "runtime_capability_discovery",
  "agent_to_agent_discovery",
  "dynamic_discovery_is_execution_dependency",
  "runtime_registration_is_execution_dependency",
  "dynamic_multi_agent_collaboration",
  "parallel_agent_branches",
  "agent_handoff_loops",
  "shared_multi_agent_state",
  "dynamic_coordination_is_execution_dependency",
  "durable_workflow_required",
];

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function normalizeBooleans(input) {
  const value = requireObject(input, "admission input");
  const normalized = {};
  for (const field of BOOLEAN_FIELDS) {
    const raw = value[field];
    if (raw !== undefined && typeof raw !== "boolean") {
      throw new TypeError(`${field} must be boolean when provided`);
    }
    normalized[field] = raw === true;
  }
  if (value.static_manifest_maintainable !== undefined && typeof value.static_manifest_maintainable !== "boolean") {
    throw new TypeError("static_manifest_maintainable must be boolean when provided");
  }
  normalized.static_manifest_maintainable = value.static_manifest_maintainable !== false;
  return normalized;
}

export function evaluateRegistryAdmission(input = {}) {
  const value = normalizeBooleans(input);

  const hard = [];
  if (value.dynamic_discovery_is_execution_dependency) hard.push("dynamic_discovery_is_execution_dependency");
  if (value.runtime_registration_is_execution_dependency) hard.push("runtime_registration_is_execution_dependency");

  if (hard.length > 0) {
    return {
      action: "registry_required",
      reasons: hard,
      current_default: "static_manifest",
      guardrail: "adopt_or_build_registry_above_bridges_not_inside_them",
    };
  }

  const review = [];
  if (value.dynamic_registration) review.push("dynamic_registration");
  if (value.external_agent_ownership) review.push("external_agent_ownership");
  if (value.tenant_specific_agents) review.push("tenant_specific_agents");
  if (value.runtime_capability_discovery) review.push("runtime_capability_discovery");
  if (value.agent_to_agent_discovery) review.push("agent_to_agent_discovery");
  if (!value.static_manifest_maintainable) review.push("static_manifest_not_maintainable");

  if (review.length > 0) {
    return {
      action: "evaluate_registry",
      reasons: review,
      current_default: "static_manifest",
      guardrail: "do_not_create_registry_service_until_runtime_discovery_is_proven_necessary",
    };
  }

  return {
    action: "keep_static_manifest",
    reasons: ["workers_known_at_design_time", "static_capability_manifest_sufficient"],
    current_default: "static_manifest",
    guardrail: "agent_count_alone_is_not_a_registry_trigger",
  };
}

export function evaluateOrchestratorAdmission(input = {}) {
  const value = normalizeBooleans(input);

  if (value.durable_workflow_required) {
    return {
      action: "defer_to_durable_runtime_admission",
      reasons: ["durable_workflow_required"],
      boundary: "REF-03C",
    };
  }

  if (value.dynamic_coordination_is_execution_dependency) {
    return {
      action: "orchestrator_required",
      reasons: ["dynamic_coordination_is_execution_dependency"],
      guardrail: "orchestration_owner_stays_above_worker_bridges",
    };
  }

  const review = [];
  if (value.dynamic_multi_agent_collaboration) review.push("dynamic_multi_agent_collaboration");
  if (value.parallel_agent_branches) review.push("parallel_agent_branches");
  if (value.agent_handoff_loops) review.push("agent_handoff_loops");
  if (value.shared_multi_agent_state) review.push("shared_multi_agent_state");

  if (review.length > 0) {
    return {
      action: "evaluate_orchestrator",
      reasons: review,
      current_default: "supervisor_plus_p2_policy",
      guardrail: "do_not_turn_p2_into_execution_runtime",
    };
  }

  return {
    action: "keep_supervisor_policy",
    reasons: ["deterministic_worker_selection_sufficient", "no_shared_multi_agent_runtime_state"],
    current_default: "supervisor_plus_p2_policy",
    guardrail: "selection_policy_remains_pure_and_non_executing",
  };
}
