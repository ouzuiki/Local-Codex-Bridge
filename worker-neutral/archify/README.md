# Archify Integration — Current State (AR0–AR3)

This directory holds a versioned, **worker-neutral** integration of
[Archify](https://github.com/tt-a1i/archify) shared by Codex, Claude, and
Pi through a single wrapper. There is **no per-worker implementation** of
Archify integration anywhere in this repo.

Files:

- `admission-profile.v1.json` — AR0 machine-readable policy contract.
- `artifact-production-contract.v0.json` — AR3 machine-readable production
  state machine and required-evidence contract.
- `ar2-smoke-evidence.v0.json` — AR2 observed cross-worker smoke evidence.
- `AR3.md` — AR3 explanation of the production state machine, AR2 outcome,
  and the next capability gap.
- This `README.md`.

Shared wrapper implementation lives at `scripts/archify-safe.mjs`
(outside this directory, since it is executable code, not policy).

## Status summary

| Stage | Status |
|---|---|
| AR0 — admission profile | PASS |
| AR1 — wrapper (`scripts/archify-safe.mjs`) | PASS (13/13 focused adversarial tests) |
| AR2 — cross-worker smoke | `closed_with_holds` (not PASS, not failure) |
| AR3 — artifact production contract v0 | PASS |

## Upstream identity and installation

- Upstream: `tt-a1i/archify`, pinned to the exact version `v2.16.0`.
- Installation and upgrades of the Archify runtime are controlled by the
  owner, outside of the wrapper. The wrapper never resolves `npx`/`latest`,
  never auto-installs, and never auto-updates the runtime.
- Current owner-provisioned runtime path (outside this repo):
  `<owner-home>/.local/share/archify-runtime/v2.16.0/archify/bin/archify.mjs`,
  from a clean exact-tag checkout of `tt-a1i/archify` tag `v2.16.0`
  (annotated tag object `fe2c0da92389bb35e9d71a9c7ae000c1083f2c37`,
  dereferenced commit `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de`). Upstream
  `doctor` reports all `[ok]`.

## Filesystem policy

- **Reads allowed:** repository/source files needed for the task, and git
  metadata.
- **Writes allowed:** only under a dedicated artifact root inside the
  target working directory. The default artifact root is
  `.artifacts/archify`.
- **Artifact-root override:** if supplied, it must be a *relative* path
  that resolves inside the target cwd. Absolute overrides, or overrides
  that resolve outside the cwd, are rejected.

## Output policy

- Final outputs must be `.html` files.
- Callers may not supply arbitrary raw filesystem output paths.
- The following are always rejected:
  - absolute output names
  - `..` parent-traversal sequences
  - artifact-root escapes
  - symlink escapes
  - non-`.html` outputs

## Replacement policy

A final output is only replaced via a wrapper-controlled candidate written
to the same directory, and only after the child process has succeeded and
the candidate has passed basic artifact verification. If the child process
fails, or the candidate is invalid, the existing last-known-good final
output must survive unchanged. Promotion is an atomic rename; there is no
unlink-first step.

## Runtime policy

- `ARCHIFY_UPDATE_CHECK_DISABLED=1` is forced for the child process.
- Network access and update checks are disabled by default.
- No auto-install and no auto-update, ever.

## Preview policy

- Opening or previewing generated output is disabled by default.
- Visual/browser-based checking is a **separate, optional** capability
  that requires explicit authorization. It is never implied by a
  `deliver` call.

## Prohibited actions

The wrapper and any worker using it must never:

- read credentials or secrets,
- run `git commit` or `git push`,
- mutate services or processes.

## Privacy

Evidence derived from private repositories or private source is
local-only by default. It is never auto-published or auto-shared.
Hashes and metadata are the preferred shareable evidence form.

## Claim dimensions

Four kinds of claims about generated output are distinct and independent;
satisfying one never implies another:

1. deterministic/schema validation
2. runtime/browser evidence
3. perceptual review
4. human acceptance

A successful `deliver` with `validation.basicArtifact=passed` never
upgrades any of these dimensions by inference; each stays at
`not_performed` / `not_separately_verified` until independently
evidenced.

## Fail-closed admission

Any violation of admission policy, path policy, or runtime policy causes
the operation to fail closed (reject/abort), never to degrade silently or
proceed with reduced guarantees.

## Why we independently enforce output confinement

Upstream issue `tt-a1i/archify#124` is referenced only as the reason this
integration independently enforces output confinement: the integration
does not rely on upstream CLI output-path enforcement.

## AR1 — wrapper CLI contract (implemented)

`scripts/archify-safe.mjs` (wrapperVersion `1.0.0`, profileVersion
`1.0.0`) implements:

```
node scripts/archify-safe.mjs doctor --cwd <cwd> --runtime <absolute-runtime-path>

node scripts/archify-safe.mjs deliver --cwd <cwd> --runtime <absolute-runtime-path> \
  --type <architecture|workflow|sequence|dataflow|lifecycle> \
  --spec <spec.json> \
  --name <relative-output.html> \
  [--artifact-root <relative-inside-cwd>]
```

`doctor` reports `{ ok, archify: { pin, runtime, available, identityStatus,
detectedVersion } }`. `deliver` produces a full receipt (`receiptVersion`,
`wrapperVersion`, `profileVersion`, `archify.*`, `child.*`,
`finalRelativePath`, `spec.{sha256,bytes}`, `artifact.{sha256,bytes}`,
`validation.basicArtifact`, `claims.*`) — see
`artifact-production-contract.v0.json` for the exact required-fields list.
This is the one and only wrapper entrypoint; there is no per-worker
implementation.

## AR2 — cross-worker smoke (closed_with_holds)

Codex, Claude, and Pi were each evaluated against the same shared
wrapper. Full detail is in `ar2-smoke-evidence.v0.json`; summary:

- **Claude — PASS.** Real `deliver` call against the upstream example
  spec `archify/examples/web-app.architecture.json`, target
  `/tmp/archify-ar2-claude`, promoted to
  `.artifacts/archify/claude.html`. Receipt: spec sha256
  `483350f5297df682aba4e4a0fa491307ce3d3abd725ae4df07fab177490752cf`
  (3793 bytes), artifact sha256
  `d2ace03a19456e1ba1e24ed5ec2ef8de495190cbf1f59d54ab9d138d460a5ab8`
  (715210 bytes), child exit code `0`, `validation.basicArtifact=passed`.
  Claims left at their honest default (`deterministicSchema:
  not_separately_verified`; `runtimeBrowser`/`perceptual`/`human:
  not_performed`). Writes were observed only under the target's
  `.artifacts/archify`.
- **Pi — HOLD (`harness_capability`).** Pi's current LPB `mutationScope`
  is exact-file-Set membership only, with no directory-prefix/glob
  support; when `mutationScope` is active, shell tools are categorically
  blocked (`LPB_MUTATION_SCOPE_UNSUPPORTED_TOOL`), and read mode exposes
  no shell/execution tool at all. A transactional writer with an
  unpredictable same-directory candidate path cannot be safely expressed
  under that model today. This is a harness gap, not an Archify failure,
  and is not resolved by an unscoped shell-approval bypass.
- **Codex — HOLD (`external_quota`).** At observation time the Plus Codex
  secondary (7-day) rate-limit window was 100% used / 0% remaining, while
  the primary 5h window was untouched (0% used). Reset credits exist and
  were deliberately not consumed. This reflects quota timing, not
  Codex/Archify incompatibility.

**Overall AR2 status: `closed_with_holds`.** One safe lane established a
real, verifiable artifact; three-worker portability is **not**
established and must not be claimed until Pi and Codex each produce real
safe-deliver evidence of their own.

## AR3 — artifact production contract v0 (PASS)

`artifact-production-contract.v0.json` formalizes the production state
machine (runtime gate → input evidence → output confinement → promotion
gate → receipt → claim semantics → portability semantics → privacy →
version/update policy → failure semantics) that the AR1 wrapper already
implements, and pins the exact required receipt field names. See `AR3.md`
for the compact state-machine explanation, the AR2 outcome restated in
context, and the next capability gap (a possible future LPB directory-
scoped mutation or general safe transactional-command capability), which
is explicitly **not** prescribed here and is **not** an AR3 blocker.
