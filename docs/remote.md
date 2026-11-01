# Remote MCP endpoint (`/mcp`)

Expose APE as a remotely reachable MCP server (e.g. `https://your-domain.com/mcp`)
for MCP clients such as ChatGPT's custom MCP app flow.

## 1. Architecture

```text
MCP client (ChatGPT, …)
   │  HTTPS, Bearer, mcp-session-id
   ▼
Caddy (TLS termination, :443)
   │  plain HTTP
   ▼
127.0.0.1:8787  (ape-mcp --http)
   ├─ POST /mcp      JSON-RPC dispatcher (this document)
   ├─ GET /mcp       405 (no server-initiated streams in v1)
   ├─ DELETE /mcp    close session
   └─ legacy routes  /discover, /call, /agent, /a2a (unchanged)
```

APE stays bound to loopback. Caddy is the only public entry point.

## 2. Prerequisites

- A host with Node.js ≥ 22.5, a public IP, and ports 80/443 reachable.
- The APE repo checked out with `npm install` completed.

## 3. DNS

Point an `A` record at the host (e.g. `mcp.your-domain.com → <public-ip>`).
Free alternative that works today: a `runs-on.dev` subdomain with an `A`
record (e.g. `ape.runs-on.dev`); the legacy no-DNS trick below still works
for testing: `<dash-ip>.sslip.io` (e.g. `98-86-146-92.sslip.io`
for `98.86.146.92`) resolves with no action and gets valid Let's Encrypt certs.

## 4–5. TLS via Caddy (reverse proxy only — no in-process TLS in v1)

```caddy
mcp.your-domain.com {
  reverse_proxy 127.0.0.1:8787
}
```

Caddy obtains and renews certificates automatically. APE itself speaks plain
HTTP on loopback only.

## 6. Environment configuration

```bash
APE_HOST=127.0.0.1            # keep loopback behind the proxy
APE_PORT=8787
APE_REQUIRE_AUTH=1            # mandatory for any remote bind
APE_TOKENS=<random-hex>       # comma-separated bearer tokens
APE_CORS_ORIGIN=https://chatgpt.com   # exact origins, comma-separated; unset = no CORS header
# APE_ALLOW_OPEN_REMOTE=1     # RECKLESS escape hatch: remote bind with no auth. Never production.
```

Start: `ape-mcp --http 8787`. A non-loopback bind without bearer auth **refuses
to start** (`resolveBindConfig`, fail-closed); the escape hatch prints a severe
warning.

## 7. Authentication

`Authorization: Bearer <token>` on every `/mcp` verb (POST/GET/DELETE),
including pre-negotiation `initialize`. Missing/invalid → `401`, and **nothing
executes**. The OAuth protected-resource document stays public at
`/.well-known/oauth-protected-resource`.

## 8. Session behavior

`initialize` returns `mcp-session-id` (response header, UUID, pinned
`protocolVersion` — never echoed). Every later request must send it back.
Unknown, expired, or missing sessions fail explicitly:

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32001, "message": "session-not-found: ..." } }
```

Sessions are **in-memory, single-node**, expiring after **30 minutes idle**.
`DELETE /mcp` with the header closes a session; reuse afterwards fails.

## 9. MCP endpoint methods

`initialize`, `notifications/initialized` (202, empty), `ping`,
`tools/list`, `tools/call`, `resources/list`, `resources/read`,
`prompts/list`, `prompts/get`. Single objects and batch arrays (processed
sequentially, in order). Tool-level failures return HTTP 200 with
`isError: true` (transport stays clean); unknown methods are `-32601`;
malformed JSON is `-32700`.

## 10. Curl verification

```bash
BASE=https://mcp.your-domain.com/mcp
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

# initialize → capture session
SID=$(curl -s -D- "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' $BASE \
  | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')

# tools/list → tools/call → DELETE
curl -s "${H[@]}" -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' $BASE | head -c 300; echo
curl -s "${H[@]}" -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ape_status","arguments":{}}}' $BASE | head -c 300; echo
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "${H[@]}" -H "mcp-session-id: $SID" $BASE
```

## 11. Client registration

| Client | Transport setup | Auth | CORS needed? | Verify |
|---|---|---|---|---|
| ChatGPT custom app | MCP server URL `https://<host>/mcp` | Paste bearer token | Only the web playground — allowlist its exact origin | Tools discovered + a call completes |
| Claude Code (CLI) | `claude mcp add --transport http ape https://<host>/mcp --header "Authorization: Bearer <token>"` | Header flag | No (desktop sends no `Origin`) | `claude mcp list` shows `ape` |
| Cursor / VS Code / Windsurf | MCP JSON `{ "url": "https://<host>/mcp", "headers": { "Authorization": "Bearer <token>" } }` | Headers map | No (desktop) | Tool list appears after client restart |
| OpenCode / Copilot | Same JSON shape | Same | No | — |
| Raw / custom | §10 curl sequence | Bearer header | Only browser-based — see below | HTTP codes + session lifecycle |

**Required headers for every client:** `Authorization: Bearer <token>`, plus
`mcp-session-id` after `initialize` (managed by spec-compliant clients).
**Expected tools:** the 24 `ape_*` tools (`ape_agent_run`,
`ape_agent_status`, `ape_recall`, `ape_connector_call`, …).

**Finding your browser client's Origin** (only needed for web playgrounds):
open devtools → Network → trigger any cross-origin request → read the
`Origin` request header (e.g. `https://chatgpt.com`) → add it verbatim to
`APE_CORS_ORIGIN` → restart APE. Desktop/CLI clients send no `Origin` and
need nothing.

Do not claim a client connected until it actually has: registration is proven
only by the client discovering tools and completing a call.

## 12. Live streams (`GET /mcp`)

Streams are functional, not decorative: `ape/runs` status transitions and
`ape/steps` records for activity after connect, plus heartbeats.

- Open with bearer + valid `mcp-session-id`; response is
  `text/event-stream` with `retry: 10000`, an opening comment, then
  `notifications/message` envelopes:
  `{ level: "info", logger: "ape/runs" | "ape/steps", data: { run | step } }`.
- Cursors start at connect (no replay); heartbeat comment every
  `APE_MCP_HEARTBEAT_MS` (default 15000ms); disconnect tears down timers.
- Multiple streams per session allowed; each independent.

## 13. Limitations (v1, explicit)

Single-node. In-memory sessions (restart drops them). No horizontal scaling
(SQLite ledger is local). No multi-tenant isolation (one shared token set).
No rate limiting. No in-process TLS. Request bodies capped at 4 MB.

## 14. Token rotation

```bash
# on the host, as root:
TOKEN=$(openssl rand -hex 32)
# replace APE_TOKENS in /home/ape/ape.env, then:
systemctl restart ape
# verify: old token → 401, new token → 200 on POST /mcp initialize
```

Never commit tokens, print them into logs/docs/tests, or reuse an exposed one.
