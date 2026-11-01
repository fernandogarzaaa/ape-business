# Protocol compatibility statement

**Position: dual-era.** APE speaks newline-delimited JSON-RPC over stdio with the
legacy method set (`initialize`, `tools/list`, `tools/call`, `resources/*`,
`prompts/*`) plus modern `server/discover`. Stateless — no session ids; state
travels in handles. This is NOT a wire-complete native 2026-07-28 transport; the
machine-readable scope is `discover().transport`. A native rebuild is tracked
separately and will be advertised only when the wire actually changes.

## Version pinning

- The server answers `initialize` with its pinned `protocolVersion`
  (`2026-07-28`) and current capabilities. It does not echo arbitrary client
  versions — claiming a wire it cannot speak.
- `server/discover` reports `protocol`, `capabilities`, and the `transport`
  descriptor above.

## What a host can rely on

| Capability | Status |
|---|---|
| `tools/list` / `tools/call` | Stable. Tool names are `ape_*`; schemas are JSON Schema. |
| `io.modelcontextprotocol/tasks` extension | Stable. `ape_task_start`/`ape_task_get` (+ `tasks/get`). |
| `dev.ape/agent` extension | v0.1. Methods: `agent/listProfiles`, `agent/describeProfile`, `agent/run`, `agent/getRun`, `agent/cancel`. **Optional** — a host that does not negotiate it simply never sees it; no error, no silent degradation. |
| A2A bridge | `GET /.well-known/agent.json` (agent card, profiles as skills) + JSON-RPC `POST /a2a`: `message/send`, `tasks/get`, `tasks/cancel`. Compatible subset (no streaming/push in v1); every task is a fully audited APE run. |
| Tool parity for the agent | `ape_agent_run`, `ape_agent_status`, `ape_agent_cancel`, `ape_agent_profiles` work on any host with tool support. |

## Compatibility policy

- Tool names and schemas are considered public API. Renames are a **breaking change**
  and are gated behind a CHANGELOG entry.
- Extension methods are additive. A new method does not require a version bump unless it
  changes an existing method's contract.
- `dev.ape/agent` is namespaced (`dev.ape/*`) per the Extensions framework; core-spec
  adoption later is optional and separate. No central approval is required to define a
  capability under your own namespace.
- Breaking changes to the `ape_*` tool surface land only on a minor/major version bump,
  never a patch.

## Verification

Every gate is verified through a real MCP client (`@modelcontextprotocol/sdk`) plus the
stdio/HTTP surfaces, never ad-hoc JSON-RPC framing. See `tests/extension.test.js` and
`scripts/live-audit.ps1`.