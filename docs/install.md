# Install

APE is a single npm package. It installs into Claude, Codex, OpenCode, Cursor, Hermes, and
VSCode with one config entry.

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite` — no native dependencies).
- Vendored engines ship in-package. Genesis and EVE need their own npm deps, installed
  automatically by the `postinstall` script on first `npm install` (no manual step).
  If that was skipped, run manually:
  `npm --prefix vendors/genesis install --ignore-scripts` and
  `npm --prefix vendors/eve install --ignore-scripts`.

## From npm

```bash
npm i -g ape-mcp
ape-mcp doctor        # engine build state + every sanctioned egress host
ape-mcp               # opens the browser console on 127.0.0.1 (auto port)
```

## From source

```bash
git clone https://github.com/fernandogarzaaa/ape-mcp
cd ape-mcp
npm install
node bin/ape-mcp.js doctor
```

## Add to a host

Point the host at the stdio server:

```json
{ "mcpServers": { "ape-mcp": { "command": "node", "args": ["<path-to>/bin/ape-mcp.js"] } } }
```

or HTTP: `ape-mcp --http 8787` (Streamable-ish endpoint, `Bearer` auth opt-in).

Manifests ship in-repo: `.claude-plugin/` (Claude), `.codex/skills/ape/` (Codex),
`.opencode/plugin.json` (OpenCode), `mcpServers.json` (Cursor/Windsurf/VSCode/Desktop).

## First agent run

Set a model provider key, then:

```bash
APE_ANTHROPIC_API_KEY=sk-... ape-mcp run ape_agent_run '{"profile":"repo-triage","objective":"Triage: build broken after dep bump"}'
```

Poll with `ape_agent_status {run_id}`. Without a key, use a local model:
`APE_LOCAL_BASE_URL=http://localhost:11434/v1` with a profile pointing at `provider: local`.