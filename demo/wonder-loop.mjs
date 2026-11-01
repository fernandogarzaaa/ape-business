// Wonder-in-loop demo: Muse Wonder 1.0 drives the APE loop, and every
// tool call passes through the Sigil gate in invokeTool before dispatch.
// Case is chosen by CASE env: "allow" gates finish to a verified low-risk
// badge, "block" gates finish to a revoked critical fixture badge.
// Requires META_API_KEY (or MODEL_API_KEY). The Sigil index directory is
// threaded through runAgent explicitly (SIGIL_INDEX_DIR is only the
// fallback); it defaults to the pinned demo fixtures, not to the env var.
// In this sandbox, run it with a surrogate key, never a raw key in chat
// or in a file. Usage:
//   CASE=allow META_API_KEY=... node demo/wonder-loop.mjs
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent/loop.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sigilIndexDir = process.env.SIGIL_INDEX_DIR ?? join(root, "demo", "fixtures", "sigil-index");

const gate = process.env.CASE === "block"
  ? { sigilServer: "fixture-server", sigilVersion: "0.1.0" }
  : { sigilServer: "@apify/actors-mcp-server", sigilVersion: "0.17.1" };

const profile = {
  name: "wonder-loop",
  system: "You are a careful agent. Call finish exactly once with the summary you are given, and nothing else.",
  model: { provider: "meta", id: "muse-wonder-1.0" },
  tools: [{ builtin: "finish", ...gate }],
  limits: { max_steps: 4, max_tokens: 60000, max_wall_seconds: 180, max_usd: 0.30 },
  stop_conditions: ["no_tool_call_in_step", "explicit_final_answer", "budget_exhausted"],
  policy: { verify_tools: [], context: { retrieve: false } },
};

const out = await runAgent({
  profile,
  objective: "Call finish with summary exactly: wonder loop test",
  resolvedModel: { provider: "meta", id: "muse-wonder-1.0" },
  sigilIndexDir,
});

const toolSteps = (out.steps ?? []).filter((s) => s.kind === "tool");
console.log(JSON.stringify({
  case: process.env.CASE ?? "allow",
  provider: out.model_provider,
  model: out.model,
  stopReason: out.stop_reason,
  outcome: out.outcome,
  toolSteps: toolSteps.map((s) => ({ tool: s.tool, resultSummary: s.resultSummary })),
  spendUsd: out.spend_by_provider,
}, null, 2));
