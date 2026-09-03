export const DURABLE_MEMORY_CATEGORIES = Object.freeze([
  "verified_decision",
  "business_rule",
  "architecture_constraint",
  "verified_root_cause",
  "reusable_sop",
]);

export const EXCLUDED_MEMORY_CATEGORIES = Object.freeze([
  "raw_log",
  "transcript",
  "worker_self_report",
  "unverified_hypothesis",
  "temporary_task_state",
  "credential_or_secret",
  "raw_command_output",
]);

const RECALL_REASONS = Object.freeze([
  "user_requested",
  "continues_prior_work",
  "multi_step_project_work",
  "architecture_or_business_rule_sensitive",
  "cross_worker_handoff",
  "prior_root_cause_or_sop_likely_relevant",
]);

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function bool(value) {
  return value === true;
}

export function evaluateRecallPolicy(input = {}) {
  const value = requireObject(input, "recall input");
  const projectScoped = value.project_scoped === undefined ? true : bool(value.project_scoped);
  const freshRun = value.fresh_run === undefined ? true : bool(value.fresh_run);

  if (!projectScoped) {
    return {
      action: "skip_recall",
      reasons: ["not_project_scoped"],
      authority: "advisory",
    };
  }

  if (!freshRun) {
    return {
      action: "skip_recall",
      reasons: ["native_session_history_already_active"],
      authority: "advisory",
    };
  }

  const reasons = RECALL_REASONS.filter((reason) => bool(value[reason]));
  if (reasons.length === 0) {
    return {
      action: "skip_recall",
      reasons: ["simple_fresh_task_without_memory_trigger"],
      authority: "advisory",
    };
  }

  return {
    action: "recall",
    reasons,
    authority: "advisory",
    constraints: [
      "must_not_override_current_task",
      "must_not_override_project_contract",
      "must_not_override_security_policy",
      "inject_only_bounded_relevant_context",
    ],
  };
}

function actorClass(actor) {
  if (actor === "supervisor") return "authoritative_decider";
  if (actor === "supervisor_authorized_pipeline") return "authorized_transport";
  if (actor === "worker_bridge_hook") return "candidate_episode_transport";
  if (actor === "worker_model") return "unauthorized_for_durable_truth";
  throw new TypeError("actor must be supervisor, supervisor_authorized_pipeline, worker_bridge_hook, or worker_model");
}

export function evaluateRecordPolicy(input = {}) {
  const value = requireObject(input, "record input");
  const actor = value.actor ?? "supervisor";
  const actorRole = actorClass(actor);
  const category = value.category;

  if (typeof category !== "string" || category.length === 0) {
    throw new TypeError("record input.category must be a non-empty string");
  }

  if (actor === "worker_model") {
    return {
      action: "do_not_record",
      reason: "worker_model_cannot_authorize_durable_memory",
      actor_role: actorRole,
    };
  }

  if (actor === "worker_bridge_hook") {
    return {
      action: "candidate_episode_only",
      reason: "bridge_hook_transports_completed_episode_but_does_not_establish_truth",
      actor_role: actorRole,
    };
  }

  if (EXCLUDED_MEMORY_CATEGORIES.includes(category)) {
    return {
      action: "do_not_record",
      reason: "excluded_category",
      category,
      actor_role: actorRole,
    };
  }

  if (!DURABLE_MEMORY_CATEGORIES.includes(category)) {
    return {
      action: "do_not_record",
      reason: "category_not_allowlisted",
      category,
      actor_role: actorRole,
    };
  }

  if (!bool(value.verified)) {
    return {
      action: "do_not_record",
      reason: "not_verified",
      category,
      actor_role: actorRole,
    };
  }

  if (!bool(value.accepted)) {
    return {
      action: "do_not_record",
      reason: "task_not_accepted",
      category,
      actor_role: actorRole,
    };
  }

  if (bool(value.contains_secret)) {
    return {
      action: "do_not_record",
      reason: "contains_secret",
      category,
      actor_role: actorRole,
    };
  }

  if (bool(value.ephemeral)) {
    return {
      action: "do_not_record",
      reason: "ephemeral_fact",
      category,
      actor_role: actorRole,
    };
  }

  return {
    action: "record",
    reason: "verified_durable_allowlisted_fact",
    category,
    actor_role: actorRole,
  };
}

export function memoryGovernanceSummary() {
  return {
    recall_authority: "advisory_only",
    durable_record_authority: ["supervisor", "supervisor_authorized_pipeline"],
    bridge_hook_role: "candidate_episode_transport_only",
    durable_categories: [...DURABLE_MEMORY_CATEGORIES],
    excluded_categories: [...EXCLUDED_MEMORY_CATEGORIES],
  };
}
