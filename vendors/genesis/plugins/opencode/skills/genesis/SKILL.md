---
name: genesis
description: Use when evaluating an AI system, chatbot, agent, RAG pipeline, classifier, or MCP tool; auditing an LLM judge or evaluator; running a versioned benchmark; gating a release on quality/latency/cost regression; or reaching a trust verdict from an evidence bundle. Triggers on evaluate, benchmark, regression gate, judge audit, trust verdict, evidence bundle.
---

# Genesis — evaluation and assurance for AI-native software

A system makes a claim. Genesis determines what evidence is required to
support it — and separately asks whether the evaluator deserves trust.

## When to use what

| Goal | MCP tool | CLI |
|---|---|---|
| Evaluate a system against a spec | `evaluate` | `genesis evaluate spec.yaml --out ./results` |
| Assure an LLM judge / evaluator | `audit_evaluator` (+ `suite`) | `genesis audit-evaluator spec.yaml [--suite math]` |
| Both, combined trust verdict | `trust` | `genesis trust spec.yaml --out ./trust` |
| Run a versioned benchmark | `run_benchmark` / `list_benchmarks` | `genesis run-benchmark sentiment-v1 --subject "cmd"` |
| Compare two runs | `compare_runs` | `genesis compare run-a run-b` |
| CI regression gate | `check_regression` | `genesis regression --base B --candidate C` |
| Summarize a bundle | `read_report` | `genesis report results/` |
| Review the claim first | `show_claim` | `genesis claims spec.yaml` |
| Release-gate a capability | `gate` | `genesis gate spec.yaml` (RELEASE/BLOCK/INCONCLUSIVE) |
| Attest / verify a bundle | — | `genesis attest`, `genesis verify`, `genesis keygen` |

## Writing a spec (no SDK required)

```yaml
name: my-eval
dataset:
  path: ./cases.jsonl        # json/jsonl/csv/yaml/text/dir/stdin/inline
subject:
  command: "python agent.py {task_file}"   # any executable; stdout is output
evaluator:
  type: exact                # exact|regex|json_schema|javascript|command|
                             # llm_command|human|oracle|composite|
                             # classification|retrieval|pass_through
metrics: [task_success]
thresholds:
  task_success: ">=0.90"
```

Subjects and judges are arbitrary commands honoring `adapters/PROTOCOL.md`
(`{task_file}`, `{input}`, `{output_file}` placeholders). Patients over
frameworks: never ask the user to rewrite their app.

## Reading results

- System verdicts: `SUPPORTED | FALSIFIED | INCONCLUSIVE | INVALID | UNTESTED`.
- Evaluator verdicts: `SOUND | EXPLOITABLE | UNRELIABLE | OVER_STRICT` — an
  evaluator's output is an observation, never ground truth.
- Combined trust: `TRUSTED | UNTRUSTED | INCONCLUSIVE`. A SUPPORTED system
  under an EXPLOITABLE judge is UNTRUSTED. `INCONCLUSIVE` is legitimate —
  report it, don't round it up.
- Every verdict states its boundaries (dataset + digest, N, conditions,
  uncertainty). Never claim more than the population supports.

## Rules

- Prefer `trust` over `evaluate` when the conclusion will be acted on.
- Assure custom judges (`audit_evaluator`, ideally with `--suite`) before
  promoting any LLM-judged result.
- Gate releases with `check_regression` / `genesis regression`, not raw scores.
- Evidence bundles (`manifest/claim/spec/dataset/results/metrics/statistics/
  findings/evidence/verdict`) are the audit trail — link them, don't paste
  scores from memory.
