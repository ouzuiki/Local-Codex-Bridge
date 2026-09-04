# REF-05 — Context / Skill Loading Crosswalk

**Status:** CLOSED / PASS  
**Audit date:** 2026-09-04  
**Primary references:** Google Agents CLI Skills, current Tri-Bridge Context Contract, P3 memory policy

REF-05 asks how to make context/Skill use more deliberate without replacing native Worker context loading with a universal Bridge/Supervisor loader.

## REF-05A — Context Layer / Authority Crosswalk

The current system has distinct context classes with different owners:

```text
current task                 Supervisor / user
project contract             project / AGENTS.md
native session history       native Worker
skill / procedure context    project/native Worker
advisory memory              TencentDB / Supervisor policy
current evidence             current execution/repository facts
```

Google Agents CLI Skills reinforce the same architectural idea: coding agents receive domain-specific guidance as Skills, rather than one monolithic universal prompt. Some workflow guidance may be broadly active while specialist knowledge remains modular.

### Frozen context rules

1. `AGENTS.md` remains the project contract SSOT and is loaded through native Worker mechanisms.
2. Claude keeps the thin `CLAUDE.md → @AGENTS.md` shim; no duplicate contract content is introduced.
3. Native session history remains Worker-owned.
4. Skills are task/procedure context and load on demand.
5. TencentDB memory remains advisory and selective.
6. Current verified evidence outranks stale procedure/memory claims about current repository state.
7. No Bridge recursively scans context/skill files.

Authority classes:

```text
security / hard runtime
        ↓
current task + project contract
        ↓
verified current evidence
        ↓
skill / procedure
        ↓
advisory memory
        ↓
historical/raw context
```

Current task and project contract are both authoritative inputs. A direct conflict between them must be adjudicated by the Supervisor; it is never silently resolved by a generic precedence rule.

**REF-05A decision:** `PASS`.

---

## REF-05B — Skill Catalog v1

Implementation:

```text
supervisor-policy/skill-catalog.json
```

The catalog intentionally stores **metadata only**. It does not centralize Skill contents.

Frozen metadata contract:

```text
id
covers[]
load_mode = on_demand
workers[] optional
priority optional
authority optional
source optional
```

Current canonical catalog contains no global Skill inventory:

```text
skills = []
```

That is deliberate. Concrete Skills remain project-owned/native-worker-visible. Projects may supply their own catalog entries to the policy without moving Skill text into this architecture repository.

Loader ownership is frozen as:

```text
loader_owner = native_worker
```

**REF-05B decision:** `PASS`.

---

## REF-05C — Context Selection + Collision Policy v1

Implementation:

```text
supervisor-policy/context-policy.mjs
```

The policy is non-executing. It produces a context plan but does not read arbitrary files, mutate prompts, or invoke a Worker.

### Minimum Sufficient Context

Skill selection uses explicit procedure requirements supplied by the Supervisor:

```text
required_skill_classes
requested_skill_ids
available_skills
worker
```

It then selects the smallest compatible Skill set that covers those required classes.

It does **not** infer that every task class needs a Skill, and it does **not** load every available Skill.

If a requested/required Skill is unavailable or incompatible:

```text
action = needs_skill_resolution
```

The policy fails closed instead of scanning the filesystem or guessing a substitute.

### Context plan

`selectContextPlan()` returns:

- project contract mode/authority;
- native session state;
- P3 advisory-memory recall decision;
- selected Skill IDs;
- unresolved Skill requirements;
- current evidence labels;
- context authority classes;
- native loader ownership.

It never returns Skill contents or a constructed universal prompt.

### Collision policy

Examples:

```text
project contract vs advisory memory
→ project contract wins

verified current evidence vs stale Skill procedure claim
→ verified current evidence wins for current factual state

security/hard runtime vs any lower context
→ security/hard runtime wins

current task vs project contract direct conflict
→ Supervisor resolution required
```

This prevents old memory or procedure text from silently overriding current project rules/evidence.

**REF-05C decision:** `PASS`.

---

## REF-05D — Tri-worker Context / Skill Regression

Permanent regression:

```text
supervisor-policy/ref-p1.test.mjs
```

It is included in normal `npm test` and covers:

- metadata-only Skill catalog;
- native Worker loader ownership;
- minimum Skill selection;
- irrelevant Skills are not loaded;
- incompatible/missing Skills fail closed;
- project contract is required;
- resumed native sessions skip duplicate external memory recall;
- fresh project work may selectively recall advisory memory;
- Skill/Memory cannot override contract/current evidence;
- task/project-contract conflicts require Supervisor adjudication.

The pre-existing tri-worker `AGENTS.md` context regression remains unchanged and continues to validate native project-context loading.

### Permanent CI evidence

Implementation/documentation head validated:

```text
e0b23bd85faac6a775c129178838a3479c15f998
```

CI run:

```text
33820517914
```

Result:

```text
Verify (macOS / Node 24)   SUCCESS
Verify (Windows / Node 24) SUCCESS
```

Both jobs completed dependency installation, typecheck, build, and the full test suite successfully.

**REF-05D decision:** `PASS / CLOSED`.

---

## REF-05 final decision

```text
REF-05A Context authority crosswalk       PASS
REF-05B Skill Catalog v1                  PASS
REF-05C Context Selection Policy          PASS
REF-05D deterministic regression          PASS / CLOSED

universal context loader                  NO
central Skill-content store               NO
Bridge context scanning                   NO
native loader ownership                   PRESERVED
advisory memory authority                 PRESERVED
blocking gaps remaining                   0
unknown findings remaining                0
```

# REF-05: CLOSED / PASS
