# Worker-neutral Supervisor ownership

This repo is a thin, Codex-specific MCP adapter. It does not own Supervisor
policy: worker selection/fallback, quota/budget routing, health judgment,
acceptance, or cross-worker handoff.

Those contracts, the tri-bridge history (`TRI-BRIDGE-*`), the cross-worker
reference audits, and the worker-neutral `archify-safe` tooling moved to:

**[`ouzuiki/Worker-Neutral-Supervisor`](https://github.com/ouzuiki/Worker-Neutral-Supervisor)**

A sibling checkout at `../Worker-Neutral-Supervisor` is a developer
convenience only — this bridge has no runtime dependency on it.
