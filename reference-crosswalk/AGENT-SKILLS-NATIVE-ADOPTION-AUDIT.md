# Agent Skills Native Adoption Audit

**Status:** COMPLETE — ONE ADOPTION GAP OPEN  
**Date:** 2026-09-04  
**Baseline:** `932751f6fa91af57f4f9ed78a584aeeb96070ada` (`REF-P1 CLOSED`)  
**Scope:** Codex/LCB, Claude Code/LClB, Pi/LPB, and the existing `pet-hotel-manager` project Skill layout.

## Question

Can the tri-Worker system adopt native Agent Skills loading and routing from Codex, Claude Code and Pi, with one shared project Skill source of truth, instead of growing the REF-05 Supervisor Skill catalog into a production Skill router/loader?

## Executive decision

Yes, with one current LPB compatibility gap.

```text
Agent Skills format                     ADOPT
Shared project Skill content SSOT       ADOPT `.agents/skills/**/SKILL.md`
Codex Skill discovery/routing           ADOPT NATIVE — READY
Claude Skill discovery/routing          ADOPT NATIVE — READY AFTER PATH ALIAS
Pi Skill discovery/routing              ADOPT NATIVE — BLOCKED BY CURRENT LPB FLAGS/SCOPE
Supervisor production Skill router      DO NOT BUILD
Bridge Skill filesystem scanner         DO NOT BUILD
Centralized Skill-content store         DO NOT BUILD
```

The existing REF-05 `skill-catalog.json` and `selectMinimalSkills()` remain useful as schema/regression/reference policy, but they must not grow into the production discovery/loading mechanism. Native harnesses own Skill discovery, description-based routing and progressive loading.

## Native reference model

All three Workers now converge on the Agent Skills `SKILL.md` model:

```text
skill directory
├── SKILL.md
├── references/   optional
├── scripts/      optional
└── assets/       optional
```

The important runtime pattern is progressive disclosure:

```text
startup
  ↓
scan Skill metadata (name + description)
  ↓
model/task match
  ↓
load full SKILL.md only when needed
  ↓
load supporting files on demand
```

This is the exact capability REF-05 should adopt rather than reproduce in Supervisor policy.

## Current project evidence

`ouzuiki/pet-hotel-manager` already has the intended canonical Skill source:

```text
.agents/skills/
├── booking-domain-guardian/
├── regression-qa/
├── saas-ui-design/
└── supabase-change-safety/
```

The checked Skill files use `SKILL.md` with Agent Skills-style frontmatter. This means the project does not need a new Skill repository or centralized Skill-content catalog.

Recommended project SSOT:

```text
pet-hotel-manager/.agents/skills/**/SKILL.md
```

## Codex / LCB

### Native capability

Current Codex documentation says repository Skills are discovered from `.agents/skills` from CWD through repository root. Codex uses progressive disclosure and supports symlinked Skill directories.

### Bridge evidence

LCB starts the normal Codex `app-server` and does not pass a Skill-disabling flag or replace Codex's native resource loader.

### Adjudication

```text
classification = MATCH
native_skill_owner = Codex
bridge_change_required = NO
project_change_required = NO
operational_state = READY
```

`pet-hotel-manager/.agents/skills` is already the native Codex project location.

## Claude Code / LClB

### Native capability

Claude Code project Skills live under `.claude/skills/<skill-name>/SKILL.md`. Current Claude Code supports per-Skill directory symlinks and follows the symlink target. Claude decides when to load a Skill from its description and loads the full instructions on demand.

### Bridge evidence

LClB starts normal `claude -p` with the project `cwd` and does not disable Skills or replace Claude's native loader.

### Project asymmetry

The shared SSOT is `.agents/skills`, while Claude's native project path is `.claude/skills`.

Do not duplicate Skill contents. Use thin project-owned aliases:

```text
.claude/skills/booking-domain-guardian -> ../../.agents/skills/booking-domain-guardian
.claude/skills/regression-qa           -> ../../.agents/skills/regression-qa
.claude/skills/saas-ui-design          -> ../../.agents/skills/saas-ui-design
.claude/skills/supabase-change-safety  -> ../../.agents/skills/supabase-change-safety
```

### Adjudication

```text
classification = INTENTIONAL_ASYMMETRY
native_skill_owner = Claude Code
bridge_change_required = NO
project_adapter = per-Skill symlink aliases
operational_state = READY_AFTER_PROJECT_ALIAS
```

The alias is packaging, not a second loader and not duplicated procedure content.

## Pi / LPB

### Native capability

Upstream Pi implements Agent Skills and natively supports `.agents/skills`. Its Skill docs specify progressive disclosure: metadata is scanned first, and when a Skill matches the task Pi uses its `read` tool to load the full `SKILL.md`. Pi also supports explicit `--skill <path>` paths, additive even when automatic discovery is disabled with `--no-skills`.

Pi project-local Skill auto-discovery is also subject to Pi project trust. In non-interactive RPC mode, an unresolved project trust decision does not show an interactive prompt.

### Current Bridge evidence

Current LPB `pi_start` passes:

```text
--no-skills
--no-prompt-templates
```

The LPB regression suite explicitly expects `--no-skills` in both read and coding modes.

Therefore upstream Pi's native Skill capability exists, but the current LPB execution chain intentionally suppresses it.

There is a second safety interaction: LPB's read-scope extension blocks `read` outside the explicitly allowed task read scope. Because Pi loads the full `SKILL.md` through the native `read` tool, simply removing `--no-skills` is not sufficient to guarantee a usable Skill path; Skill procedure files also need a narrowly defined read authorization compatible with LPB's safety model.

### Adjudication

```text
classification = CONFIRMED_GAP
finding = LPB suppresses Pi native Agent Skills
native_skill_owner = Pi
bridge_ownership = native-context compatibility + safety shim only
bridge_change_required = YES
contract_v1_change_required = NO
operational_state = BLOCKED_PENDING_MINIMAL_REPAIR
```

This is the same class of boundary problem as the historical `--no-context-files` incident: a Bridge-specific launch policy is suppressing a native context capability that the architecture intends the Worker to own.

## LPB repair constraints

The repair must NOT turn LPB into a Skill router or loader.

Required properties:

1. Pi remains the component that discovers Skill metadata, chooses a Skill, and loads it progressively.
2. Ambient user/global Skill loading must not silently broaden LPB's current security model.
3. Do not use broad `--approve` merely to make project Skills visible; Pi project trust also governs other project resources/settings/extensions.
4. LPB may provide only the minimum context-bootstrap compatibility and read-safety allowance necessary for reviewed project-owned Skills.
5. Mutation scope remains unchanged; Skills do not gain write authority.
6. No Supervisor-maintained production Skill inventory is introduced.
7. Add deterministic regression proving LPB no longer suppresses the intended native Skill path while preserving read/mutation safety.
8. Add a live native Pi smoke only if deterministic tests cannot prove the affected resource-loading seam.

A promising upstream-supported pattern is to keep ambient discovery controlled while using explicit project Skill resource paths (`--no-skills` plus `--skill <path>`), because Pi documents that explicit Skill paths remain additive when discovery is disabled. The exact LPB implementation should be selected only after validating how the current Pi build resolves the project Skill directory and how the read-scope extension should authorize procedure reads without granting arbitrary repository reads.

## Shared SSOT decision

The canonical project pattern is:

```text
.agents/skills/**/SKILL.md       authoritative Skill content

Codex
  └─ reads `.agents/skills` natively

Pi
  └─ reads `.agents/skills` natively after LPB compatibility repair

Claude Code
  └─ `.claude/skills/<name>` symlink aliases to `.agents/skills/<name>`
```

This keeps one content copy and lets each native harness retain its own discovery and invocation semantics.

## REF-05 interpretation after this audit

REF-05 remains valid for:

```text
context authority ordering
project-contract presence
memory recall policy integration
current-evidence precedence
fail-closed conflict semantics
```

The following REF-05 mechanism is now explicitly bounded:

```text
skill-catalog.json
selectMinimalSkills()
```

It is a schema/regression/reference mechanism, not the production Skill discovery/loading owner.

Do not extend it into:

```text
Skill Registry
filesystem scanner
semantic Skill router
Skill synchronizer
Skill content loader
```

Default production routing belongs to each native Worker using the Skill descriptions in the project SSOT. Supervisor may still explicitly request a named Skill when task semantics require an override.

## Findings

| ID | Finding | Classification | Action |
|---|---|---|---|
| NSA-01 | Agent Skills `SKILL.md` is the converged native procedure format | MATCH | ADOPT |
| NSA-02 | `pet-hotel-manager/.agents/skills` already provides a shared project Skill SSOT | MATCH | KEEP |
| NSA-03 | LCB preserves Codex native `.agents/skills` loading | MATCH | KEEP |
| NSA-04 | LClB preserves Claude native Skill loading, but Claude needs `.claude/skills` path aliases | INTENTIONAL_ASYMMETRY | add project-owned symlink aliases |
| NSA-05 | LPB passes `--no-skills`, suppressing Pi native Agent Skills | CONFIRMED_GAP | minimal LPB compatibility repair |
| NSA-06 | LPB read-scope can block Pi's on-demand `SKILL.md` read | CONFIRMED_GAP | repair together with NSA-05; do not broaden mutation authority |
| NSA-07 | Supervisor production Skill routing would duplicate native harness capability | NOT_APPLICABLE | DO NOT BUILD |

## Audit closeout

```text
Codex native adoption              READY
Claude native adoption             READY AFTER PROJECT SYMLINK ALIASES
Pi native adoption                 BLOCKED — CONFIRMED LPB GAP
shared Skill-content SSOT          PROVEN: `.agents/skills`
new Skill Registry                 NO
new universal Skill loader         NO
new Supervisor Skill router        NO
Tri-Bridge Contract v1 change      NO

AUDIT STATUS: COMPLETE
ADOPTION STATUS: PARTIAL — LPB REPAIR REQUIRED
```

The next implementation task, if approved, is a narrowly scoped **LPB Native Skills Compatibility Repair** plus project-level Claude symlink aliases. It must not introduce a new generic context/Skill runtime.