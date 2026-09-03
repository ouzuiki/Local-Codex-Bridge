import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCompletionGate } from "./completion-gate.mjs";

const baseFinal = {
  acceptance: "verified",
  tests: "passed",
  diff: "inspected",
  docs: "updated",
  agents: "not_needed",
  decisions: "updated",
  memory: "not_needed",
  commit: "created",
  push: "pushed",
};

test("remote-only execution closes only with tree=not_applicable", () => {
  assert.deepEqual(evaluateCompletionGate({
    stage: "final",
    workspace_kind: "remote_only",
    evidence: { ...baseFinal, tree: "not_applicable" },
  }), {
    stage: "final",
    workspace_kind: "remote_only",
    ready: true,
    action: "close_task",
    blockers: [],
  });

  const wrong = evaluateCompletionGate({
    stage: "final",
    workspace_kind: "remote_only",
    evidence: { ...baseFinal, tree: "clean" },
  });
  assert.equal(wrong.ready, false);
  assert.equal(wrong.blockers[0].reason, "remote_only_tree_status_must_be_not_applicable");
});

test("local working-tree execution still requires verified clean tree", () => {
  assert.equal(evaluateCompletionGate({
    stage: "final",
    workspace_kind: "working_tree",
    evidence: { ...baseFinal, tree: "clean" },
  }).ready, true);

  const invalid = evaluateCompletionGate({
    stage: "final",
    workspace_kind: "working_tree",
    evidence: { ...baseFinal, tree: "not_applicable" },
  });
  assert.equal(invalid.ready, false);
  assert.equal(invalid.blockers[0].reason, "working_tree_cannot_be_not_applicable");
});
