import baseline from "./contract-watch-baseline.json" with { type: "json" };

export const WATCH_STATES = Object.freeze(["stable", "additive", "breaking", "unknown", "not_applicable"]);

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireWorker(worker) {
  if (!Object.hasOwn(baseline.workers, worker)) {
    throw new TypeError(`worker must be one of: ${Object.keys(baseline.workers).join(", ")}`);
  }
  return worker;
}

function requireWatchState(value, label) {
  if (!WATCH_STATES.includes(value)) {
    throw new TypeError(`${label} must be one of: ${WATCH_STATES.join(", ")}`);
  }
  return value;
}

function normalizeTests(value) {
  if (value === undefined) return "not_run";
  if (!new Set(["passed", "failed", "not_run"]).has(value)) {
    throw new TypeError("tests must be passed, failed, or not_run");
  }
  return value;
}

export function assessContractWatch({ worker, native_version_changed = false, tests, domains = {} } = {}) {
  const normalizedWorker = requireWorker(worker);
  const workerBaseline = baseline.workers[normalizedWorker];
  const domainInput = requireObject(domains, "domains");
  const normalizedTests = normalizeTests(tests);
  const normalizedDomains = {};
  const missingRequired = [];

  for (const domain of baseline.domains) {
    const required = workerBaseline.required.includes(domain);
    const optional = workerBaseline.optional?.includes(domain) ?? false;
    const raw = domainInput[domain];

    if (raw === undefined) {
      if (required) missingRequired.push(domain);
      normalizedDomains[domain] = optional ? "not_applicable" : "unknown";
      continue;
    }

    const state = requireWatchState(raw, `domains.${domain}`);
    if (required && state === "not_applicable") {
      throw new TypeError(`domains.${domain} cannot be not_applicable for ${normalizedWorker}`);
    }
    normalizedDomains[domain] = state;
  }

  const breakingDomains = Object.entries(normalizedDomains)
    .filter(([, state]) => state === "breaking")
    .map(([domain]) => domain);
  const unknownRequired = workerBaseline.required.filter((domain) => normalizedDomains[domain] === "unknown");
  const additiveDomains = Object.entries(normalizedDomains)
    .filter(([, state]) => state === "additive")
    .map(([domain]) => domain);

  if (breakingDomains.length > 0) {
    return {
      worker: normalizedWorker,
      action: "patch_contract_seam",
      severity: "blocking",
      reason: "breaking_contract_seam_observed",
      changed_domains: breakingDomains,
      allowed_fix_scope: "adapter_contract_seam_only",
      tests: normalizedTests,
    };
  }

  if (normalizedTests === "failed") {
    return {
      worker: normalizedWorker,
      action: "probe_contract_seam",
      severity: "blocking",
      reason: "conformance_regression_failed",
      changed_domains: additiveDomains,
      unknown_domains: unknownRequired,
      allowed_fix_scope: "diagnose_before_patch",
      tests: normalizedTests,
    };
  }

  if (missingRequired.length > 0 || unknownRequired.length > 0) {
    return {
      worker: normalizedWorker,
      action: "probe_contract_seam",
      severity: "review",
      reason: "required_watch_domain_unverified",
      unknown_domains: [...new Set([...missingRequired, ...unknownRequired])],
      allowed_fix_scope: "no_patch_until_evidence",
      tests: normalizedTests,
    };
  }

  if (normalizedTests !== "passed" && (native_version_changed || additiveDomains.length > 0)) {
    return {
      worker: normalizedWorker,
      action: "run_conformance_tests",
      severity: "review",
      reason: "native_change_requires_regression_evidence",
      changed_domains: additiveDomains,
      allowed_fix_scope: "no_patch_until_evidence",
      tests: normalizedTests,
    };
  }

  if (native_version_changed || additiveDomains.length > 0) {
    return {
      worker: normalizedWorker,
      action: "observe_only",
      severity: "info",
      reason: "native_change_without_contract_break",
      changed_domains: additiveDomains,
      allowed_fix_scope: "none",
      tests: normalizedTests,
    };
  }

  return {
    worker: normalizedWorker,
    action: "pass",
    severity: "none",
    reason: "contract_seam_stable",
    changed_domains: [],
    allowed_fix_scope: "none",
    tests: normalizedTests,
  };
}

export function contractWatchBaseline() {
  return structuredClone(baseline);
}
