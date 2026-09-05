import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutionPlan } from "./execution-plan.mjs";

const available = {
  workers: {
    claude: { availability: "available", budget_pressure: "normal" },
    codex: { availability: "available", budget_pressure: "normal" },
    pi: { availability: "available", budget_pressure: "normal" },
  },
};

test("default general-engineering task composes a ready Codex plan with native Skills and no production Skill router", () => {
  const plan = buildExecutionPlan({ state: available });
  assert.equal(plan.action, "ready");
  assert.equal(plan.worker, "codex");
  assert.equal(plan.execution_allowed, true);
  assert.deepEqual(plan.context.skills, {
    owner: "native_worker",
    discovery: "native_agent_skills",
    supervisor_router: false,
  });
  assert.equal(plan.context.advisory_memory.action, "skip_recall");
  assert.equal(plan.context.memory_transport_required, false);
});

test("expert-review task with evidence ready still delegates Worker choice to the CR1/CR2 policy", () => {
  const plan = buildExecutionPlan({
    task: { task_class: "expert_review", evidence_ready: true },
    state: available,
  });
  assert.equal(plan.action, "ready");
  assert.equal(plan.worker, "claude");
  assert.deepEqual(plan.fallback_chain, ["codex", "pi"]);
});

test("a deprecated budget_mode input is accepted but no longer changes Worker ordering", () => {
  const plan = buildExecutionPlan({ state: available, policy: { budget_mode: "economy" } });
  assert.equal(plan.action, "ready");
  assert.equal(plan.worker, "codex");
});

test("active HITL is held before any new execution is allowed", () => {
  const plan = buildExecutionPlan({
    state: {
      ...available,
      active_worker: "claude",
      active_terminal: false,
      pending_hitl: true,
    },
  });
  assert.equal(plan.action, "hold");
  assert.equal(plan.worker, "claude");
  assert.equal(plan.execution_allowed, false);
});

test("unknown mutation acknowledgement forces reconcile", () => {
  const plan = buildExecutionPlan({
    state: {
      ...available,
      active_worker: "pi",
      active_terminal: false,
      mutation_ack: "unknown",
    },
  });
  assert.equal(plan.action, "reconcile");
  assert.equal(plan.worker, "pi");
  assert.equal(plan.execution_allowed, false);
});

test("missing project contract blocks execution after Worker selection", () => {
  const plan = buildExecutionPlan({
    state: available,
    context: { project_contract_present: false },
  });
  assert.equal(plan.action, "blocked");
  assert.equal(plan.execution_allowed, false);
  assert.deepEqual(plan.blockers, ["project_contract_missing"]);
});

test("task/project conflict cannot be silently resolved", () => {
  const plan = buildExecutionPlan({
    state: available,
    context: { task_contract_conflict: true },
  });
  assert.equal(plan.action, "blocked");
  assert.ok(plan.blockers.includes("task_project_contract_conflict_requires_supervisor_resolution"));
});

test("cross-worker handoff exposes recall as an advisory transport requirement", () => {
  const plan = buildExecutionPlan({
    state: available,
    context: { memory_recall: { cross_worker_handoff: true } },
  });
  assert.equal(plan.action, "ready");
  assert.equal(plan.context.advisory_memory.action, "recall");
  assert.deepEqual(plan.context.advisory_memory.reasons, ["cross_worker_handoff"]);
  assert.equal(plan.context.memory_transport_required, true);
});

test("active native session suppresses duplicate recall", () => {
  const plan = buildExecutionPlan({
    state: available,
    context: {
      native_session_active: true,
      memory_recall: { continues_prior_work: true },
    },
  });
  assert.equal(plan.context.advisory_memory.action, "skip_recall");
  assert.deepEqual(plan.context.advisory_memory.reasons, ["native_session_history_already_active"]);
  assert.equal(plan.context.memory_transport_required, false);
});

test("no viable Worker remains fail closed", () => {
  const plan = buildExecutionPlan({
    task: { bounded_mutation_scope: true, requires_quota_probe: true },
    state: available,
  });
  assert.equal(plan.action, "no_worker");
  assert.equal(plan.execution_allowed, false);
});
