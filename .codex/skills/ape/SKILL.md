---
name: APE
description: Activate the unified APE stack (Genesis + EVE + ADAM + Skein) as one agentic loop. Use when user says APE, validate experience, audit verifier, orchestrate tasks, evolve memory, or persist decisions.
---

# /APE — Unified Product Engine (standalone: vendors/ vendored, no 5-repo clone)

## Shared state (local-only v1)
- ADAM organism → `$APE_DATA_DIR/adam_memory.db` + `adam_genome.json` (or `organism_id` pool)
- Skein graph → `.skein/log.ndjson` (append-only) + derived `graph.json`
- EVE sessions → seeded, reproducible; reports via `ape_report`
- Genesis ledger → hash-chained evidence bundles
- Trace → `.ape/trace.ndjson` (console Live Trace)

## Passive activation (every session, no permission needed)
1. `ape_status` → versions + engines + mods
2. `ape_recall` with task-topic query → prior decisions
3. Report genome/ledger head briefly

## Active loop (per task)
```
BEFORE: ape_recall ("solved before?") + ape_beliefs query
WHILE:  ape_validate_experience (seed always) for UI; ape_audit_claim for verifiers
AFTER:  ape_remember (decision|fix|code|conversation) + ape_orchestrate evidence
EVOLVE: ape_evolve propose → measure (EVE) → accept/reject (governance: values/goals/capabilities/policies need EVE approve; preferences.* ungated; destructive needs confirm)
```

## Tool quick reference
| Need | Tool |
|---|---|
| status | ape_status |
| remember/recall | ape_remember / ape_recall |
| UX sim | ape_validate_experience {url, persona, goal, seed} |
| MCP eval | ape_mcp_eval (via validate path) |
| audit verifier | ape_audit_claim {suite, verifier} |
| compare builds | ape_compare |
| tasks | ape_orchestrate {op: graph/claim/release/status/log} |
| evolve | ape_evolve {action, proposal_id} (+confirm) |
| reports | ape_report |

Seeds always for reproducibility. Long runs return task handles (poll). Console: `ape-mcp` opens Live Trace + CLI pane (same dispatch as MCP).