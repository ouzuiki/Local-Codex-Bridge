import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGE_PURPOSES,
  capabilityManifest,
  classifyCodexQuota,
  observedRunCost,
  routeTask,
  selectWorker,
} from "./policy.mjs";

test("general engineering task defaults to Codex, then Claude, then Pi", () => {
  assert.deepEqual(selectWorker({
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  }), {
    action: "select",
    worker: "codex",
    fallback_chain: ["claude", "pi"],
    reason: "policy_general_engineering",
    rejected: [],
  });
});

test("a large repo-wide task with evidence missing defaults to Codex when available", () => {
  const decision = selectWorker({
    task: { task_class: "evidence_gathering", scope: "large", evidence_ready: false },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.worker, "codex");
  assert.equal(decision.reason, "policy_evidence_gathering");
});

test("generic required_capabilities gates eligibility the same as the legacy boolean shortcuts", () => {
  const viaGenericField = selectWorker({ task: { required_capabilities: ["bounded_mutation_scope"] } });
  const viaLegacyBoolean = selectWorker({ task: { bounded_mutation_scope: true } });
  assert.equal(viaGenericField.worker, "pi");
  assert.equal(viaGenericField.worker, viaLegacyBoolean.worker);
  assert.deepEqual(viaGenericField.fallback_chain, viaLegacyBoolean.fallback_chain);
});

test("risk_class alone (without the legacy bounded_mutation_scope boolean) participates in eligibility", () => {
  const decision = selectWorker({ task: { risk_class: "bounded_mutation" } });
  assert.equal(decision.worker, "pi");
  const claudeRejection = decision.rejected.find((item) => item.worker === "claude");
  assert.equal(claudeRejection.reason, "capability_mismatch");
  assert.deepEqual(claudeRejection.missing, ["bounded_mutation_scope"]);
});

test("evidence-gathering task defaults to Codex regardless of budget_mode (deprecated input, ignored)", () => {
  const decision = selectWorker({
    task: { task_class: "evidence_gathering" },
    policy: { budget_mode: "economy" },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.worker, "codex");
  assert.deepEqual(decision.fallback_chain, ["claude", "pi"]);
});

test("expert-review task with evidence ready defaults to Claude, then Codex, then Pi", () => {
  const decision = selectWorker({
    task: { task_class: "expert_review", evidence_ready: true },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.worker, "claude");
  assert.deepEqual(decision.fallback_chain, ["codex", "pi"]);
  assert.equal(decision.reason, "policy_expert_review");
});

test("Pi-specific extension capability requirement routes to Pi with no substitute worker", () => {
  const decision = selectWorker({
    task: { task_class: "extension_capability" },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.worker, "pi");
  assert.deepEqual(decision.fallback_chain, []);
  assert.deepEqual(decision.rejected.map((item) => item.worker).sort(), ["claude", "codex"]);
  for (const item of decision.rejected) {
    assert.equal(item.reason, "capability_mismatch");
    assert.deepEqual(item.missing, ["extension_capability"]);
  }
});

test("Pi extension capability requirement is fail-closed (HOLD-equivalent no_worker) when Pi is unavailable, not silently reassigned", () => {
  const decision = selectWorker({
    task: { task_class: "extension_capability" },
    state: { workers: { pi: { availability: "unavailable" } } },
  });
  assert.equal(decision.action, "no_worker");
  assert.equal(decision.worker, null);
  assert.equal(decision.rejected.find((item) => item.worker === "pi").reason, "unavailable");
});

test("explicit Claude preference is honored while viable, and is a preference not an override", () => {
  const preferred = selectWorker({
    policy: { preferred_worker: "claude" },
    state: { workers: { claude: { availability: "available", budget_pressure: "caution" } } },
  });
  assert.equal(preferred.worker, "claude");
  assert.equal(preferred.reason, "explicit_preference");

  const capabilityStillGates = selectWorker({
    task: { task_class: "extension_capability" },
    policy: { preferred_worker: "claude" },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(capabilityStillGates.worker, "pi");
});

test("strict read-only excludes Claude because LClB does not expose an enforced read-only mode", () => {
  const decision = selectWorker({
    task: { mode: "read", enforce_read_only: true },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.worker, "codex");
  assert.deepEqual(decision.fallback_chain, ["pi"]);
  assert.deepEqual(decision.rejected.find((item) => item.worker === "claude"), {
    worker: "claude",
    reason: "capability_mismatch",
    missing: ["enforced_read_only"],
  });
});

test("bounded mutation scope selects Pi as the only compatible worker", () => {
  const decision = selectWorker({ task: { bounded_mutation_scope: true } });
  assert.equal(decision.worker, "pi");
  assert.deepEqual(decision.fallback_chain, []);
});

test("provider override selects Pi; native thread inventory selects Codex", () => {
  assert.equal(selectWorker({ task: { requires_provider_override: true } }).worker, "pi");
  assert.equal(selectWorker({ task: { requires_native_thread_inventory: true } }).worker, "codex");
});

test("model override excludes Claude and keeps Codex before Pi", () => {
  const decision = selectWorker({ task: { requires_model_override: true } });
  assert.equal(decision.worker, "codex");
  assert.deepEqual(decision.fallback_chain, ["pi"]);
});

test("a short-window-healthy but weekly-exhausted worker is treated as unavailable, not healthy", () => {
  const decision = selectWorker({
    state: {
      workers: {
        codex: { availability: "available", quota_windows: { primary: "normal", secondary: "exhausted" } },
        claude: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.worker, "claude");
  assert.deepEqual(decision.rejected.find((item) => item.worker === "codex"), {
    worker: "codex",
    reason: "budget_exhausted",
  });
});

test("an unknown quota window deprioritizes but does not exclude a worker, and never counts as healthy", () => {
  const decision = selectWorker({
    state: {
      workers: {
        codex: { availability: "available", quota_windows: { primary: "normal", secondary: "unknown" } },
        claude: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  // Claude and Pi have confirmed-normal pressure and outrank Codex's
  // unknown-tainted pressure even though Codex is the general-engineering
  // default worker; Codex remains eligible (last), not excluded.
  assert.equal(decision.worker, "claude");
  assert.deepEqual(decision.fallback_chain, ["pi", "codex"]);
});

test("unavailable or exhausted preferred worker falls back instead of being blindly retried", () => {
  const unavailable = selectWorker({
    policy: { preferred_worker: "codex" },
    state: { workers: { codex: { availability: "unavailable" } } },
  });
  assert.equal(unavailable.worker, "claude");
  assert.equal(unavailable.rejected.find((item) => item.worker === "codex").reason, "unavailable");

  const exhausted = selectWorker({
    policy: { preferred_worker: "codex" },
    state: { workers: { codex: { availability: "available", budget_pressure: "exhausted" } } },
  });
  assert.equal(exhausted.worker, "claude");
  assert.equal(exhausted.rejected.find((item) => item.worker === "codex").reason, "budget_exhausted");
});

test("failed worker is not selected again in the same fallback decision", () => {
  const decision = selectWorker({ state: { failed_workers: ["codex"] } });
  assert.equal(decision.worker, "claude");
  assert.equal(decision.rejected.find((item) => item.worker === "codex").reason, "previous_attempt_failed");
});

test("an active run is held; pending HITL is held; unknown mutation acknowledgement requires reconcile", () => {
  assert.deepEqual(selectWorker({ state: { active_worker: "claude", active_terminal: false } }), {
    action: "hold",
    worker: "claude",
    fallback_chain: [],
    reason: "active_run",
  });
  assert.deepEqual(selectWorker({ state: { active_worker: "claude", active_terminal: false, pending_hitl: true } }), {
    action: "hold",
    worker: "claude",
    fallback_chain: [],
    reason: "pending_hitl",
  });
  assert.deepEqual(selectWorker({ state: { active_worker: "codex", active_terminal: false, mutation_ack: "unknown" } }), {
    action: "reconcile",
    worker: "codex",
    fallback_chain: [],
    reason: "mutation_ack_unknown",
  });
});

test("no viable worker returns no_worker with reasons instead of inventing a route", () => {
  const decision = selectWorker({
    task: { bounded_mutation_scope: true },
    state: { workers: { pi: { availability: "unavailable" } } },
  });
  assert.equal(decision.action, "no_worker");
  assert.equal(decision.worker, null);
  assert.equal(decision.rejected.length, 3);
});

test("routeTask wraps a single task class in one RoutingStage", () => {
  const decision = routeTask({
    task: { task_class: "expert_review", evidence_ready: true },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.action, "route");
  assert.equal(decision.worker, "claude");
  assert.equal(decision.stages.length, 1);
  assert.equal(decision.stages[0].purpose, "expert_review");
  assert.equal(decision.stages[0].task_class, "expert_review");
});

test("routeTask projects a stable stage purpose per task_class for every non-mixed class", () => {
  const byClass = {
    evidence_gathering: "evidence_acquisition",
    general_engineering: "engineering_execution",
    expert_review: "expert_review",
    extension_capability: "extension_capability",
  };
  for (const [taskClass, purpose] of Object.entries(byClass)) {
    const decision = routeTask({
      task: { task_class: taskClass, evidence_ready: true },
      state: {
        workers: {
          claude: { availability: "available", budget_pressure: "normal" },
          codex: { availability: "available", budget_pressure: "normal" },
          pi: { availability: "available", budget_pressure: "normal" },
        },
      },
    });
    assert.equal(decision.stages[0].purpose, purpose, `task_class ${taskClass}`);
  }
});

test("routeTask decomposes a mixed task into an evidence-acquisition stage and an expert-review stage", () => {
  const decision = routeTask({
    task: { task_class: "mixed" },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.action, "decompose");
  assert.equal(decision.stages.length, 2);
  assert.equal(decision.stages[0].purpose, "evidence_acquisition");
  assert.equal(decision.stages[0].worker, "codex");
  assert.equal(decision.stages[1].purpose, "expert_review");
  assert.equal(decision.stages[1].worker, "claude");
});

test("default mixed decomposition is exactly evidence_acquisition + expert_review, not every STAGE_PURPOSES entry", () => {
  // STAGE_PURPOSES has grown to 4 entries (it is also used for routeTask's
  // single-stage projection and for explicit stages_requested); the default
  // for an unqualified "mixed" task must stay pinned at exactly these two.
  assert.ok(STAGE_PURPOSES.length > 2, "this regression is only meaningful once STAGE_PURPOSES exceeds 2 entries");
  const decision = routeTask({
    task: { task_class: "mixed" },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.deepEqual(decision.stages.map((stage) => stage.purpose), ["evidence_acquisition", "expert_review"]);
});

test("a mixed task only decomposes into extension/engineering stages when explicitly requested", () => {
  const decision = routeTask({
    task: { task_class: "mixed", stages_requested: ["evidence_acquisition", "expert_review", "extension_capability"] },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.stages.length, 3);
  assert.equal(decision.stages[2].purpose, "extension_capability");
  assert.equal(decision.stages[2].worker, "pi");
});

test("routeTask propagates fail-closed HOLD from a blocked stage of a mixed task", () => {
  const decision = routeTask({
    task: { task_class: "mixed" },
    state: {
      workers: {
        claude: { availability: "unavailable" },
        codex: { availability: "available", budget_pressure: "exhausted" },
        pi: { availability: "unavailable" },
      },
    },
  });
  assert.equal(decision.action, "no_worker");
  assert.equal(decision.worker, null);
  assert.equal(decision.stages[0].purpose, "evidence_acquisition");
  assert.equal(decision.stages[0].action, "no_worker");
  assert.equal(decision.stages[1].purpose, "expert_review");
  assert.equal(decision.stages[1].action, "no_worker");
});

test("Codex quota normalization models the primary and secondary windows independently", () => {
  assert.deepEqual(classifyCodexQuota({
    rateLimits: {
      primary: { remainingPercent: 72 },
      secondary: { remainingPercent: 18 },
    },
  }), {
    pressure: "caution",
    remaining_percent: 18,
    source: "codex_rate_limits",
    windows: {
      primary: { state: "normal", remaining_percent: 72 },
      secondary: { state: "caution", remaining_percent: 18 },
    },
  });
  assert.equal(classifyCodexQuota({ spendControlReached: true }).pressure, "exhausted");
  assert.equal(classifyCodexQuota({ rateLimits: { primary: { remainingPercent: 6 } } }).pressure, "critical");
  assert.equal(classifyCodexQuota({}).pressure, "unknown");
});

test("a healthy primary window never masks an exhausted secondary window (live Supervisor evidence shape)", () => {
  const result = classifyCodexQuota({
    rateLimits: {
      primary: { usedPercent: 0, remainingPercent: 100 },
      secondary: { usedPercent: 100, remainingPercent: 0 },
    },
  });
  assert.equal(result.pressure, "exhausted");
  assert.equal(result.windows.primary.state, "normal");
  assert.equal(result.windows.secondary.state, "exhausted");
});

test("post-run cost observation never fabricates unsupported Codex cost", () => {
  assert.equal(observedRunCost("claude", { total_cost_usd: 0.0123 }), 0.0123);
  assert.equal(observedRunCost("pi", { stats: { cost: 0.0042 } }), 0.0042);
  assert.equal(observedRunCost("codex", { total_cost_usd: 999 }), null);
});

test("capability manifest preserves native asymmetry and CR1 default roles", () => {
  const manifest = capabilityManifest();
  assert.equal(manifest.owner, "supervisor");
  assert.equal(manifest.workers.claude.capabilities.model_override, false);
  assert.equal(manifest.workers.codex.capabilities.quota_probe, true);
  assert.equal(manifest.workers.pi.capabilities.bounded_mutation_scope, true);
  assert.equal(manifest.workers.pi.capabilities.extension_capability, true);
  assert.equal(manifest.workers.codex.default_role_v0, "engineering_default");
  assert.equal(manifest.workers.claude.default_role_v0, "expert_review_scarce");
  assert.equal(manifest.workers.pi.default_role_v0, "specialized_extension");
});
