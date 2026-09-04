import assert from "node:assert/strict";
import test from "node:test";

import catalog from "./skill-catalog.json" with { type: "json" };
import { evaluateOrchestratorAdmission, evaluateRegistryAdmission } from "./registry-admission.mjs";
import {
  CONTEXT_AUTHORITY,
  resolveContextConflict,
  resolveTaskContractConflict,
  selectContextPlan,
  selectMinimalSkills,
} from "./context-policy.mjs";

test("REF-02 keeps the current three known workers on the static capability manifest", () => {
  const decision = evaluateRegistryAdmission({ static_manifest_maintainable: true });
  assert.equal(decision.action, "keep_static_manifest");
  assert.equal(decision.guardrail, "agent_count_alone_is_not_a_registry_trigger");
});

test("REF-02 reviews dynamic signals without prematurely requiring a registry", () => {
  const decision = evaluateRegistryAdmission({
    dynamic_registration: true,
    external_agent_ownership: true,
  });
  assert.equal(decision.action, "evaluate_registry");
  assert.deepEqual(decision.reasons, ["dynamic_registration", "external_agent_ownership"]);
});

test("REF-02 requires a registry only when runtime discovery/registration becomes an execution dependency", () => {
  assert.equal(evaluateRegistryAdmission({
    dynamic_discovery_is_execution_dependency: true,
  }).action, "registry_required");

  assert.equal(evaluateRegistryAdmission({
    runtime_registration_is_execution_dependency: true,
  }).action, "registry_required");
});

test("REF-02 keeps deterministic P2 selection until dynamic coordination is actually needed", () => {
  assert.equal(evaluateOrchestratorAdmission({}).action, "keep_supervisor_policy");
  assert.equal(evaluateOrchestratorAdmission({
    parallel_agent_branches: true,
  }).action, "evaluate_orchestrator");
  assert.equal(evaluateOrchestratorAdmission({
    dynamic_coordination_is_execution_dependency: true,
  }).action, "orchestrator_required");
  assert.deepEqual(evaluateOrchestratorAdmission({
    durable_workflow_required: true,
  }), {
    action: "defer_to_durable_runtime_admission",
    reasons: ["durable_workflow_required"],
    boundary: "REF-03C",
  });
});

test("REF-05 catalog is metadata-only and leaves loading to native Workers", () => {
  assert.equal(catalog.centralized_skill_content, false);
  assert.equal(catalog.loader_owner, "native_worker");
  assert.equal(catalog.default_load_mode, "on_demand");
  assert.deepEqual(catalog.skills, []);
});

test("REF-05 selects the minimum compatible skill set that covers required procedure classes", () => {
  const available = [
    { id: "migration", covers: ["db_migration"], workers: ["*"], load_mode: "on_demand", priority: 1 },
    { id: "database-safety", covers: ["db_safety"], workers: ["*"], load_mode: "on_demand", priority: 1 },
    { id: "safe-migration", covers: ["db_migration", "db_safety"], workers: ["codex", "claude"], load_mode: "on_demand", priority: 2 },
    { id: "ui-fidelity", covers: ["ui_fidelity"], workers: ["*"], load_mode: "on_demand", priority: 9 },
  ];

  const decision = selectMinimalSkills({
    worker: "claude",
    required_skill_classes: ["db_migration", "db_safety"],
    available_skills: available,
  });

  assert.equal(decision.action, "ready");
  assert.deepEqual(decision.selected_skill_ids, ["safe-migration"]);
  assert.equal(decision.selected_skill_ids.includes("ui-fidelity"), false);
});

test("REF-05 never guesses an unavailable or worker-incompatible requested skill", () => {
  const decision = selectMinimalSkills({
    worker: "pi",
    requested_skill_ids: ["claude-only", "missing"],
    available_skills: [
      { id: "claude-only", covers: ["review"], workers: ["claude"], load_mode: "on_demand" },
    ],
  });
  assert.equal(decision.action, "needs_skill_resolution");
  assert.deepEqual(decision.unresolved_skill_ids, ["claude-only", "missing"]);
  assert.deepEqual(decision.selected_skill_ids, []);
});

test("REF-05 blocks when required skill coverage is unavailable instead of scanning or inventing a loader", () => {
  const plan = selectContextPlan({
    worker: "codex",
    required_skill_classes: ["unknown_procedure"],
    available_skills: [],
  });
  assert.equal(plan.action, "blocked");
  assert.ok(plan.blockers.includes("skill_resolution_required"));
  assert.equal(plan.loader_owner, "native_worker");
});

test("REF-05 preserves native project contract and native session ownership", () => {
  const plan = selectContextPlan({
    worker: "claude",
    project_contract_present: true,
    native_session_active: true,
    memory_recall: { continues_prior_work: true },
  });
  assert.equal(plan.action, "ready");
  assert.deepEqual(plan.project_contract, { mode: "native", authority: "project" });
  assert.equal(plan.native_session_history, "native_active");
  assert.equal(plan.advisory_memory.action, "skip_recall");
  assert.deepEqual(plan.advisory_memory.reasons, ["native_session_history_already_active"]);
});

test("REF-05 fresh project work can recall advisory memory without changing loader ownership", () => {
  const plan = selectContextPlan({
    worker: "pi",
    native_session_active: false,
    memory_recall: {
      continues_prior_work: true,
      architecture_or_business_rule_sensitive: true,
    },
    evidence: ["git_diff", "test_result", "git_diff"],
  });
  assert.equal(plan.advisory_memory.action, "recall");
  assert.equal(plan.advisory_memory.authority, "advisory");
  assert.deepEqual(plan.evidence, ["git_diff", "test_result"]);
  assert.equal(plan.loader_owner, "native_worker");
});

test("REF-05 context authority prevents memory/skills from overriding contract or current evidence", () => {
  assert.deepEqual(CONTEXT_AUTHORITY, [
    "security_hard_runtime",
    "task_and_project_contract",
    "verified_current_evidence",
    "skill_procedure",
    "advisory_memory",
    "historical_raw_context",
  ]);
  assert.deepEqual(resolveContextConflict({
    left_source: "task_and_project_contract",
    right_source: "advisory_memory",
  }), { action: "resolved", winner: "task_and_project_contract" });
  assert.deepEqual(resolveContextConflict({
    left_source: "verified_current_evidence",
    right_source: "skill_procedure",
  }), { action: "resolved", winner: "verified_current_evidence" });
  assert.deepEqual(resolveContextConflict({
    left_source: "security_hard_runtime",
    right_source: "task_and_project_contract",
  }), { action: "resolved", winner: "security_hard_runtime" });
});

test("REF-05 never silently resolves a conflict between the current task and project contract", () => {
  assert.deepEqual(resolveTaskContractConflict(), {
    action: "supervisor_resolution_required",
    reason: "current_task_and_project_contract_are_both_authoritative_inputs_and_must_not_be_silently_overridden",
  });
});

test("REF-05 requires the project contract rather than substituting memory or a skill", () => {
  const plan = selectContextPlan({
    worker: "codex",
    project_contract_present: false,
    memory_recall: { user_requested: true },
  });
  assert.equal(plan.action, "blocked");
  assert.ok(plan.blockers.includes("project_contract_missing"));
});
