import assert from "node:assert/strict";
import test from "node:test";

import { completionGateOrder, evaluateCompletionGate } from "./completion-gate.mjs";
import {
  DURABLE_MEMORY_CATEGORIES,
  EXCLUDED_MEMORY_CATEGORIES,
  evaluateRecallPolicy,
  evaluateRecordPolicy,
  memoryGovernanceSummary,
} from "./memory-policy.mjs";
import { assessContractWatch, contractWatchBaseline } from "./contract-watch.mjs";

const readyPreCommit = Object.freeze({
  acceptance: "verified",
  tests: "passed",
  diff: "inspected",
  docs: "not_needed",
  agents: "not_needed",
  decisions: "not_needed",
  memory: "not_needed",
});

const readyFinal = Object.freeze({
  ...readyPreCommit,
  commit: "created",
  push: "pushed",
  tree: "clean",
});

test("P3 completion gate freezes the intended completion order", () => {
  assert.deepEqual(completionGateOrder(), [
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
  ]);
});

test("pre-commit gate opens only after verification, tests, diff, docs and memory assessment", () => {
  assert.deepEqual(evaluateCompletionGate({ stage: "pre_commit", evidence: readyPreCommit }), {
    stage: "pre_commit",
    workspace_kind: "working_tree",
    ready: true,
    action: "ready_for_commit",
    blockers: [],
  });

  const blocked = evaluateCompletionGate({
    stage: "pre_commit",
    evidence: { ...readyPreCommit, docs: "update_required", memory: "record_required" },
  });
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers.map((item) => item.reason), [
    "docs_update_unresolved",
    "memory_record_unresolved",
  ]);
});

test("tests may be explicitly not required but never implicitly skipped", () => {
  assert.equal(evaluateCompletionGate({
    stage: "pre_commit",
    evidence: { ...readyPreCommit, tests: "not_required" },
  }).ready, true);

  const blocked = evaluateCompletionGate({
    stage: "pre_commit",
    evidence: { ...readyPreCommit, tests: "not_run" },
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers[0].reason, "tests_not_completed");
});

test("final completion requires commit/push resolution and a verified clean tree", () => {
  assert.deepEqual(evaluateCompletionGate({ stage: "final", evidence: readyFinal }), {
    stage: "final",
    workspace_kind: "working_tree",
    ready: true,
    action: "close_task",
    blockers: [],
  });

  const dirty = evaluateCompletionGate({
    stage: "final",
    evidence: { ...readyFinal, tree: "dirty" },
  });
  assert.equal(dirty.ready, false);
  assert.equal(dirty.blockers[0].reason, "working_tree_dirty");
});

test("completion gate fails closed on rejected acceptance or failed memory write", () => {
  const rejected = evaluateCompletionGate({
    stage: "pre_commit",
    evidence: { ...readyPreCommit, acceptance: "rejected" },
  });
  assert.equal(rejected.blockers[0].reason, "acceptance_rejected");

  const memoryFailed = evaluateCompletionGate({
    stage: "pre_commit",
    evidence: { ...readyPreCommit, memory: "record_failed" },
  });
  assert.equal(memoryFailed.blockers[0].reason, "memory_record_failed");
});

test("memory recall is selective, fresh-run only and advisory", () => {
  const recall = evaluateRecallPolicy({
    project_scoped: true,
    fresh_run: true,
    continues_prior_work: true,
    cross_worker_handoff: true,
  });
  assert.equal(recall.action, "recall");
  assert.equal(recall.authority, "advisory");
  assert.deepEqual(recall.reasons, ["continues_prior_work", "cross_worker_handoff"]);
  assert.ok(recall.constraints.includes("must_not_override_project_contract"));

  assert.equal(evaluateRecallPolicy({ project_scoped: false }).action, "skip_recall");
  assert.equal(evaluateRecallPolicy({ project_scoped: true, fresh_run: false, continues_prior_work: true }).action, "skip_recall");
  assert.equal(evaluateRecallPolicy({ project_scoped: true, fresh_run: true }).action, "skip_recall");
});

test("durable memory is allowlisted and requires supervisor verification plus acceptance", () => {
  for (const category of DURABLE_MEMORY_CATEGORIES) {
    const decision = evaluateRecordPolicy({
      actor: "supervisor",
      category,
      verified: true,
      accepted: true,
    });
    assert.equal(decision.action, "record", category);
  }

  assert.equal(evaluateRecordPolicy({
    actor: "supervisor",
    category: "verified_root_cause",
    verified: false,
    accepted: true,
  }).reason, "not_verified");

  assert.equal(evaluateRecordPolicy({
    actor: "supervisor",
    category: "business_rule",
    verified: true,
    accepted: false,
  }).reason, "task_not_accepted");
});

test("raw logs, transcripts, secrets and worker self-reports do not become durable truth", () => {
  for (const category of EXCLUDED_MEMORY_CATEGORIES) {
    const decision = evaluateRecordPolicy({
      actor: "supervisor",
      category,
      verified: true,
      accepted: true,
    });
    assert.equal(decision.action, "do_not_record", category);
  }

  assert.equal(evaluateRecordPolicy({
    actor: "worker_model",
    category: "verified_decision",
    verified: true,
    accepted: true,
  }).reason, "worker_model_cannot_authorize_durable_memory");

  assert.equal(evaluateRecordPolicy({
    actor: "worker_bridge_hook",
    category: "verified_decision",
    verified: true,
    accepted: true,
  }).action, "candidate_episode_only");

  assert.equal(evaluateRecordPolicy({
    actor: "supervisor",
    category: "verified_decision",
    verified: true,
    accepted: true,
    contains_secret: true,
  }).reason, "contains_secret");
});

test("memory governance exposes the frozen authority split", () => {
  assert.deepEqual(memoryGovernanceSummary().durable_record_authority, [
    "supervisor",
    "supervisor_authorized_pipeline",
  ]);
  assert.equal(memoryGovernanceSummary().bridge_hook_role, "candidate_episode_transport_only");
});

function stableDomains(worker) {
  const baseline = contractWatchBaseline();
  const required = baseline.workers[worker].required;
  return Object.fromEntries(required.map((domain) => [domain, "stable"]));
}

test("contract watch passes stable seams and ignores optional absent quota surfaces", () => {
  assert.equal(assessContractWatch({
    worker: "pi",
    tests: "passed",
    domains: stableDomains("pi"),
  }).action, "pass");

  assert.equal(assessContractWatch({
    worker: "claude",
    tests: "passed",
    domains: stableDomains("claude"),
  }).action, "pass");
});

test("additive upstream changes with green conformance are observe-only", () => {
  const domains = stableDomains("codex");
  domains.tool_catalog = "additive";
  const decision = assessContractWatch({
    worker: "codex",
    native_version_changed: true,
    tests: "passed",
    domains,
  });
  assert.equal(decision.action, "observe_only");
  assert.equal(decision.allowed_fix_scope, "none");
});

test("breaking control/event/HITL/context/rate-limit changes permit only adapter seam repair", () => {
  for (const domain of ["native_api", "event_schema", "approval_semantics", "context_loading", "rate_limits"]) {
    const domains = stableDomains("codex");
    domains[domain] = "breaking";
    const decision = assessContractWatch({ worker: "codex", tests: "passed", domains });
    assert.equal(decision.action, "patch_contract_seam", domain);
    assert.equal(decision.allowed_fix_scope, "adapter_contract_seam_only", domain);
  }
});

test("version change without regression evidence requests tests instead of speculative patching", () => {
  const decision = assessContractWatch({
    worker: "claude",
    native_version_changed: true,
    tests: "not_run",
    domains: stableDomains("claude"),
  });
  assert.equal(decision.action, "run_conformance_tests");
  assert.equal(decision.allowed_fix_scope, "no_patch_until_evidence");
});

test("failed conformance or unknown required seam requires probe before patch", () => {
  const failed = assessContractWatch({
    worker: "pi",
    tests: "failed",
    domains: stableDomains("pi"),
  });
  assert.equal(failed.action, "probe_contract_seam");
  assert.equal(failed.allowed_fix_scope, "diagnose_before_patch");

  const unknown = stableDomains("pi");
  unknown.context_loading = "unknown";
  const review = assessContractWatch({ worker: "pi", tests: "passed", domains: unknown });
  assert.equal(review.action, "probe_contract_seam");
  assert.ok(review.unknown_domains.includes("context_loading"));
});
