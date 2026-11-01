# Agent profiles

A profile is the user-editable definition of what the agent *is*. Loaded at call time —
no restart. Bundled defaults live in `profiles/`; user overrides in `.ape/profiles/` win.

## Bundled specialists (high-level agents, L1)

Single-purpose profiles compose the engines into specialists. Pick the profile,
write one objective sentence, run:

| Profile | Composes | For |
|---|---|---|
| `repo-triage` | recall + audit + plan | Sorting out software issues |
| `research-verify` | web + recall + verify | Checking a claim with citations |
| `persona-validate` | EVE + recall + store | Testing an experience as different users |
| `deep-researcher` | web + recall + audit (`enforce`) | Broad research ending in an audited verdict |
| `code-reviewer` | audit (`enforce`) + recall | Adversarial review of a code claim/diff pasted in the objective (no repo access — the code travels in the objective) |
| `triage-lead` | Skein graph + audit + recall | Decomposing an issue into checkable workstreams + synthesis |
| `planner` | Skein graph + recall, cheap budget | Strategy only: emits a task graph for executors, never executes |
| `supervisor` | delegate + Skein graph + recall | Coordinates specialist child runs and synthesizes their receipts |

`planner` and `triage-lead` are structured for the delegation primitive (L2):
small, independently checkable nodes a supervisor can later fan out.

## Delegation (supervisor primitive, L2)

A run with the `delegate` builtin tool can spawn scoped child runs:

```yaml
tools:
  - builtin: delegate
  - builtin: finish
limits:
  max_delegate_depth: 2   # recursion cap; 0 disables delegation
```

`delegate(profile, objective, budget_share?, timeout_s?)` runs a real child
worker to completion and returns its receipt summary as framed (untrusted)
tool output. Rules:

- **Budget slices from remaining budget**: `budget_share` (default 0.25, max
  0.5) scales the parent's *remaining* steps/tokens/USD/wall — parent plus
  children can never exceed the parent ceiling. The child's effective limits
  are min(own profile, slice).
- **Depth-capped**: `depth >= max_delegate_depth` refuses honestly; at most 2
  delegations fan out per turn (overflow runs sequentially).
- **Fully audited**: child rows carry `parent_run_id`; parent receipts log
  `delegations[]` + `delegated_cost_usd`; child receipts echo the linkage.
  Child admission goes through the same caps as top-level runs.
- **Failures are non-fatal**: refused/admitted/timeout/depth errors return as
  tool results — the parent sees them and continues. Hangs are killed at
  `timeout_s` (default 120s, capped by remaining wall).

## Anatomy

```yaml
name: repo-triage
description: Triages incoming issues against the codebase and proposes a plan.
model:
  provider: anthropic          # anthropic | openai | openrouter | local | mock
  id: claude-sonnet-4-6
  fallback: { provider: openrouter, id: anthropic/claude-sonnet-4-6 }
system: |
  You triage issues. Always call memory.recall before proposing.
tools:                          # what the agent may call inside its loop
  - engine: skein.orchestrate
  - engine: genesis.audit_claim
  - connector: web              # user-defined, see connectors.md
  - builtin: memory.recall
  - builtin: memory.store
  - builtin: finish             # terminal: model calls finish(summary) when done
limits:                         # budget governor — enforced every step
  max_steps: 12
  max_tokens: 120000
  max_wall_seconds: 300
  max_usd: 0.50
  max_destructive: 1            # cap on unattended destructive calls (when allowed)
  max_repeats: 3                # halt if the same (tool, args) repeats this often
  max_delegate_depth: 2         # cap on delegate chains (0 = no delegation)
policy:                         # loop policy
  destructive: deny              # deny (default) | allow. Allow is still capped + audited
  verify_before_finish: warn    # warn (default) | enforce | off
  evidence: any                 # any (presence passes) | agree (verdicts must agree, no refutations)
  eve_threshold: 50             # EVE score at/above this counts as supporting evidence
  routing: true                 # task-based model routing (default on for provider:auto; explicit provider/model bypasses it)
  context: {}                   # truncation/retrieval knobs; see "Context hygiene" (global defaults in ape.config.yaml)
stop_conditions:
  - no_tool_call_in_step
  - explicit_final_answer
  - budget_exhausted
```

## Providers

**`provider: auto` is the default** — APE detects the provider the platform it's
installed in is *currently using* and reuses its credentials. Nothing about which provider
is hardcoded; resolution is dynamic and run-time.

Detection reads, in order:
1. **Explicit** `provider`/`model` on `ape_agent_run`, then `APE_PROVIDER`/`APE_MODEL` env.
2. **Active provider** — the platform's current session state:
   - OpenCode: newest `session.model` in `opencode.db` (e.g. `nebius` + `deepseek-ai/DeepSeek-V4-Flash-0731`).
   - Claude Code: `~/.claude.json` `model` + OAuth access token (Bearer).
   - Codex: `config.toml` `model` + `auth.json` token.
   - env: `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/… (+ `*_MODEL`).
3. **Stored-credential fallback** (marked `best-effort`).
4. **Local** — Ollama / llama.cpp probe.

| detected provider | credential source |
|---|---|
| `nebius`, `groq`, `openrouter`, `openai`, `ollama-cloud` | host store / env key (OpenAI-compatible) |
| `anthropic` | `ANTHROPIC_API_KEY` env, or Claude session OAuth token (Bearer; needs a valid session) |
| `local` | Ollama / llama.cpp at `localhost` |

`ape_status` reports `active_provider` and `detected_providers` (names only — keys are
never exposed). The run ledger records the resolved `model` and `model_resolution`
(`explicit` / `active` / `best-effort`) so every run shows exactly what it used.

A profile may still pin a provider or model explicitly — that always wins over detection:

## Tool entries

- `engine: <engine>.<tool>` — calls the corresponding `ape_<tool>` tool.
  Known engines: `genesis`, `eve`, `adam`, `skein`. E.g. `engine: genesis.audit_claim`
  → `ape_audit_claim`.
- `builtin: memory.recall` / `builtin: memory.store` — ADAM durable memory.
- `builtin: finish` — the explicit-final-answer terminal.
- `connector: <name>` — a user-defined connector (see connectors.md).

## Task-based routing

When `provider: auto` (the default), the worker classifies the objective before
resolving the model: **trivial** tasks (parse, extract, format, list) route to a
detected local model (free); everything else uses normal resolution. The decision
(category, confidence, reason) is recorded in the run receipt, so routing quality can
be judged from the ledger later. Explicit `provider`/`model` on the run, or
`policy: { routing: false }`, bypasses routing entirely.

## Structural recall

Every run automatically hydrates its context with similar past outcomes before the
loop starts (ranked by text similarity, thresholded — no match means no injection).
This does not depend on the model remembering to call `memory.recall`; the next run
on a related objective starts with what worked and what failed.

## Outcome dedup

Runs carry a stable **family id** (hash of the normalized objective). A prior run
is reused only when ALL hold: same family + organism, finished inside
`policy.dedup_window_sec` (default 3600, 0 = off), terminal state was a **verified
success** (`explicit_final_answer` with no unverified flag), and profile hash, env
fingerprint (connector surface), and resolved model all match. Anything else
reruns — unverified, budget/drift-halted, or reconfigured runs never dedup.
Cost-per-outcome and variant tracking per family: `ape_agent_family`; mark dead
variants: `ape_agent_deprecate`.

## Parallel calls

Independent tool calls issued together in one turn run concurrently (`Promise.all`).
Only all-known, non-destructive batches fan out (capped by `limits.max_parallel`,
default 4); mixed batches stay sequential so audit and destructive caps keep their
order. Opt out with `policy.parallel_calls: false`. Fan-outs are counted in the
receipt (`parallel_fanouts`) and flagged on steps.

## Drift

Beyond exact-repeat halts, the loop watches trajectory health: same-tool wandering
(warn, advisory injected, run continues) and consecutive-error spirals (halt as
`error_spiral`). Configure with `policy.drift: { warn_streak, max_errors }`
(defaults 6 and 4); `policy.drift: false` opts out. Stats land in the receipt
(`drift: { max_same_tool_streak, max_consecutive_errors, warnings }`).

## Model fallback

`model.fallback` (object or list) is a live provider chain, not config
decoration: the worker resolves every entry up front, skipping entries with no
credential, and the loop tries them in order per model call. The receipt records
`fallback_used` and the actual serving provider (`model_provider` reflects use,
not configuration). The analyzer's fallback recommendations now take effect.

## Memory trust

Recalled memory (structural hydration) is **untrusted data**, framed with the
same banner discipline as tool output. It is injected as context, never as
principal instructions alongside the objective.

## Credential policy

`provider: auto` reuses ambient host credentials — convenient and a privilege
boundary. Profiles opt into explicit scoping:

```yaml
policy:
  credential_policy:
    allow: [local, anthropic]        # resolved chain is filtered; others never serve
    max_spend_usd: { anthropic: 1.0 } # per-provider, per-run spend caps
```

- `allow` filters the resolved chain in the worker (routed local models
  included); an empty result fails honestly with `no_provider`. Policy wins
  over explicit provider overrides. Absent `allow` = current behavior.
- `max_spend_usd` is enforced per model turn with live attribution: capped
  entries are skipped, spend shifts down the fallback chain, and full
  exhaustion halts as `spend_capped` (outcome: `exhausted`). Spend by provider
  is in every receipt (`spend_by_provider`) and survives resume.

## Evidence artifacts

Verification gates consume full verifier results (capped 8k, held in-memory
for the run), never the 300-char ledger summaries. Successful verify-tool
calls produce artifacts `{evidence_id, tool, step, verdict, digest, excerpt}`
in `receipt.evidence`; digests pin the exact bytes judged. Artifacts survive
resume via checkpoint state.

## Checkpoint and resume

The loop checkpoints its state (messages, budget, counters) after every model turn
into `runs.db`. A stopped or failed run with a checkpoint can be resumed with
`ape_agent_resume {run_id}` (or `agent/resume`), which forks a replacement worker
from the last step. Completed runs refuse; live workers must be cancelled first;
resumes are capped (`APE_MAX_RESUMES`, default 3).

## Context hygiene

Bulky tool results are never silently sliced. When a result exceeds the
truncation budget, the loop stores the full text in `runs.db` (a per-run
stash) and the model sees a head-tail preview with an explicit
`[truncated ...]` marker naming a ref. The agent recovers the original on
demand through the auto-added `context.retrieve` tool, which returns bounded
pages (max 8000 chars per call) so a page can never re-create the overflow
truncation was meant to prevent. Every field is optional; precedence is
built-in defaults < `ape.config.yaml` `context:` < profile `policy.context`
< per-tool overrides.

```yaml
policy:
  context:
    max_result_tokens: 1500   # truncate results over ~this many tokens
    preview_tokens: 750       # preview budget kept in context
    mode: head-tail           # head | tail | head-tail
    retrieve: true            # expose context.retrieve (false disables it)
    max_stash_chars: 100000   # cap on the full text kept per result
    per_tool:                 # per-tool overrides, e.g. noisy tools
      skein.orchestrate: { max_result_tokens: 500 }
```

Truncations are counted in `receipt.tool_truncations` (also top-level on the
result), ledger tool steps are tagged `trunc:<ref>:~<tokens>t`, and the
counter survives checkpoint/resume. Refs are per-run: a ref from one run
cannot read another run's stash. Stash rows older than 7 days are pruned on
write.

## The reasoning loop

```
load profile → hydrate context
  ↓
loop until stop condition:
  model call (system + history + internal tool schemas)
    ↓
  if tool_call: route to engine | connector | builtin; append result; record step; check budget
    ↓
  if finish / no tool call / budget exhausted: stop
  ↓
persist run to .ape/runs.db, return outcome + run_id
```

The host sees one tool call (`ape_agent_run`); the loop is APE's implementation.
Every step is recorded in the run ledger: tool, args hash, duration, tokens, cost.