# Native Capability Consolidation Candidate

Target: `lcb-thick-consolidation` from `origin/main` `9655bff3d187b47995751886c06b867718ec94c8`. Protocol audit: installed official Codex app-server 0.156.0, stable and experimental generated JSON schemas. This Candidate changes only this integration worktree.

## Result

LCB has one broad native capability line. Eighteen MCP tools include the existing Host compatibility tools, separate native thread/turn entry points, fork/compact ergonomics, and four bounded native method groups. Exact native IDs and native acknowledgements are preserved. The Host still owns authority and effects; generic command, file system, process, account, plugin installation, and config mutation methods are excluded. No checkpoint or parallel task ledger was added.

| 0.156 client methods | Ergonomic | Public read | Public action | Redesign gap | Internal | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Stable | 8 | 26 | 22 | 2 | 43 | 101 |
| Experimental only | 0 | 13 | 8 | 7 | 35 | 63 |

The counts classify each method once. Some public group methods also have named ergonomic wrappers. The [audit manifest](audit/methods-0.156.json) records the classification and every audited request parameter field; the test regenerates current stable and experimental schemas and checks all methods, parameter fields, and the ten stable ServerRequest names.

## Donor mapping

| Read-only donor | Contribution to this Candidate |
| --- | --- |
| R3 `9655bff` | Exact integration base; Host v2/v3 delivery boundaries, native quota tool, memory and existing MCP/runtime behavior retained. |
| Native R2 `eb2a9c2` | Bounded stable/experimental generic native allowlist pattern adapted to 0.156 fields and methods. |
| Dirty canonical WIP | Full UserInput variants, output schema/turn trigger, fork/compact ergonomics, native model/effort forwarding ideas adapted. Unrelated dirty runtime/degradation changes were not copied. |
| Native qualification R1 | Native Goal and reconnect uncertainty evidence; local lifecycle authority replaced with native Goal truth and receipt-only persistence. |
| TD end-to-end R2 and bootstrap repair | Existing delivery/reviewer behavior retained from the base; no donor checkout or deployment setup was changed. |
| DSH socket donor | Socket transport is outside this Candidate and was not imported. |
| Native agent policy donors | Model pinning policy is outside the app-server capability contract and was not imported. |

## Deliberate post-Candidate redesign gaps

`fuzzyFileSearch` and its experimental session controls need a bounded search/stream API. `mcpServer/resource/read` needs resource-size and content-type limits. Experimental `project/create|import|update|move|delete` and `thread/backgroundTerminals/terminate|clean` need normalized effect contracts with Host authority. These nine client methods are classified as redesign; session controls remain internal. The generic native groups reject them.

Auth-token refresh and attestation server requests remain runtime plumbing. Unknown future server requests remain pending and cannot be answered with guessed response shapes.

## Evidence and next review

`npm ci --include=dev`, typecheck, build, shared tests, and platform tests pass on this Linux worktree. Shared tests cover native allowlists, non-allowlisted rejection, UserInput variants, attachments/fork/compact/revert, current thread-list fields, dynamic tool and MCP elicitation response round trips, native Goal precedence, reconnect uncertainty, mutation timeout UNKNOWN, and experimental methods. Live Codex smoke was not run because it creates persistent native threads. No service, production config, deployment, donor worktree, or runtime state was changed.

After independent review passes, the native R2 and native qualification R1 donor worktrees are redundant for this capability line, and the R3 donor is redundant as the already integrated base. The dirty canonical checkout, socket donor, TD end-to-end, bootstrap repair, and native agent policy donors have separate work or state and are **not** declared removable by this Candidate. No worktree removal occurs here.
