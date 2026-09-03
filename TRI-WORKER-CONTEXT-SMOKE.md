# Tri-Worker Context Smoke v1

**Status:** P1 regression procedure  
**Fixture:** `test/fixtures/tri-worker-context`  
**Expected token:** `TRI_BRIDGE_CONTEXT_OK_7F29`

This smoke protects the P0 Worker-neutral Context Contract without creating a universal Bridge-owned context loader.

## Deterministic layer

The permanent repository-level invariants are:

1. `AGENTS.md` remains the shared project-contract SSOT.
2. Claude compatibility uses only the thin project-owned `CLAUDE.md -> @AGENTS.md` shim; do not copy policy text into `CLAUDE.md`.
3. LCB passes the selected CWD/task to native Codex and does not build a second instruction stack.
4. LPB must not launch Pi with context files disabled. Its existing launch-argument tests and opt-in native `loadProjectContextFiles` regression protect the prior `--no-context-files` failure mode.
5. LClB passes the selected CWD to native Claude Code and must not replace Claude's native project-context mechanism.

GitHub CI covers deterministic Bridge behavior only. Provider installations, credentials and subscription/API usage are intentionally not CI requirements.

## Operator live smoke

Run this only on a machine where the three Bridges and their native Workers are installed and authenticated.

Use the fixture directory as the exact CWD and send the same task through each Bridge:

```text
What is TRI_BRIDGE_CONTEXT_TOKEN? Return only the token.
```

Expected results:

```text
LCB  -> Codex       -> TRI_BRIDGE_CONTEXT_OK_7F29
LPB  -> Pi          -> TRI_BRIDGE_CONTEXT_OK_7F29
LClB -> Claude Code -> TRI_BRIDGE_CONTEXT_OK_7F29
```

The task text deliberately does **not** contain the expected token. A PASS therefore demonstrates that the Worker obtained the token through its project-context path rather than from the task itself.

For Claude, the fixture's `CLAUDE.md` contains only `@AGENTS.md`; a successful Claude result also verifies the compatibility shim rather than a copied second contract.

## Failure handling

A failure reopens only the affected adapter/context-loader compatibility issue, not the P0 shared semantics by default.

Check in this order:

1. exact CWD;
2. native Worker/version and native loader behavior;
3. Bridge launch flags for accidental context suppression;
4. project-owned shim/fixture integrity;
5. only then consider a shared-contract revision.

Do not solve a Worker-specific loader regression by adding a universal prompt/context loader to a Bridge.

## CI vs live evidence

Deterministic CI is required on every Bridge. The live smoke is intentionally operator-triggered because it consumes real Worker/provider capacity and depends on local authentication. It should be rerun after a native Worker update that changes context-loading behavior, or when a Bridge launch path changes.
