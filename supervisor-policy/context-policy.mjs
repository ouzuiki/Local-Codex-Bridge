import catalogDefaults from "./skill-catalog.json" with { type: "json" };
import { evaluateRecallPolicy } from "./memory-policy.mjs";

const WORKERS = new Set(["claude", "codex", "pi"]);

export const CONTEXT_AUTHORITY = Object.freeze([
  "security_hard_runtime",
  "task_and_project_contract",
  "verified_current_evidence",
  "skill_procedure",
  "advisory_memory",
  "historical_raw_context",
]);

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function stringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function normalizeSkill(skill) {
  const value = requireObject(skill, "skill");
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new TypeError("skill.id must be a non-empty string");
  }
  const covers = stringArray(value.covers, `skill ${value.id}.covers`);
  if (covers.length === 0) throw new TypeError(`skill ${value.id}.covers must not be empty`);
  const loadMode = value.load_mode ?? "on_demand";
  if (loadMode !== "on_demand") {
    throw new TypeError(`skill ${value.id}.load_mode must be on_demand`);
  }
  const workers = value.workers === undefined ? ["*"] : stringArray(value.workers, `skill ${value.id}.workers`);
  for (const worker of workers) {
    if (worker !== "*" && !WORKERS.has(worker)) {
      throw new TypeError(`skill ${value.id} contains unknown worker ${worker}`);
    }
  }
  const priority = value.priority ?? 0;
  if (!Number.isFinite(priority)) throw new TypeError(`skill ${value.id}.priority must be numeric`);
  return {
    id: value.id,
    covers,
    workers,
    load_mode: loadMode,
    priority,
    authority: value.authority ?? "procedure",
    source: value.source ?? null,
  };
}

function compatible(skill, worker) {
  return skill.workers.includes("*") || skill.workers.includes(worker);
}

export function selectMinimalSkills({
  worker,
  required_skill_classes = [],
  requested_skill_ids = [],
  available_skills = catalogDefaults.skills,
} = {}) {
  if (!WORKERS.has(worker)) throw new TypeError("worker must be claude, codex, or pi");
  const required = stringArray(required_skill_classes, "required_skill_classes");
  const requested = stringArray(requested_skill_ids, "requested_skill_ids");
  if (!Array.isArray(available_skills)) throw new TypeError("available_skills must be an array");

  const skills = available_skills.map(normalizeSkill);
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const selected = [];
  const selectedIds = new Set();
  const unresolvedSkillIds = [];

  for (const id of requested) {
    const skill = byId.get(id);
    if (!skill || !compatible(skill, worker)) {
      unresolvedSkillIds.push(id);
      continue;
    }
    if (!selectedIds.has(id)) {
      selected.push(skill);
      selectedIds.add(id);
    }
  }

  const covered = new Set(selected.flatMap((skill) => skill.covers));
  const remaining = new Set(required.filter((item) => !covered.has(item)));

  while (remaining.size > 0) {
    const ranked = skills
      .filter((skill) => !selectedIds.has(skill.id) && compatible(skill, worker))
      .map((skill) => ({
        skill,
        overlap: skill.covers.filter((item) => remaining.has(item)).length,
      }))
      .filter((entry) => entry.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || b.skill.priority - a.skill.priority || a.skill.id.localeCompare(b.skill.id));

    const best = ranked[0]?.skill;
    if (!best) break;
    selected.push(best);
    selectedIds.add(best.id);
    for (const item of best.covers) remaining.delete(item);
  }

  const unresolvedClasses = [...remaining].sort();
  return {
    action: unresolvedSkillIds.length === 0 && unresolvedClasses.length === 0 ? "ready" : "needs_skill_resolution",
    selected_skill_ids: selected.map((skill) => skill.id),
    unresolved_skill_ids: unresolvedSkillIds,
    unresolved_skill_classes: unresolvedClasses,
    loader_owner: "native_worker",
    selection_principle: "minimum_sufficient_context",
  };
}

export function selectContextPlan({
  worker,
  project_contract_present = true,
  native_session_active = false,
  required_skill_classes = [],
  requested_skill_ids = [],
  available_skills = catalogDefaults.skills,
  memory_recall = {},
  evidence = [],
} = {}) {
  if (!WORKERS.has(worker)) throw new TypeError("worker must be claude, codex, or pi");
  if (typeof project_contract_present !== "boolean") throw new TypeError("project_contract_present must be boolean");
  if (typeof native_session_active !== "boolean") throw new TypeError("native_session_active must be boolean");

  const skills = selectMinimalSkills({ worker, required_skill_classes, requested_skill_ids, available_skills });
  const memory = evaluateRecallPolicy({
    project_scoped: memory_recall.project_scoped ?? true,
    fresh_run: memory_recall.fresh_run ?? !native_session_active,
    user_requested: memory_recall.user_requested === true,
    continues_prior_work: memory_recall.continues_prior_work === true,
    multi_step_project_work: memory_recall.multi_step_project_work === true,
    architecture_or_business_rule_sensitive: memory_recall.architecture_or_business_rule_sensitive === true,
    cross_worker_handoff: memory_recall.cross_worker_handoff === true,
    prior_root_cause_or_sop_likely_relevant: memory_recall.prior_root_cause_or_sop_likely_relevant === true,
  });
  const normalizedEvidence = stringArray(evidence, "evidence");
  const blockers = [];
  if (!project_contract_present) blockers.push("project_contract_missing");
  if (skills.action !== "ready") blockers.push("skill_resolution_required");

  return {
    action: blockers.length === 0 ? "ready" : "blocked",
    blockers,
    worker,
    project_contract: project_contract_present ? { mode: "native", authority: "project" } : { mode: "missing", authority: "project" },
    native_session_history: native_session_active ? "native_active" : "native_new",
    advisory_memory: memory,
    skills,
    evidence: normalizedEvidence,
    authority: [...CONTEXT_AUTHORITY],
    loader_owner: "native_worker",
  };
}

const RANK = new Map(CONTEXT_AUTHORITY.map((source, index) => [source, index]));

export function resolveContextConflict({ left_source, right_source } = {}) {
  if (!RANK.has(left_source) || !RANK.has(right_source)) {
    throw new TypeError(`context sources must be one of: ${CONTEXT_AUTHORITY.join(", ")}`);
  }
  if (left_source === right_source) return { action: "same_authority", winner: null };
  if (left_source === "task_and_project_contract" || right_source === "task_and_project_contract") {
    const other = left_source === "task_and_project_contract" ? right_source : left_source;
    if (other === "security_hard_runtime") {
      return { action: "resolved", winner: "security_hard_runtime" };
    }
    if (other === "task_and_project_contract") {
      return { action: "same_authority", winner: null };
    }
  }
  const leftRank = RANK.get(left_source);
  const rightRank = RANK.get(right_source);
  return leftRank < rightRank
    ? { action: "resolved", winner: left_source }
    : { action: "resolved", winner: right_source };
}

export function resolveTaskContractConflict() {
  return {
    action: "supervisor_resolution_required",
    reason: "current_task_and_project_contract_are_both_authoritative_inputs_and_must_not_be_silently_overridden",
  };
}
