import { runEvaluator } from "../../adapters/node/index.js";

// Custom judge: numeric tolerance check. Demonstrates the evaluator side of
// the adapter protocol — arbitrary logic, standard envelope.
await runEvaluator((task, output) => {
  const expected = Number(task.reference);
  const actual = Number(typeof output === "string" ? output.trim() : output);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    return { passed: false, score: 0 };
  }
  const error = Math.abs(actual - expected);
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-6);
  return { passed: error <= tolerance, score: error <= tolerance ? 1 : 0 };
});
