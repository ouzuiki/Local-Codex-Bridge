import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityManifest,
  classifyCodexQuota,
  observedRunCost,
  selectWorker,
} from "./policy.mjs";

test("balanced/default coding prefers Claude, then Codex, then Pi", () => {
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
    worker: "claude",
    fallback_chain: ["codex", "pi"],
    reason: "policy_balanced",
    rejected: [],
  });
});

test("economy mode prefers Pi without changing Bridge semantics", () => {
  const decision = selectWorker({
    policy: { budget_mode: "economy" },
    state: {
      workers: {
        claude: { availability: "available", budget_pressure: "normal" },
        codex: { availability: "available", budget_pressure: "normal" },
        pi: { availability: "available", budget_pressure: "normal" },
      },
    },
  });
  assert.equal(decision.worker, "pi");
  assert.deepEqual(decision.fallback_chain, ["claude", "codex"]);
});

test("explicit Claude preference is honored while viable", () => {
  const decision = selectWorker({
    policy: { budget_mode: "economy", preferred_worker: "claude" },
    state: { workers: { claude: { availability: "available", budget_pressure: "caution" } } },
  });
  assert.equal(decision.worker, "claude");
  assert.equal(decision.reason, "explicit_preference");
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

test("model override excludes Claude and keeps Codex before Pi in balanced mode", () => {
  const decision = selectWorker({ task: { requires_model_override: true } });
  assert.equal(decision.worker, "codex");
  assert.deepEqual(decision.fallback_chain, ["pi"]);
});

test("unavailable or exhausted preferred worker falls back instead of being blindly retried", () => {
  const unavailable = selectWorker({
    policy: { preferred_worker: "claude" },
    state: { workers: { claude: { availability: "unavailable" } } },
  });
  assert.equal(unavailable.worker, "codex");
  assert.equal(unavailable.rejected.find((item) => item.worker === "claude").reason, "unavailable");

  const exhausted = selectWorker({
    policy: { preferred_worker: "codex" },
    state: { workers: { codex: { availability: "available", budget_pressure: "exhausted" } } },
  });
  assert.equal(exhausted.worker, "claude");
  assert.equal(exhausted.rejected.find((item) => item.worker === "codex").reason, "budget_exhausted");
});

test("failed worker is not selected again in the same fallback decision", () => {
  const decision = selectWorker({ state: { failed_workers: ["claude"] } });
  assert.equal(decision.worker, "codex");
  assert.equal(decision.rejected.find((item) => item.worker === "claude").reason, "previous_attempt_failed");
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

test("Codex quota normalization uses observed remaining percentage only", () => {
  assert.deepEqual(classifyCodexQuota({
    rateLimits: {
      primary: { remainingPercent: 72 },
      secondary: { remainingPercent: 18 },
    },
  }), { pressure: "caution", remaining_percent: 18, source: "codex_rate_limits" });
  assert.equal(classifyCodexQuota({ spendControlReached: true }).pressure, "exhausted");
  assert.equal(classifyCodexQuota({ rateLimits: { primary: { remainingPercent: 6 } } }).pressure, "critical");
  assert.equal(classifyCodexQuota({}).pressure, "unknown");
});

test("post-run cost observation never fabricates unsupported Codex cost", () => {
  assert.equal(observedRunCost("claude", { total_cost_usd: 0.0123 }), 0.0123);
  assert.equal(observedRunCost("pi", { stats: { cost: 0.0042 } }), 0.0042);
  assert.equal(observedRunCost("codex", { total_cost_usd: 999 }), null);
});

test("capability manifest preserves native asymmetry", () => {
  const manifest = capabilityManifest();
  assert.equal(manifest.owner, "supervisor");
  assert.equal(manifest.workers.claude.capabilities.model_override, false);
  assert.equal(manifest.workers.codex.capabilities.quota_probe, true);
  assert.equal(manifest.workers.pi.capabilities.bounded_mutation_scope, true);
});
