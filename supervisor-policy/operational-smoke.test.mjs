import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutionPlan } from "./execution-plan.mjs";
import { evaluateCompletionGate } from "./completion-gate.mjs";

const available = {
  workers: {
    claude: { availability: "available", budget_pressure: "normal" },
    codex: { availability: "available", budget_pressure: "normal" },
    pi: { availability: "available", budget_pressure: "normal" },
  },
};

test("operational contract smoke: task -> selection -> memory/context -> acceptance -> P3 final gate", () => {
  const plan = buildExecutionPlan({
    task: { mode: "coding" },
    state: available,
    policy: { budget_mode: "quality" },
    context: {
      project_contract_present: true,
      native_session_active: false,
      memory_recall: { architecture_or_business_rule_sensitive: true },
      evidence: ["task_intake", "project_contract_verified"],
    },
  });

  assert.equal(plan.action, "ready");
  assert.equal(plan.worker, "claude");
  assert.equal(plan.context.project_contract.mode, "native");
  assert.equal(plan.context.skills.owner, "native_worker");
  assert.equal(plan.context.skills.supervisor_router, false);
  assert.equal(plan.context.advisory_memory.action, "recall");
  assert.equal(plan.context.memory_transport_required, true);
  assert.equal(plan.execution_boundary, "caller_invokes_selected_worker_bridge");

  // The Worker execution itself remains outside this pure policy package. Once
  // the Supervisor has independently verified the worker result and repository
  // evidence, the existing P3 Completion Gate is the only close decision.
  const final = evaluateCompletionGate({
    stage: "final",
    workspace_kind: "remote_only",
    evidence: {
      acceptance: "verified",
      tests: "passed",
      diff: "inspected",
      docs: "updated",
      agents: "not_needed",
      decisions: "updated",
      memory: "not_needed",
      commit: "created",
      push: "pushed",
      tree: "not_applicable",
    },
  });

  assert.deepEqual(final, {
    stage: "final",
    workspace_kind: "remote_only",
    ready: true,
    action: "close_task",
    blockers: [],
  });
});
