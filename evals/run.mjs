#!/usr/bin/env node
// Locked-eval runner: executes evals/tasks.json against the APE loop
// with the mock provider (hermetic, no keys, no network) and scores
// with evals/score.mjs. Exit 1 on any regression. Run in CI on every
// change; a red eval blocks merge exactly like a red test.
import { readFileSync } from 'node:fs';
import { runAgent } from '../src/agent/loop.js';
import { scoreAll } from './score.mjs';

process.env.APE_ALLOW_MOCK_INPUT ??= '1';
process.env.APE_MAX_DAILY_USD ??= '1000000';

const { tasks } = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));

const baseProfile = {
  name: 'eval-profile',
  model: { provider: 'mock', id: 'mock-model' },
  system: 'Be careful. Verify before claiming.',
  // Builtin tools only: engine tools execute for real (ADAM binary,
  // installed implementations) and would make CI depend on the host.
  tools: [
    { builtin: 'memory.recall' },
    { builtin: 'memory.store' },
    { builtin: 'finish' },
  ],
  limits: { max_steps: 20, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0 },
  stop_conditions: ['no_tool_call_in_step', 'explicit_final_answer', 'budget_exhausted'],
};

const results = [];
for (const task of tasks) {
  const profile = { ...baseProfile, limits: { ...baseProfile.limits, ...(task.limits ?? {}) } };
  results.push(await runAgent({
    profile, objective: task.objective, mockScript: task.script,
  }));
}

const { pass, scored } = scoreAll(tasks, results);
for (const s of scored) {
  console.log(`${s.pass ? 'PASS' : 'FAIL'} ${s.task}: ${s.checks.map((c) => `${c.name}=${c.pass ? 'ok' : 'FAIL(' + c.detail + ')'}`).join(' ')}`);
}
console.log(pass ? `EVALS PASSED: ${scored.length}/${scored.length}` : 'EVALS FAILED');
process.exit(pass ? 0 : 1);
