# AR3 — Artifact Production Contract v0

AR3 does not add code. It formalizes, as a machine-readable contract
(`artifact-production-contract.v0.json`), the state machine that AR1's
wrapper (`scripts/archify-safe.mjs`) already implements, and records what
AR2 actually observed (`ar2-smoke-evidence.v0.json`). AR3 is worker-neutral
by construction: it defines states and required evidence fields, not any
worker-specific execution path.

## Production state machine (compact)

| Stage | Gate | Fails closed on | Evidence produced |
|---|---|---|---|
| Runtime gate (A) | exact pin, owner-installed, doctor verified | unavailable / version mismatch / unverified identity | `archify.identityStatus`, `archify.detectedVersion` |
| Input evidence (B) | spec is hashed, not embedded | — | `spec.sha256`, `spec.bytes` |
| Output confinement (C) | `.html` only, inside dedicated artifact root, safe relative name, same-dir candidate | absolute name, `..`, symlink escape, non-html, unsafe final target | `finalRelativePath` |
| Promotion gate (D) | child exit 0 + candidate is regular/non-symlink/non-empty/basic-HTML | any of the above unmet | atomic rename only, no unlink-first |
| Receipt (E) | all required fields present | — | full receipt object |
| Claim semantics (F) | deliver success ≠ schema/browser/perceptual/human validation | inferred upgrade of a claim | `claims.*` stay at their evidenced value |
| Portability (G) | per-lane `{pass\|hold\|fail}`, holds ≠ failures | weakening a safety boundary to force PASS | lane status map |

A delivery either completes the whole chain and is promoted, or it fails
at some gate and the previous last-known-good final output is left
untouched. There is no partial/degraded success state.

## AR2 observed outcome

AR2 is `closed_with_holds`, not PASS and not failure. See
`ar2-smoke-evidence.v0.json` for the exact recorded evidence:

- **Claude**: `pass` — real `deliver` against the upstream example spec
  (`archify/examples/web-app.architecture.json`), promoted to
  `.artifacts/archify/claude.html` under `/tmp/archify-ar2-claude`, full
  receipt captured (hashes, exit code, `validation.basicArtifact=passed`).
  Write confinement was observed to stay under the target's
  `.artifacts/archify`.
- **Pi**: `hold` / `harness_capability` — Pi's current LPB `mutationScope`
  is exact-file-Set membership only (no directory-prefix/glob), and with
  `mutationScope` active, shell tools are categorically blocked
  (`LPB_MUTATION_SCOPE_UNSUPPORTED_TOOL`); read mode exposes no
  shell/execution tool at all. A transactional CLI writer whose candidate
  filename is unpredictable in advance cannot be expressed under that
  model today. This is a harness capability gap, not an Archify defect,
  and is not resolved by granting broader unscoped shell approval.
- **Codex**: `hold` / `external_quota` — the Plus Codex secondary (7-day)
  rate-limit window was at 100% used / 0% remaining at observation time,
  externally blocking turn execution, while the primary 5h window was
  untouched. Reset credits exist and were deliberately not spent. This is
  a quota-timing fact, not a statement about Codex/Archify compatibility.

Net: one real, independently verifiable artifact delivery exists through
the shared wrapper. Three-worker portability is **not** established —
that requires real safe-deliver evidence from all three lanes, which AR2
does not have.

## Next capability gap (explicitly out of scope for AR3)

The Pi hold points at a real, general gap: LPB has no worker-neutral way
to safely admit a transactional command-line writer that produces an
unpredictable same-directory candidate path under directory-scoped (as
opposed to exact-file-Set) mutation control. Closing that gap, if ever
undertaken, is a capability-model question for LPB itself — e.g. a
general directory-scoped mutation primitive, or a general safe
transactional-command capability — evaluated on its own merits for any
tool that needs it, not just Archify. AR3 explicitly does **not**
prescribe an Archify-specific or Pi-specific bypass or extension to close
this gap, and does not treat it as an AR3 blocker.

Similarly, the Codex hold is simply pending quota availability. Rerunning
the Claude-lane-equivalent smoke test on Codex once the 7-day window
resets is the entire remaining action; it is not an AR3 blocker either.
