# Agent patterns on APE

How the industry's high-level agent patterns map onto APE primitives. Every
pattern below inherits the runtime guarantees: per-run budgets, receipts,
evidence gates, checkpoints, and the ledger. Nothing here needs new runtime
code — these are compositions of profiles, `delegate`, Skein graphs, and
the grounding gate.

## 1. Supervisor / workers

One coordinator, many specialists. The supervisor never does specialist work.

```yaml
# supervisor.yaml (bundled)
tools:
  - builtin: delegate        # fan out scoped child runs
  - engine: skein.orchestrate
  - builtin: memory.recall
  - builtin: finish
```

Flow: decompose → `delegate(profile, objective, budget_share)` per
workstream (independent calls in one turn run concurrently, max 2 forks) →
verify each child receipt by `outcome_status` → re-delegate failures →
synthesize with per-child citations. Budget slices come from the supervisor's
*remaining* budget, so the tree cannot outspend its root. Depth-capped at
`max_delegate_depth` (default 2).

## 2. Planner → executor (plan as artifact)

Strategy separated from tactics; the plan is inspectable before execution.

1. Run `planner`: emits a Skein graph via `skein.orchestrate` (`op: node-add`,
   one node per workstream with a `completion` done-criterion) and finishes
   with the graph ID. Cheap budget by design.
2. Review the graph (`graph`/`status`) — edit or reject before any action runs.
3. Executors `claim` nodes, do the work, `release` them with evidence-bearing
   finishes; a supervisor (pattern 1) fans out one `delegate` per node and
   synthesizes under the grounding gate.

The graph is the transaction record: which node, who claimed it, what the
receipt said.

## 3. Hierarchical teams (strategy → tactics → operations)

- **Strategic** (`planner`, `triage-lead`): objective → task graph + synthesis.
- **Tactical** (`supervisor`): graph → delegated sub-runs, progress tracking,
  retries with narrowed scope.
- **Operational** (`deep-researcher`, `code-reviewer`, `repo-triage`):
  single-rung ReAct loops with tight budgets and enforce gates.

Each tier sees less context than the one above (context triage by
construction), runs a cheaper model where the task allows, and reports
receipts upward. The recursive feedback loop is explicit: the tier above
re-delegates unsatisfactory outcomes.

## 4. Generator → critic

Propose, then adversarially verify — APE's oldest pattern, now named:

- Generator: any worker profile finishes with a claim.
- Critic: `genesis.audit_claim` (SOUND / EXPLOITABLE) plus EVE scores,
  correlated by the grounding gate (`evidence: agree` refuses to finish on
  conflict under `verify_before_finish: enforce`).
- `deep-researcher` and `code-reviewer` are prebuilt generator→critic loops;
  `receipt.evidence` carries the artifacts (verdict + digest) for downstream
  consumers.

## Choosing

| Shape of work | Pattern | Entry point |
|---|---|---|
| One question, checkable answer | Single profile (`deep-researcher`) | `ape_agent_run` |
| Parallel independent workstreams | Supervisor fan-out | `supervisor` + `delegate` |
| Long-horizon work needing review-first | Planner → executor | `planner`, then supervised delegates |
| Adversarial correctness | Generator → critic | `code-reviewer`, or any profile + `enforce` |
