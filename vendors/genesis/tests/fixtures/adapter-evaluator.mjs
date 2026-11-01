import { runEvaluator } from "../../adapters/node/index.js";

await runEvaluator((task, output) => {
  const actual = output && typeof output === "object" ? output.echo : output;
  const expected = task.input ?? null;
  return { passed: JSON.stringify(actual) === JSON.stringify(expected) };
});
