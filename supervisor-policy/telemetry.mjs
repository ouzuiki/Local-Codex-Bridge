import {
  TASK_CLASSES,
  SCOPES,
  RISK_CLASSES,
  STAGE_PURPOSES,
  WORKERS,
  ROUTING_REASONS,
  QUOTA_WINDOW_IDS,
  BUDGET_PRESSURE_STATES,
  COST_LATENCY_BANDS,
} from "./policy.mjs";

export const RESULT_STATES = Object.freeze(["success", "failure", "hold"]);
export const COST_BANDS = COST_LATENCY_BANDS;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeMeasurement(raw) {
  return isFiniteNumber(raw) ? { value: raw, source: "native" } : { value: null, source: "unknown" };
}

function normalizeEnum(raw, values, fallback) {
  return values.includes(raw) ? raw : fallback;
}

// Only a known window id (QUOTA_WINDOW_IDS) mapped to a known pressure state
// (BUDGET_PRESSURE_STATES) is admitted; anything else is dropped entirely
// rather than passed through with a sanitized value, since the key itself
// (not just the value) is caller-controlled input.
function normalizeQuotaSnapshot(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const snapshot = {};
  for (const windowId of QUOTA_WINDOW_IDS) {
    const state = raw[windowId];
    if (BUDGET_PRESSURE_STATES.includes(state)) snapshot[windowId] = state;
  }
  return snapshot;
}

/**
 * CR3 privacy-safe telemetry normalizer. Builds a brand new object field by
 * field from an explicit allowlist; it never spreads or copies the raw input,
 * so prompts, tool inputs/outputs, secrets, credentials, and raw event
 * streams are dropped even if present under an unexpected key name.
 */
export function normalizeTelemetryEvent(raw = {}) {
  const value = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  return Object.freeze({
    worker: normalizeEnum(value.worker, WORKERS, "unknown"),
    task_class: normalizeEnum(value.task_class, TASK_CLASSES, "unknown"),
    scope: normalizeEnum(value.scope, SCOPES, "unknown"),
    risk_class: normalizeEnum(value.risk_class, RISK_CLASSES, "unknown"),
    routing_reason: normalizeEnum(value.routing_reason, ROUTING_REASONS, "unknown"),
    stage_purpose: STAGE_PURPOSES.includes(value.stage_purpose) ? value.stage_purpose : null,
    result: normalizeEnum(value.result, RESULT_STATES, "hold"),
    duration_ms: isFiniteNumber(value.duration_ms) && value.duration_ms >= 0 ? value.duration_ms : null,
    retry_count: Number.isInteger(value.retry_count) && value.retry_count >= 0 ? value.retry_count : 0,
    fallback_used: value.fallback_used === true,
    escalation_used: value.escalation_used === true,
    evidence_ready: value.evidence_ready === true,
    decomposed: value.decomposed === true,
    tokens: normalizeMeasurement(value.tokens),
    cost_usd: normalizeMeasurement(value.cost_usd),
    cost_band: normalizeEnum(value.cost_band, COST_BANDS, "unknown"),
    latency_band: normalizeEnum(value.latency_band, COST_BANDS, "unknown"),
    quota_window_snapshot: normalizeQuotaSnapshot(value.quota_window_snapshot),
  });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * CR3 deterministic aggregation over already-normalized telemetry events.
 * Grouping/ordering is fixed by the WORKERS/TASK_CLASSES canonical enums so
 * output order never depends on event arrival order. This does not feed back
 * into routing; it only produces a report shape for a future Worker
 * Economics Dataset.
 */
export function aggregateTelemetry(events = []) {
  const normalized = events.map((event) => normalizeTelemetryEvent(event));
  const groups = new Map();

  for (const event of normalized) {
    const key = `${event.worker}:${event.task_class}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  const report = [];
  for (const worker of WORKERS) {
    for (const taskClass of TASK_CLASSES) {
      const key = `${worker}:${taskClass}`;
      const group = groups.get(key);
      if (!group || group.length === 0) continue;

      const durations = group.map((event) => event.duration_ms).filter((value) => value !== null);
      const knownCosts = group.filter((event) => event.cost_usd.source === "native").map((event) => event.cost_usd.value);
      const knownTokens = group.filter((event) => event.tokens.source === "native").map((event) => event.tokens.value);
      const successCount = group.filter((event) => event.result === "success").length;
      const fallbackCount = group.filter((event) => event.fallback_used).length;
      const escalationCount = group.filter((event) => event.escalation_used).length;

      report.push({
        worker,
        task_class: taskClass,
        count: group.length,
        success_count: successCount,
        success_rate: successCount / group.length,
        fallback_count: fallbackCount,
        fallback_rate: fallbackCount / group.length,
        escalation_count: escalationCount,
        escalation_rate: escalationCount / group.length,
        mean_duration_ms: mean(durations),
        median_duration_ms: median(durations),
        known_cost_usd_sum: knownCosts.length > 0 ? knownCosts.reduce((sum, value) => sum + value, 0) : null,
        known_cost_event_count: knownCosts.length,
        unknown_cost_event_count: group.length - knownCosts.length,
        known_tokens_sum: knownTokens.length > 0 ? knownTokens.reduce((sum, value) => sum + value, 0) : null,
        unknown_tokens_event_count: group.length - knownTokens.length,
      });
    }
  }

  return report;
}
