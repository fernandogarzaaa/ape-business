// LOCKED EVAL SCORER — do not edit in the same PR that edits the agent.
//
// This file is the scorecard for evals/run.mjs. It scores golden-task
// outcomes deterministically: completion, step budget, cost ceiling,
// and required/forbidden outcome content. Changing the agent to pass
// by changing this file is benchmark gaming; harness changes and
// scorer changes land in separate PRs, and scorer changes need a
// human reviewer who did not write the agent change.
export function scoreTask(task, result) {
  const checks = [];
  const expect = task.expect ?? {};
  if (expect.stop_reason) {
    checks.push({ name: 'stop_reason', pass: result.stop_reason === expect.stop_reason, detail: `got ${result.stop_reason}` });
  }
  if (expect.outcome_includes) {
    checks.push({ name: 'outcome_includes', pass: String(result.outcome ?? '').includes(expect.outcome_includes), detail: String(result.outcome ?? '').slice(0, 80) });
  }
  if (expect.max_steps != null) {
    checks.push({ name: 'max_steps', pass: result.step_count <= expect.max_steps, detail: `${result.step_count} <= ${expect.max_steps}` });
  }
  if (expect.max_cost_usd != null) {
    checks.push({ name: 'max_cost_usd', pass: (result.total_cost ?? 0) <= expect.max_cost_usd, detail: `${result.total_cost} <= ${expect.max_cost_usd}` });
  }
  if (expect.min_delegations != null) {
    checks.push({ name: 'min_delegations', pass: (result.delegations?.length ?? 0) >= expect.min_delegations, detail: `${result.delegations?.length ?? 0} delegations` });
  }
  return { task: task.id, pass: checks.every((c) => c.pass), checks };
}

export function scoreAll(tasks, results) {
  const scored = tasks.map((t, i) => scoreTask(t, results[i]));
  return { pass: scored.every((s) => s.pass), scored };
}
