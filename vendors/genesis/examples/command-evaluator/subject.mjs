import { runSubject } from "../../adapters/node/index.js";

// Candidate: doubles numeric input. Subject side of the adapter protocol.
await runSubject((task) => {
  const raw = typeof task.input === "string" ? task.input : JSON.stringify(task.input);
  const n = Number(raw);
  return Number.isFinite(n) ? String(n * 2) : raw;
});
