# Agent Skills Native Adoption Closeout

**Status:** CLOSED  
**Date:** 2026-09-04  
**Audit baseline:** `932751f6fa91af57f4f9ed78a584aeeb96070ada` (`REF-P1 CLOSED`)  
**Audit record:** `AGENT-SKILLS-NATIVE-ADOPTION-AUDIT.md`

## Final decision

```text
Agent Skills / SKILL.md                 ADOPT
shared project Skill-content SSOT       `.agents/skills/**/SKILL.md`
Codex discovery/loading                 NATIVE — READY
Claude discovery/loading                NATIVE — READY via project symlink aliases
Pi discovery/loading                    NATIVE — READY after LPB compatibility repair
Supervisor production Skill router      DO NOT BUILD
Bridge Skill filesystem scanner         DO NOT BUILD
central Skill-content store             DO NOT BUILD
```

The original audit correctly classified the LPB suppression/read-scope seam as `CONFIRMED_GAP`. The classification is retained; the gap is now `REPAIRED`.

## SKILL-1 — Claude native Skill aliases

Repository: `ouzuiki/pet-hotel-manager`

Authoritative Skill content remains:

```text
.agents/skills/
├── booking-domain-guardian/
├── regression-qa/
├── saas-ui-design/
└── supabase-change-safety/
```

Commit `b57885740f996617ed3af7fdd633708d096c2ffc` added real Git symlinks (mode `120000`):

```text
.claude/skills/booking-domain-guardian -> ../../.agents/skills/booking-domain-guardian
.claude/skills/regression-qa           -> ../../.agents/skills/regression-qa
.claude/skills/saas-ui-design          -> ../../.agents/skills/saas-ui-design
.claude/skills/supabase-change-safety  -> ../../.agents/skills/supabase-change-safety
```

No Skill contents were copied.

**Result:** PASS.

## SKILL-2 — LPB native Skills compatibility repair

Repository: `ouzuiki/Local-Pi-Bridge`

Implementation commit: `043f5d374536c5f4c1df57cf362833c8502248a8`  
Regression commit: `d5a03b1a0f420fe5ea6037b80978a7e06449993b`

The repair deliberately keeps:

```text
--no-skills
```

so ambient/global automatic discovery remains suppressed by LPB. Instead, the already-loaded LPB read-scope extension uses Pi's native `resources_discover` seam to publish only the canonical project root when `cwd/.agents/skills` exists and resolves inside the project cwd:

```text
resources_discover
  -> skillPaths: [<cwd>/.agents/skills]
```

The same safety shim admits read-only access to that canonical project Skill root so Pi's native progressive `read SKILL.md` path works. Caller readScope remains required, mutationScope is unchanged, and LPB does not parse/rank/select Skill contents.

Permanent regression covers:

- project Skill root is published and readable;
- unrelated files remain denied;
- no Skill root preserves original read scope;
- cwd mismatch never exposes Skills.

Permanent LPB CI on the repair/regression head passed.

**Result:** PASS.

## SKILL-3 — tri-worker native loader smoke

One-time live loader smoke was intentionally run with real native CLIs/harnesses, then removed from the repositories so routine CI does not permanently install all three coding harnesses.

### Codex

`pet-hotel-manager` workflow run `33824896492` installed current Codex and called native app-server `skills/list` with the repository cwd. Codex returned all four project Skills.

```text
booking-domain-guardian
regression-qa
saas-ui-design
supabase-change-safety
```

**Result:** PASS.

### Claude Code

The same workflow installed Claude Code `2.1.259`. A local mock Anthropic endpoint was used only to let the real Claude Code process complete without external model credentials; the smoke inspected Claude Code's own outgoing request context and verified that all four project Skill names were advertised through the `.claude/skills` symlink aliases.

This proves native project Skill discovery/context advertisement. It does **not** claim that a real Claude model semantically selected a Skill.

**Result:** PASS.

### Pi

`Local-Pi-Bridge` workflow run `33824811884` temporarily installed upstream `@earendil-works/pi-coding-agent@0.84.4`, launched real Pi RPC with LPB's actual read-scope extension and `--no-skills`, then called native RPC `get_commands`. Pi exposed the fixture as a native `skill:*` command through the repaired `resources_discover` seam.

The temporary live-smoke workflow/script were removed after success. Permanent deterministic regression remains.

**Result:** PASS.

## Cleanup

Temporary live-smoke infrastructure was removed after evidence capture:

- `pet-hotel-manager/.github/workflows/native-skills-smoke.yml` removed;
- temporary Codex/Claude smoke scripts removed;
- LPB temporary native live-smoke workflow/script removed.

The durable repository state contains only:

- canonical `.agents/skills` content;
- Claude symlink aliases;
- LPB minimal native compatibility repair;
- LPB deterministic regression.

## Final boundary

```text
Supervisor
  may explicitly request a named Skill as an override
  MUST NOT own default Skill discovery/routing/loading

Native Worker
  owns metadata discovery
  owns description-based matching
  owns progressive SKILL.md loading

Bridge
  may preserve native resource compatibility and safety
  MUST NOT become a Skill router/loader
```

## Completion

```text
blocking adoption gaps        0
unknown adoption gaps         0
Skill content copies          1 authoritative copy
new Skill Registry            0
new Supervisor Skill router   0
new universal context loader  0
Tri-Bridge Contract changes   0

AGENT SKILLS NATIVE ADOPTION: CLOSED
```
