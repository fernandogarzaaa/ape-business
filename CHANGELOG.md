# Changelog

## Unreleased — high-level agents, L3: planner→executor over Skein

### Closed: 2026-09-17 live-run gaps session (was docs/gaps-report.md)
- Live plugin + MCP run (stdio + HTTP) drove every tool through the real
  plugin-client path (`scripts/live-audit.ps1`, 17/17 green with payload
  verification). Fixed that session: `ape_beliefs`/`ape_genome` registered
  against the real vendored `adam-mcp` binary; memory tools made real via
  `src/adam-client.js` (line-delimited JSON-RPC over the vendored binary,
  state under `$APE_DATA_DIR`); `ape_mcp_eval` surfaced from vendored EVE;
  Skein dispatch auto-injects `PYTHONPATH=vendors/skein/src`; ledger surface
  went live (`audit_claim` appends to `.ape/ledger.jsonl`, console Ledger tab
  renders it); `live-audit.ps1` `$args` shadowing fixed with payload
  assertions; ADAM client `child.stderr`/hardcoded request-id bugs fixed.
- Follow-ups queued that session (world-simulate/MIRO venv setup,
  `ape_compare` wiring, `ape_evolve` accept path, large-result handling,
  static console tabs, cross-platform ADAM binaries, dev re-vendor rebuild
  note) are open work items, no longer a standalone dated report.

### Host skill mirrors are CI-guarded
- `.codex/skills/ape/SKILL.md` is a byte-identical mirror of the canonical
  `skills/ape/SKILL.md` (Codex requires that exact host path).
  `scripts/check-skill-mirrors.mjs` fails CI on drift; edit the canonical
  file only.

### Context hygiene (truncation with recoverable previews)
- Tool results are no longer silently sliced at 8000 chars. Over-budget
  results are truncated to a token-budget preview (head/tail/head-tail,
  default 1500/750 tokens) with an explicit `[truncated ...]` marker; the
  full text is stashed per run in `runs.db` and recoverable through the
  auto-added `context.retrieve` tool, which returns bounded pages (max 8000
  chars) so a page can never re-create the overflow.
- Knobs are global defaults in `ape.config.yaml` (`context:` section):
  built-in defaults < global config < profile `policy.context` < per-tool
  overrides. `context.retrieve` can be disabled globally or per profile.
- Observability: `receipt.tool_truncations` (also top-level), ledger tool
  steps tagged `trunc:<ref>:~<tokens>t`, truncation counter survives
  checkpoint/resume. Refs are per-run; stash rows older than 7 days are
  pruned on write. Provider-neutral: works with local models (Ollama) and
  cloud providers alike, no AWS dependency.

### Planner-executor + patterns (L3)
- `skein.orchestrate` gains `node-add` (planners emit the inspectable plan
  artifact: id + title/goal/completion per node); `release` mapped to
  upstream's force-release so the op actually succeeds (previously dead).
- New `supervisor` profile (delegate + graph + recall); `docs/patterns.md`
  maps supervisor/workers, planner→executor, hierarchical teams, and
  generator→critic onto APE primitives with entry points.
- Hierarchy e2e: mock supervisor adds 2 plan nodes, fans out 2 real
  delegated children concurrently, synthesizes — graph, linkage, fan-out,
  and terminal states all asserted.

### Supervisor delegation (L2)
- New `delegate` builtin: a run spawns a scoped child agent (profile +
  sub-objective) as a real worker — own row, budget, and receipt, linked by
  `parent_run_id` (new ledger column). The child's receipt summary returns
  as framed tool output.
- Budget slices come from the parent's *remaining* budget (`budget_share`
  default 0.25, max 0.5; child effective limits are min(profile, slice)), so
  a tree can never outspend its root. Hangs die at `timeout_s`.
- Depth-capped (`limits.max_delegate_depth`, default 2, 0 disables); max 2
  concurrent delegations per fan-out turn; child admission honors global
  caps; all failure modes (refused/timeout/depth/profile/budget) are honest
  non-fatal tool results — the parent continues.
- Receipts link both ways: parent `delegations[]` + `delegated_cost_usd`,
  child `parent_run_id` (row and receipt). Depth and delegation log survive
  resume. Tool-output banner now lives in registry.js (ASCII-bracketed).

### L1 composite profiles
- Four new bundled specialists composing existing engines (YAML only, no
  runtime changes): `deep-researcher` (web + recall + audit, enforce),
  `code-reviewer` (adversarial audit of code pasted in the objective —
  honestly scoped with no repo access, enforce), `triage-lead` (Skein graph
  + audit + recall + synthesis; nodes kept delegation-ready), `planner`
  (cheap strategy-only L3 prep: emits a Skein graph, never executes).
- Documented in profiles.md alongside the existing three; loader round-trip
  and mock smoke tests per profile.

### CR-1: profile loader preserves documented controls
- `loadProfile` no longer rebuilds policy/limits from fixed key lists:
  `credential_policy`, `parallel_calls`, `drift`, `dedup_window_sec`, and
  `max_parallel` survive YAML loading with explicit validation (invalid values
  fall back safe — never open/unlimited; non-numeric budgets coerce to
  defaults). `describeProfile` exposes effective policy.
- YAML-to-loop integration tests prove every documented key reaches the
  runtime (parallel/drift/spend-cap behaviors driven from loaded YAML).

### CR-3: console auth gate + same-origin CORS
- One bearer gate sits before every route past the public metadata + static
  shell (reads included). `Access-Control-Allow-Origin: *` replaced with
  same-origin reflection; foreign preflights refused.

### CR-2: cross-origin redirect credentials
- Cross-origin hops rejected by default (`cross_origin_redirect`); same-host
  https upgrades and same-origin hops keep working. Opt-in
  `allow_cross_origin_redirects: true` follows CLEAN (auth headers dropped,
  secret params stripped). Port changes count as cross-origin.

### W-1: budget before tools + provider wall-time abort
- Budget checked after every model turn before any tool runs (a spent turn
  launches nothing). Provider calls carry `min(120s cap, remaining wall
  time)` abort signals; `providerTimeoutMs` is pure and tested.

### W-2/W-3: A2A honesty + per-provider schemas
- `toTask` maps state from `outcome_status` (exhaustion reads as failed with
  the stop reason, never completed). Tool schemas derive per serving
  provider so cross-family fallbacks keep the right wire shape.

### W-4: mock controls out of production inputs
- `_mockScript`/`_mockCostPerCall` stripped from MCP inputs unless test-only
  `APE_ALLOW_MOCK_INPUT=1` is set in server env (unreachable to callers).

### Repair-selecting immunity (§19)
- The loop now selects a REPAIR from history instead of retrying identically:
  `retry` (transient blips), `retry-delayed` (rate limits/cold starts),
  `retry-shrunk` (oversized inputs, truncates long string args).
- Selection policy: learned past success wins, ≥2 past failures escalate to a
  backed-off retry, otherwise the per-class default. Unknown recorded actions
  cannot escape the vocabulary. Giving up stays the drift halt's job.
- Outcomes recorded back with reinforcing confidence (success 0.85 / fail 0.6);
  repairs applied are named in step summaries and logged in
  `receipt.repairs` (survives resume via checkpoint).

### Credential policy (§18)
- `policy.credential_policy.allow` filters the resolved provider chain in the
  worker — disallowed providers never serve, including task-routed models;
  policy wins over explicit overrides; empty results fail honestly.
- `policy.credential_policy.max_spend_usd` enforces per-provider per-run caps
  per model turn with live attribution: capped entries are skipped, spend
  shifts to fallback, full exhaustion halts as `spend_capped` (→ `exhausted`).
- Every receipt carries `spend_by_provider`; attribution survives resume via
  checkpoint state. Absent policy = previous behavior.

### Analyzer causality (§21)
- Suggestions are now symptom → ranked hypotheses → intervention: every
  suggestion carries `symptom`, `hypotheses: [{cause, confidence, evidence}]`,
  `patch`, `rationale`, and overall `confidence` (shape is backward
  compatible — `finding`/`patch`/`rationale` kept).
- Chronic `max_steps` no longer blindly raises the ceiling: receipts are read
  for trajectory signals (drift warnings/streaks, stuck stops, evidence,
  tool variety). Stuck trajectories get a no-patch fix-prompt/tools
  intervention; only healthy trajectories earn a raise; receipt-less history
  raises at LOW confidence with the uncertainty stated.
- Fallback advice is credential-aware (sync env check): recommends only a
  provider the operator can serve, or no patch with setup instructions.
  Latency/cost/jurisdiction limits are stated, not assumed.
- `recentRuns` now includes the receipt JSON for per-run trajectory linkage.

### SQLite-backed tasks (P2)
- `tasks.json` read-modify-write is gone: `tasks.db` (WAL) with per-row
  mutations — concurrent writers cannot lose tasks, commits are atomic (no
  torn writes). Same `taskCreate/taskGet/taskList/taskFinish` surface
  (`taskList` gains an optional limit).
- Stale `running` rows reconcile to `expired` with an honest reason (dead
  owner, or ownerless + untouched past grace). Live owners never expire by
  age — long tasks keep their results. Runs opportunistically on create.
- TTL pruning for terminal rows (default 7d, `APE_TASK_TTL_MS`, 0 disables).
- One-time migration imports legacy `tasks.json`, then retires it as
  `tasks.json.migrated`.
- Tested the audit's cases: 4-process × 5-task burst with zero loss and no
  cross-talk; SIGKILL mid-burst → `integrity_check` ok, orphans expire.

### Evidence artifacts (P2)
- The grounding gate now consumes FULL verifier results (capped 8k, in-memory),
  never the 300-char ledger summary. A verdict past the truncation point no
  longer degrades to neutral.
- Verify-tool successes produce artifacts `{evidence_id, tool, step, verdict,
  digest, excerpt}` carried in `receipt.evidence` (digests pin the judged
  bytes); full text is stripped from returned steps so payloads stay bounded.
- Artifacts persist across resume via checkpoint state.

### Outcome identity → SHA-256 (P1)
- `familyOf` and receipt `outcome_hash` are SHA-256 (was 32-bit rolling hash).
  Pre-migration `fam-XXXXXXXX` rows do not group with new IDs (documented;
  dedup only matches same-era values). `shaShort` remains for local index keys
  only, marked non-provenance in trace.js.

### Lifecycle/outcome split (§15)
- Every run status now carries computed `outcome_status`: running / success /
  unverified / incomplete / exhausted / failed / cancelled / stopped /
  not_found. Consumers must branch on it, never infer success from
  `status=done`.

### Atomic admission (P2)
- `admitRun`: ceilings + insert in one IMMEDIATE transaction — concurrent
  admitters can no longer overshoot caps; refusals leave no partial row;
  busy ledger returns honest `ledger_busy`.

### Wire honesty (P0)
- Dual-era declared: `discover().transport` states the actual wire contract;
  `initialize` returns the pinned version instead of echoing arbitrary client
  versions. Protocol doc rewritten to match. Native 2026-07-28 transport is a
  separate tracked project, not claimed.

### Audit durability (P1)
- `auditDestructive` returns `{ persisted }`; failed audit writes surface as
  explicit `audit-degraded` markers on the step and `audit_status: "degraded"`
  on executed results — never silent.

### Supply chain (§23)
- `fetch-adam.mjs` verifies SHA-256: `APE_ADAM_SHA256` pin first, then the
  release `<asset>.sha256` sidecar; mismatch deletes the file and fails
  closed; `APE_ADAM_REQUIRE_CHECKSUM=1` refuses install with no expectation.

## Unreleased — audit hardening, round 1 (deep-audit P0/P1)

### Dedup correctness (P0)
- Reuse now requires a VERIFIED prior success (`explicit_final_answer`,
  unverified flag clear) — budget/drift-halted and unverified runs never dedup.
- Added comparability basis: SHA-256 `profileHash` (any profile change
  invalidates) + `envFingerprint` (connector surface) + resolved model must all
  match; legacy rows without hashes never match (fail closed).
- Dedup moved after model resolution so the comparison uses the resolved model.

### Connector egress + auth (P0/P1)
- Redirects no longer escape the allowlist: manual redirect chain, per-hop
  `hostAllowed` validation (max 5 hops), `egress_denied_redirect` on escape,
  `too_many_redirects` on loops.
- `auth.query` credentials are now actually applied to the request URL.
- Credential-bearing params are redacted (`***`) in every returned URL.
- `confirm: true` passes end-to-end through `ape_connector_call` (was checked
  at the server layer but dropped before the connector layer).

### Model fallback (P1)
- `resolveChain`: ordered resolution with dead entries skipped; the loop tries
  entries in order per call and records `fallback_used` + the actual serving
  provider (`model_provider` now reflects use, fixing a receipt-honesty bug).

### Memory trust (P1)
- Structural hydration is framed as UNTRUSTED data (same discipline as tool
  output), never as principal instructions.

### Concurrency
- DB migrations are race-idempotent under parallel `open()` (absorbs
  duplicate-column from lost races); verified with a 12-process stress test.

### Semantic recall (structural, not model-gated)
- Every run hydrates its context with similar past outcomes before the loop starts
  (ADAM query + local shingle-cosine ranking, thresholded). No longer depends on the
  model remembering to call `memory.recall`; skipped on resume to avoid duplication.

### Outcome identity + dedup
- Stable family IDs (hash of normalized objective) on every receipt and ledger row.
- Same objective completed within `policy.dedup_window_sec` (default 3600s) reuses
  the prior receipt (`dedup_reuse`) instead of rerunning; skips mocks and resumes.
- `ape_agent_family`: cost-per-outcome + variant tracking; `ape_agent_deprecate`:
  mark dead variants with a reason.

### Parallel tool calls
- All-known, non-destructive multi-call turns fan out concurrently (cap
  `limits.max_parallel`, default 4); mixed/unknown/destructive batches stay
  sequential. `policy.parallel_calls: false` opts out. Mock scripts support
  `{ calls: [...] }` turns; receipt counts `parallel_fanouts`.

### Drift (trajectory health)
- Same-tool wandering injects a one-per-streak advisory (run continues);
  consecutive-error spirals halt as `error_spiral` (counts as a failure for the
  profile-streak proposer). Configurable via `policy.drift`; stats in receipt.

### Checkpoint and resume (#7)
- Loop state checkpoints to `runs.db` after every model turn; `ape_agent_resume`
  (`agent/resume`) forks a replacement worker from the last step. Refuses finished
  runs, live workers, missing checkpoints, and resume-cap excess — all honestly.

### Task-based model routing (P1)
- Worker classifies the objective (trivial/coding/reasoning/general) with an
  explicit rule-based classifier; trivial tasks route to a detected local model
  (free), everything else uses normal resolution. Decision + confidence recorded
  in the receipt for later judgment. Opt out via `policy.routing: false` or an
  explicit provider/model. Verified live: trivial JSON task ran free on local
  llama3.2 with the correct answer.

### Harness evolution from trajectories (#6)
- `ape_agent_analyze {profile, window, record}`: computes completion rate, stop-reason
  distribution, cost/step medians, unverified and repetition rates from the run ledger,
  and proposes concrete profile patches (raise `max_steps` to p90, enforce
  verification, add fallback provider). Optional `record` persists the learning as an
  ADAM belief. Console Agent tab has per-profile [analyze] with patch display.

### Push channel (live runs without polling)
- `GET /api/runs/stream` (SSE): pushes `run`, `step`, and `spend` events by
  diffing the shared `runs.db` every second; console subscribes via EventSource
  with polling fallback. Header spend strip goes live; Runs tab updates in real time.

### A2A bridge (non-MCP agents can use APE runs)
- `GET /.well-known/agent.json` (agent card; bundled profiles as skills) +
  JSON-RPC `POST /a2a` with `message/send`, `tasks/get`, `tasks/cancel`.
- Compatible subset (request/response + polling; no streaming/push in v1); every
  A2A task maps 1:1 onto an audited APE run with artifacts on completion.

### Observability: Runs tab, cost strip, Agent config tab
- **Runs tab**: full agent-run ledger in the console (run list + expandable step
  detail + receipts) via live `/api/runs` + `/api/runs/get`.
- **Cost strip**: header shows today's spend vs `APE_MAX_DAILY_USD` cap + running
  count via `/api/spend`.
- **Destructive highlights**: `agent.destructive` ledger rows render prominently.
- **Agent tab**: profiles + connectors browser with starter templates, in-console
  YAML editor, and validated save to `.ape/profiles|connectors` (path-traversal
  safe). Guidance text covers provider/model/tools/policy/connector authoring.
- Endpoints: `/api/connectors`, `/api/profiles`, `/api/profile`, `/api/templates`,
  `POST /api/profile/save`, `POST /api/connector/save`.

### Harness audit fixes (control-flow review)
- **Destructive bypass closed**: agent-internal calls no longer silently skip
  confirmation. Profile `policy.destructive` (default `deny`) + per-run
  `limits.max_destructive` cap (default 1); every attempt hits the prominent
  `agent.destructive` audit stream (trace + ledger).
- **Connector timeouts**: per-operation `timeout_ms` (default 30s, `AbortController`);
  a hung endpoint can no longer defeat `max_wall_seconds`.
- **Repetition detection**: identical `(tool, args)` N times in a row halts with
  `repetition_detected` (`limits.max_repeats`, default 3).
- **Stale-run janitor**: dead-worker rows reconcile to `worker_gone` on status/run
  calls, preserving partial ledgers.
- **Run-level ceilings**: `APE_MAX_CONCURRENT_RUNS` (4) + `APE_MAX_DAILY_USD` (25),
  both honest-refusals.
- **Tool-output framing**: results re-enter the model marked as untrusted data.
- **Feedback loop**: worker auto-writes a compact outcome memory after every run, so
  the next similar objective has something real to recall; consecutive profile
  failures propose an ADAM `investigate_conflict` mutation once per streak.
- **Grounding gate** (AXIOM evidence): `policy.verify_before_finish` (`warn`/`enforce`/
  `off`); `finish` without verification evidence is rejected (enforce) or flagged
  `unverified` in the ledger + outcome (warn). Makes the §8.2 unverified-claim rate
  directly measurable.
- **Recovery + immunity** (AXIOM self-healing lite): transient tool failures retry once
  (`limits.max_retries`), consulting and recording failure fingerprints in ADAM.
- **Context compression + receipts** (AXIOM P0): history capped at
  `max_history_tokens` with recoverable digests (full data stays in `runs.db`) and
  per-run `tokens_saved_estimate`; every run stores an explicit receipt.
- **Evidence correlation** (AXIOM grounding, reviewer feedback loops): verify-tool
  outputs combine into agree/conflict/insufficient judgments; `policy.evidence:
  agree` requires correlated agreement before finish (no more silent SOUND +
  low-score passes).

### External review fixes (Linux clean-install audit)
- **Safe truncation**: tool `content` text is now truncated at the value level so it is
  always valid JSON (was: sliced serialized string → `Unterminated string` crashes on
  long runs). `structuredContent` still carries the full result. Regression-tested with
  a 15-step run.
- **Host-independent run visibility**: `ape_agent_status` on long runs now emits a
  compact summary in `content.text` (status, stop reason, model, cost, outcome, last 8
  steps, omitted count) so the model can continue even on hosts that never forward
  `structuredContent`. Verified: 24-step run → parseable summary + full 24-step ledger.
- **Resources/prompts conformance**: `resources/list`, `resources/read` (genome, ledgers,
  graph, tasks), `prompts/list`, `prompts/get` now answer with SDK-valid shapes; unknown
  methods return JSON-RPC errors, not mis-shaped results. Verified via the official SDK.
- **Ledger completeness**: hallucinated `unknown_tool` calls are now recorded as steps
  (was: invisible), feeding the §8.2 hallucination metrics.
- **Env overrides honored**: `APE_PROVIDER` / `APE_MODEL` now resolve (were documented
  but unread); precedence explicit args → env → active → stored → local.
- **adamBin() platform-aware**; model steps record real `duration_ms`; node:sqlite
  warning filter matches Node's actual message; connector tests tolerate sandboxed
  non-2xx networks.
- **EVE on clean installs**: `pngjs` was present but vendor deps were never installed;
  `postinstall` now installs genesis+eve deps on first `npm install` (verified live).

### Production hardening (no stubs)
- **Console fully wired**: new live `/api/graph` (skein), `/api/mods` (real hook flags),
  `/api/experience` (recent EVE runs from trace); Graph/Experience/Mods tabs render live
  data on a 10s poll instead of static copy. Live-audit now 20/20.
- **Provider set complete**: added `google` (Gemini OpenAI-compatible) and `opencode`
  (Zen) adapters; `CALLABLE_PROVIDERS` gate honest-skips non-invokable providers
  (e.g. bedrock) instead of crashing at call time.
- **Production packaging**: `.npmignore` + per-vendor `.npmignore` files exclude
  `node_modules`/`__pycache__` (npm-packlist ignores root rules under allowlisted dirs,
  so the exclusions live inside the vendored trees and are re-created by sync-vendors);
  `postinstall` installs genesis+eve deps on first install. Package: 1,652 files /
  13.4 MB with the prebuilt `adam-mcp.exe` included.

### Host-provider autodetection (`provider: auto`)
- APE now detects the provider the platform it's installed in is **currently using**
  (active-session state, not just stored credentials) and reuses its credentials.
- Readers: OpenCode session DB (`opencode.db` → newest `session.model`),
  Claude Code (`~/.claude.json` + OAuth token), Codex (`config.toml` + `auth.json`),
  env keys, local Ollama/llama.cpp probe.
- `provider: auto` is the default for all bundled profiles; explicit provider/model on
  `ape_agent_run` always wins. Resolution precedence: explicit → env → active → stored
  (best-effort) → local.
- Transparency: `ape_status` reports `active_provider` + `detected_providers` (names
  only); the run ledger records resolved `model` + `model_resolution`.
- Security: key material never leaves the worker — not in ledger, status, or responses
  (regression-tested); host stores opened readOnly.
- Fix: `fork()` no longer inherits the parent's `--input-type` execArgv (worker crashed
  under module-stdin harnesses).
- nebius base URL corrected to `https://api.studio.nebius.com/v1`.
- anthropic path supports Claude-session OAuth (Bearer; best-effort refresh) alongside
  `ANTHROPIC_API_KEY`.

## 1.0.0 (fork) — 2026-09-18

Hard fork of `fernandogarzaaa/godmode` at post-PR4 HEAD → **ape-mcp**. Hybrid-native MCP
server with an embedded, user-configurable agent.

### Rename / identity (Phase 0)
- Package + repo: `ape-mcp`; sole bin `ape-mcp` (avoids the Cosmopolitan `ape` loader
  collision).
- Tools renamed `godmode_*` → `ape_*` (required for coexistence of both packages on one
  host).
- `GODMODE_*` env → `APE_*`; data dir `.godmode/` → `.ape/`; manifests, CI, skills,
  tests renamed.
- **EVE-MIRO deleted** (AGPL boundary, venv footprint, zero wired capability). godmode
  keeps it; APE is MIT-only.

### Truth pass (Phase 1)
- **Mod hook system fixed**: `loadMods` now dynamically `import()`s `hooks.js`; the
  `policy-gates` preCall actually fires (was inert `{}`).
- **Async dispatch**: `execFileSync` → `execFile` everywhere; long engine calls no
  longer block the event loop.
- **Wired for real**: `ape_compare` → genesis `compare`; `ape_evolve` accept/reject →
  `adam_accept_mutation`/`adam_reject_mutation`; `ape_report` → real artifact inventory
  + genesis report render; fixed latent `dispatch.eveEntry` bug in `ape_mcp_eval`.
- Gates: zero silent stubs across all tools; `ape-map.yaml` ≡ `TOOL_DEFS` drift test.

### Agent runtime (Phase 2)
- `.ape/profiles/*.yaml` loader (bundled defaults + user overrides, hot reload).
- Reasoning loop (Tool Orchestrator) in a **detached worker process**; `ape_agent_run`
  returns `run_id` immediately.
- Providers: anthropic, openai-compatible (openrouter/local), **mock** (offline
  deterministic — test/demo). Provider fallback chain.
- Budget governor: `max_steps`/`max_tokens`/`max_usd`/`max_wall_seconds`; each halts
  independently; enforced after every model + tool call.
- Run ledger: `.ape/runs.db` via `node:sqlite` (targeted ExperimentalWarning
  suppression), per-step records, `ape://runs/{run_id}`.
- **Persistent ADAM client**: one spawned `adam-mcp` per process; memory calls in a run
  cost ≤1 spawn (gate-tested).
- Bundled profiles: `repo-triage`, `persona-validate`. §8.2 fixed task set authored.

### Connectors (Phase 3)
- Declarative `.ape/connectors/*.yaml`: `egress_allow` enforcement, auth-by-env,
  path/query/body templating, MRTR confirm for destructive ops.
- `ape_connector_list` / `ape_connector_call` tools.
- Flagship: `web` connector (Wikipedia API, no key) + `research-verify` profile.

### dev.ape/agent extension (Phase 4)
- `discover()` declares `dev.ape/agent` v0.1.
- Methods `agent/listProfiles`, `agent/describeProfile`, `agent/run`, `agent/getRun`,
  `agent/cancel` on stdio + HTTP; `ape_agent_cancel` tool parity.
- Real MCP client (SDK) handshake fixed: proper `initialize`/`ping`/notification
  handling with protocol-version negotiation.

### Release (Phase 5)
- `ape-mcp doctor` reports engine build state + **every** sanctioned egress host.
- CI matrix: Ubuntu/Windows/macOS × Node 22/24; license gate; all 4 test files.
- Docs: install, profiles, connectors, mods, security, protocol compat, task set.
- Engines bumped to Node >= 22.5 (built-in `node:sqlite`).

## 1.0.0 (godmode seed lineage)

See godmode's history. APE diverges from godmode at PR4 (2026-09-17).