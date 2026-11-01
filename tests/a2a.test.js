import test from "node:test";
import assert from "node:assert";
// Suites share one ledger DB across parallel processes and mock spend
// accumulates: lift both production guards for tests (unit tests cover them
// with explicit params on isolated DBs).
process.env.APE_MAX_CONCURRENT_RUNS ??= "32";
process.env.APE_MAX_DAILY_USD ??= "1000000";
import { agentCard, handleA2A, toTask } from "../src/agent/a2a.js";

test("a2a: agent card advertises skills from bundled profiles", () => {
  const card = agentCard("http://127.0.0.1:9");
  assert.equal(card.name, "ape-mcp");
  assert.ok(card.url.includes("127.0.0.1"));
  assert.equal(card.capabilities.streaming, false);
  const ids = card.skills.map((s) => s.id);
  assert.ok(ids.includes("repo-triage"), "profiles exposed as skills");
  assert.ok(card.skills.every((s) => s.name && s.description !== undefined));
});

test("a2a: toTask maps every run status (artifacts on terminal states)", () => {
  const base = { run_id: "run-x", started_at: new Date().toISOString() };
  assert.equal(toTask({ ...base, status: "running" }).status.state, "working");
  const done = toTask({ ...base, status: "done", stop_reason: "explicit_final_answer", outcome: "ok", finished_at: new Date().toISOString() });
  assert.equal(done.status.state, "completed");
  assert.ok(done.artifacts[0].parts[0].text.includes("ok"), "outcome carried as artifact");
  assert.equal(toTask({ ...base, status: "failed", stop_reason: "m", outcome: "e" }).status.state, "failed");
  assert.equal(toTask({ ...base, status: "stopped", stop_reason: "cancelled" }).status.state, "canceled");
  assert.throws(() => toTask({ run_id: "nope", status: "not_found" }), /not found/);
});

test("a2a: message/send -> tasks/get -> tasks/cancel lifecycle", async () => {
  const sent = await handleA2A("message/send", {
    message: { role: "user", parts: [{ kind: "text", text: "triage this" }], messageId: "m1" },
    metadata: { profile: "repo-triage" },
  });
  assert.ok(sent.id, "task id returned");
  assert.ok(["working", "failed", "completed"].includes(sent.status.state), "task started: " + sent.status.state);
  const got = await handleA2A("tasks/get", { id: sent.id });
  assert.equal(got.id, sent.id);
  const cancelled = await handleA2A("tasks/cancel", { id: sent.id });
  assert.ok(["canceled", "completed", "failed", "working"].includes(cancelled.status.state));
});

test("a2a: unknown method + empty message error honestly", async () => {
  await assert.rejects(handleA2A("nope/method", {}), /unknown_method/);
  await assert.rejects(handleA2A("message/send", { message: { role: "user", parts: [] } }), /text part/);
  await assert.rejects(handleA2A("tasks/get", { id: "missing" }), /not found/);
});

test("a2a: terminal state comes from outcome, never lifecycle alone (W-2)", () => {
  const base = { run_id: "run-x", started_at: new Date().toISOString() };
  // The audit probe: max-steps exhaustion must not read as completed.
  const exhausted = toTask({ ...base, status: "done", stop_reason: "max_steps", outcome: "halted" });
  assert.equal(exhausted.status.state, "failed", "exhaustion is failure to orchestrators");
  assert.ok(exhausted.status.message.parts[0].text.includes("max_steps"), "stop reason in message");
  const incomplete = toTask({ ...base, status: "done", stop_reason: "no_tool_call_in_step", outcome: "" });
  assert.equal(incomplete.status.state, "failed");
  const spiral = toTask({ ...base, status: "done", stop_reason: "error_spiral", outcome: "halted" });
  assert.equal(spiral.status.state, "failed");
  const ok = toTask({ ...base, status: "done", stop_reason: "explicit_final_answer", outcome: "done", finished_at: new Date().toISOString() });
  assert.equal(ok.status.state, "completed");
  const reused = toTask({ ...base, status: "done", stop_reason: "dedup_reuse", outcome: "reused" });
  assert.equal(reused.status.state, "completed", "verified reuse counts as completed");
  const unver = toTask({ ...base, status: "done", stop_reason: "explicit_final_answer", outcome: "x", unverified: 1 });
  assert.equal(unver.status.state, "completed", "unverified claims still deliver, flagged in outcome text");
  // Rows that already carry outcome_status (server path) are honored directly.
  const pre = toTask({ ...base, status: "done", stop_reason: "max_usd", outcome: "", outcome_status: "exhausted" });
  assert.equal(pre.status.state, "failed");
});