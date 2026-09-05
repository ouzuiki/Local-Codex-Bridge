import assert from "node:assert/strict";
import test from "node:test";

import { aggregateTelemetry, normalizeTelemetryEvent } from "./telemetry.mjs";

// All string values below are synthetic placeholders describing what kind of
// unsafe content a field represents; none are real prompts, commands, or
// credentials. The point of the fixture is that normalizeTelemetryEvent must
// drop every field outside its explicit allowlist, whatever it is named or
// contains.
const UNSAFE_RAW_EVENT = {
  worker: "codex",
  task_class: "general_engineering",
  scope: "small",
  risk_class: "broad_mutation",
  routing_reason: "policy_general_engineering",
  stage_purpose: "evidence_acquisition",
  result: "success",
  duration_ms: 4200,
  retry_count: 1,
  fallback_used: false,
  escalation_used: false,
  evidence_ready: true,
  decomposed: false,
  tokens: 1234,
  cost_usd: 0.05,
  cost_band: "low",
  latency_band: "medium",
  quota_window_snapshot: { primary: "normal", secondary: "caution" },
  // fields below must never survive normalization
  raw_prompt_field: "PLACEHOLDER_PROMPT_TEXT",
  raw_system_prompt_field: "PLACEHOLDER_SYSTEM_PROMPT_TEXT",
  raw_tool_input_field: { shape: "PLACEHOLDER_TOOL_INPUT_SHAPE" },
  raw_tool_output_field: "PLACEHOLDER_TOOL_OUTPUT_TEXT",
  raw_event_stream_field: { type: "message", content: [{ text: "PLACEHOLDER_EVENT_TEXT" }] },
  raw_transcript_field: ["PLACEHOLDER_TRANSCRIPT_LINE_ONE", "PLACEHOLDER_TRANSCRIPT_LINE_TWO"],
  raw_messages_field: [{ role: "user", content: "PLACEHOLDER_MESSAGE_TEXT" }],
  unsafe_credential_like_field: "PLACEHOLDER_UNSAFE_VALUE",
  raw_env_field: { HOME: "/home/example-user" },
  raw_stdout_field: "PLACEHOLDER_STDOUT_TEXT",
  raw_stderr_field: "",
  raw_cwd_field: "/home/example-user/projects/example-client",
  raw_args_field: ["--flag", "value"],
};

test("normalizeTelemetryEvent keeps only the allowlisted fields and drops every raw/unlisted field", () => {
  const normalized = normalizeTelemetryEvent(UNSAFE_RAW_EVENT);

  const unsafeKeys = [
    "raw_prompt_field",
    "raw_system_prompt_field",
    "raw_tool_input_field",
    "raw_tool_output_field",
    "raw_event_stream_field",
    "raw_transcript_field",
    "raw_messages_field",
    "unsafe_credential_like_field",
    "raw_env_field",
    "raw_stdout_field",
    "raw_stderr_field",
    "raw_cwd_field",
    "raw_args_field",
  ];
  for (const key of unsafeKeys) {
    assert.equal(Object.hasOwn(normalized, key), false, `normalized event must not carry raw field '${key}'`);
  }

  assert.deepEqual(Object.keys(normalized).sort(), [
    "cost_band",
    "cost_usd",
    "decomposed",
    "duration_ms",
    "escalation_used",
    "evidence_ready",
    "fallback_used",
    "latency_band",
    "quota_window_snapshot",
    "result",
    "retry_count",
    "risk_class",
    "routing_reason",
    "scope",
    "stage_purpose",
    "task_class",
    "tokens",
    "worker",
  ].sort());

  assert.equal(normalized.worker, "codex");
  assert.equal(normalized.task_class, "general_engineering");
  assert.equal(normalized.stage_purpose, "evidence_acquisition");
  assert.deepEqual(normalized.tokens, { value: 1234, source: "native" });
  assert.deepEqual(normalized.cost_usd, { value: 0.05, source: "native" });
  assert.deepEqual(normalized.quota_window_snapshot, { primary: "normal", secondary: "caution" });
});

test("normalizeTelemetryEvent marks missing cost/token/enum fields as unknown rather than fabricating values", () => {
  const normalized = normalizeTelemetryEvent({ worker: "pi", task_class: "extension_capability" });
  assert.deepEqual(normalized.tokens, { value: null, source: "unknown" });
  assert.deepEqual(normalized.cost_usd, { value: null, source: "unknown" });
  assert.equal(normalized.cost_band, "unknown");
  assert.equal(normalized.latency_band, "unknown");
  assert.equal(normalized.scope, "unknown");
  assert.equal(normalized.stage_purpose, null);
  assert.equal(normalized.duration_ms, null);
  assert.equal(normalized.routing_reason, "unknown");
  assert.deepEqual(normalized.quota_window_snapshot, {});
});

test("normalizeTelemetryEvent rejects unsafe worker/task_class/result values by falling back to a safe default", () => {
  const normalized = normalizeTelemetryEvent({
    worker: "PLACEHOLDER_INJECTION_ATTEMPT_ONE",
    task_class: "PLACEHOLDER_INJECTION_ATTEMPT_TWO",
    result: "definitely-not-a-real-result",
  });
  assert.equal(normalized.worker, "unknown");
  assert.equal(normalized.task_class, "unknown");
  assert.equal(normalized.result, "hold");
});

test("normalizeTelemetryEvent reduces an arbitrary routing_reason to 'unknown' instead of passing it through", () => {
  const withArbitraryReason = normalizeTelemetryEvent({
    routing_reason: "PLACEHOLDER_ARBITRARY_FREEFORM_REASON_TEXT",
  });
  assert.equal(withArbitraryReason.routing_reason, "unknown");

  // Only the closed set the router can actually emit is accepted verbatim.
  const withRealReason = normalizeTelemetryEvent({ routing_reason: "policy_expert_review" });
  assert.equal(withRealReason.routing_reason, "policy_expert_review");
});

test("normalizeTelemetryEvent drops quota_window_snapshot entries with an unknown window id or an unsafe state value", () => {
  const normalized = normalizeTelemetryEvent({
    quota_window_snapshot: {
      primary: "normal",
      // unknown window id must be dropped even though its value looks valid
      unknown_window_id: "exhausted",
      // known window id with an unsafe/arbitrary state must be dropped
      secondary: "PLACEHOLDER_ARBITRARY_STATE_TEXT",
    },
  });
  assert.deepEqual(normalized.quota_window_snapshot, { primary: "normal" });
});

test("aggregateTelemetry groups deterministically by worker+task_class regardless of input order", () => {
  const events = [
    { worker: "codex", task_class: "general_engineering", result: "success", duration_ms: 100, cost_usd: 0.1 },
    { worker: "codex", task_class: "general_engineering", result: "failure", duration_ms: 300 },
    { worker: "claude", task_class: "expert_review", result: "success", duration_ms: 200, fallback_used: true },
  ];
  const reversedEvents = [...events].reverse();

  const report = aggregateTelemetry(events);
  const reversedReport = aggregateTelemetry(reversedEvents);
  assert.deepEqual(report, reversedReport);

  const codexRow = report.find((row) => row.worker === "codex" && row.task_class === "general_engineering");
  assert.equal(codexRow.count, 2);
  assert.equal(codexRow.success_count, 1);
  assert.equal(codexRow.success_rate, 0.5);
  assert.equal(codexRow.mean_duration_ms, 200);
  assert.equal(codexRow.median_duration_ms, 200);
  assert.equal(codexRow.known_cost_usd_sum, 0.1);
  assert.equal(codexRow.known_cost_event_count, 1);
  assert.equal(codexRow.unknown_cost_event_count, 1);

  const claudeRow = report.find((row) => row.worker === "claude" && row.task_class === "expert_review");
  assert.equal(claudeRow.fallback_count, 1);
  assert.equal(claudeRow.fallback_rate, 1);
});

test("aggregateTelemetry never includes raw event content in its report", () => {
  const report = aggregateTelemetry([{ ...UNSAFE_RAW_EVENT }]);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("PLACEHOLDER_TOOL_INPUT_SHAPE"), false);
  assert.equal(serialized.includes("PLACEHOLDER_UNSAFE_VALUE"), false);
  assert.equal(serialized.includes("PLACEHOLDER_EVENT_TEXT"), false);
});

test("aggregateTelemetry produces no rows for an empty event list", () => {
  assert.deepEqual(aggregateTelemetry([]), []);
});
