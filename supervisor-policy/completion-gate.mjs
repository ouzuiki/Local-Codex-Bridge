const PRE_COMMIT_REQUIRED = Object.freeze([
  "acceptance",
  "tests",
  "diff",
  "docs",
  "agents",
  "decisions",
  "memory",
]);

const FINAL_REQUIRED = Object.freeze([
  ...PRE_COMMIT_REQUIRED,
  "commit",
  "push",
  "tree",
]);

const ALLOWED = Object.freeze({
  acceptance: new Set(["verified", "pending", "rejected"]),
  tests: new Set(["passed", "not_required", "failed", "not_run"]),
  diff: new Set(["inspected", "not_required", "pending"]),
  docs: new Set(["updated", "not_needed", "update_required"]),
  agents: new Set(["updated", "not_needed", "update_required"]),
  decisions: new Set(["updated", "not_needed", "update_required"]),
  memory: new Set(["recorded", "not_needed", "record_required", "record_failed"]),
  commit: new Set(["created", "not_needed", "pending"]),
  push: new Set(["pushed", "not_needed", "pending"]),
  tree: new Set(["clean", "dirty", "unknown", "not_applicable"]),
});

const PASSING = Object.freeze({
  acceptance: new Set(["verified"]),
  tests: new Set(["passed", "not_required"]),
  diff: new Set(["inspected", "not_required"]),
  docs: new Set(["updated", "not_needed"]),
  agents: new Set(["updated", "not_needed"]),
  decisions: new Set(["updated", "not_needed"]),
  memory: new Set(["recorded", "not_needed"]),
  commit: new Set(["created", "not_needed"]),
  push: new Set(["pushed", "not_needed"]),
});

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireStage(stage) {
  if (stage !== "pre_commit" && stage !== "final") {
    throw new TypeError("stage must be pre_commit or final");
  }
  return stage;
}

function requireWorkspaceKind(workspaceKind) {
  if (workspaceKind !== "working_tree" && workspaceKind !== "remote_only") {
    throw new TypeError("workspace_kind must be working_tree or remote_only");
  }
  return workspaceKind;
}

function validateEvidence(evidence, fields) {
  const value = requireObject(evidence, "evidence");
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new TypeError(`evidence.${field} is required`);
    }
    if (!ALLOWED[field].has(value[field])) {
      throw new TypeError(`evidence.${field} has an invalid status`);
    }
  }
  return value;
}

function blockerFor(field, status, workspaceKind) {
  switch (field) {
    case "acceptance":
      return status === "rejected" ? "acceptance_rejected" : "acceptance_not_verified";
    case "tests":
      return status === "failed" ? "tests_failed" : "tests_not_completed";
    case "diff":
      return "diff_not_inspected";
    case "docs":
      return "docs_update_unresolved";
    case "agents":
      return "agents_update_unresolved";
    case "decisions":
      return "decisions_update_unresolved";
    case "memory":
      return status === "record_failed" ? "memory_record_failed" : "memory_record_unresolved";
    case "commit":
      return "commit_not_completed";
    case "push":
      return "push_not_completed";
    case "tree":
      if (workspaceKind === "remote_only" && status !== "not_applicable") {
        return "remote_only_tree_status_must_be_not_applicable";
      }
      if (workspaceKind === "working_tree" && status === "not_applicable") {
        return "working_tree_cannot_be_not_applicable";
      }
      return status === "dirty" ? "working_tree_dirty" : "working_tree_not_verified_clean";
    default:
      return `${field}_unresolved`;
  }
}

function treePasses(status, workspaceKind) {
  return workspaceKind === "remote_only" ? status === "not_applicable" : status === "clean";
}

export function evaluateCompletionGate({
  stage = "pre_commit",
  workspace_kind = "working_tree",
  evidence,
} = {}) {
  const normalizedStage = requireStage(stage);
  const normalizedWorkspaceKind = requireWorkspaceKind(workspace_kind);
  const fields = normalizedStage === "pre_commit" ? PRE_COMMIT_REQUIRED : FINAL_REQUIRED;
  const normalizedEvidence = validateEvidence(evidence, fields);
  const blockers = [];

  for (const field of fields) {
    const status = normalizedEvidence[field];
    const passes = field === "tree"
      ? treePasses(status, normalizedWorkspaceKind)
      : PASSING[field].has(status);
    if (!passes) {
      blockers.push({
        field,
        status,
        reason: blockerFor(field, status, normalizedWorkspaceKind),
      });
    }
  }

  if (blockers.length > 0) {
    return {
      stage: normalizedStage,
      workspace_kind: normalizedWorkspaceKind,
      ready: false,
      action: "blocked",
      blockers,
    };
  }

  return {
    stage: normalizedStage,
    workspace_kind: normalizedWorkspaceKind,
    ready: true,
    action: normalizedStage === "pre_commit" ? "ready_for_commit" : "close_task",
    blockers: [],
  };
}

export function completionGateOrder() {
  return [
    "acceptance",
    "tests",
    "diff",
    "docs",
    "agents",
    "decisions",
    "memory",
    "commit",
    "push",
    "tree",
  ];
}
