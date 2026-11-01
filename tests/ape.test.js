import test from "node:test";
import assert from "node:assert";
// Test workers are $0 mock forks sharing one ledger DB across parallel test
// processes; raise the production concurrency guard so scheduling luck can't
// flake worker-fork tests (the daily spend ceiling still applies).
process.env.APE_MAX_CONCURRENT_RUNS ??= "32";
process.env.APE_MAX_DAILY_USD ??= "1000000";
// W-4: test-only mock-input flag (production servers strip _mockScript).
process.env.APE_ALLOW_MOCK_INPUT ??= "1";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { dispatchCall, toolsList, discover, TOOL_DEFS, safeTruncate, resourcesList, promptsList, readResource, getPrompt } from "../src/server.js";
import { protectedResourceDoc, checkBearer, authRequired } from "../src/auth.js";

test("discover pins 2026-07-28 + tasks ext", () => {
  const d = discover();
  assert.equal(d.protocol, "2026-07-28");
  assert.ok(d.capabilities.extensions["io.modelcontextprotocol/tasks"]);
});
test("tools list deterministic + ttlMs", () => {
  const a = toolsList().tools.map((t) => t.name);
  assert.deepEqual(a, [...a].sort());
  assert.ok(toolsList().ttlMs > 0);
});
test("status complete + structured", async () => {
  const r = await dispatchCall("ape_status", {});
  assert.equal(r.resultType, "complete");
  assert.ok(r.structuredContent.result.engines.genesis);
});
test("destructive evolve requires confirm (MRTR)", async () => {
  const r = await dispatchCall("ape_evolve", { action: "accept", proposal_id: "p1" });
  assert.equal(r.resultType, "input_required");
  assert.ok(r.requestState);
});
test("unknown tooldutifully reported", async () => {
  const r = await dispatchCall("nope_x", {});
  assert.equal(r.structuredContent.result.error, "unknown_tool");
});
test("well-known doc advertises local-open by default", () => {
  const d = protectedResourceDoc("127.0.0.1:1");
  assert.ok(d.resource.includes("127.0.0.1"));
  assert.deepEqual(d.authorization_servers, []);
  assert.equal(d.ape_mode, "local-open");
});
test("bearer open by default (local-only v1)", () => {
  assert.equal(authRequired(), false);
  assert.equal(checkBearer({ headers: {} }).ok, true);
});
test("fetch-adam maps every platform to an asset + local binary when present", async () => {
  const m = await import("../scripts/fetch-adam.mjs");
  assert.equal(m.assetFor("win32", "x64"), "adam-mcp-win-x64.exe");
  assert.equal(m.assetFor("darwin", "arm64"), "adam-mcp-darwin-arm64");
  assert.equal(m.assetFor("linux", "x64"), "adam-mcp-linux-x64");
  // Presence is environment-dependent (win-x64 ships in-repo; other platforms
  // build via cargo or fetch from Release) â€” assert shape, not presence.
  const asset = m.assetFor(process.platform, process.arch);
  assert.ok(asset);
  assert.ok(m.destFor(asset).endsWith(process.platform === "win32" ? "adam-mcp.exe" : "adam-mcp"));
  if (existsSync(m.destFor(asset))) assert.ok(true, "vendored binary present");
});
test("background task runs to done with result", async () => {
  const s = await dispatchCall("ape_task_start", { tool: "ape_status", arguments: {} });
  const id = s.structuredContent.result.task_id;
  assert.ok(id);
  let t = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const g = await dispatchCall("ape_task_get", { task_id: id });
    t = g.structuredContent.result;
    if (t.status === "done" || t.status === "failed") break;
  }
  assert.equal(t.status, "done");
  assert.equal(t.result.structuredContent.result.version, "1.0.0");
});
test("task_start rejects unknown tools (no nesting)", async () => {
  const r = await dispatchCall("ape_task_start", { tool: "nope_x" });
  assert.equal(r.structuredContent.result.error, "unknown_tool");
});
test("ape_beliefs + genome route to vendored ADAM (real binary or explicit unavailable)", async () => {
  const b = await dispatchCall("ape_beliefs", {});
  const g = await dispatchCall("ape_genome", {});
  const br = b.structuredContent.result, gr = g.structuredContent.result;
  const nonOk = ["unavailable", "spawn-error", "exited", "timeout", "rpc-error"];
  if (br._adam === "ok") assert.equal(br.tool, "adam_beliefs");
  else assert.ok(nonOk.includes(br._adam), "explicit not silent: " + br._adam);
  if (gr._adam === "ok") assert.equal(gr.tool, "adam_genome");
  else assert.ok(nonOk.includes(gr._adam), "explicit not silent: " + gr._adam);
});
test("ape_remember persists through real adam-mcp when present", async () => {
  const r = await dispatchCall("ape_remember", { kind: "episodic", content: "test-marker", organism_id: "testorg" });
  const res = r.structuredContent.result;
  if (res._adam === "ok") assert.equal(res.tool, "adam_memory_store");
  else assert.ok(["unavailable", "spawn-error", "exited", "timeout", "rpc-error"].includes(res._adam), "explicit not silent");
});

test("policy-gates mod hook observably mutates args (real hooks.js import)", async () => {
  const { loadMods } = await import("../src/mods.js");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const mods = await loadMods(root);
  const pg = mods.find((m) => m.name === "policy-gates");
  assert.ok(pg, "policy-gates loaded");
  assert.equal(typeof pg.hooks?.preCall, "function", "hooks.js actually imported, not {}");
  const out = await pg.hooks.preCall("ape_evolve", { action: "accept" });
  assert.equal(out._policy, "destructive-confirm-required");
});

test("zero silent stubs across the full tool list", async () => {
  const names = toolsList().tools.map((t) => t.name);
  const samples = {
    ape_remember: { content: "gate-check" },
    ape_recall: { query: "gate" },
    ape_mcp_eval: { target: "http://127.0.0.1:1" },
    ape_validate_experience: { url: "mock:" },
    ape_audit_claim: {},
    ape_compare: {},
    ape_orchestrate: { op: "status" },
    ape_task_get: { task_id: "none" },
    ape_agent_family: { objective: "gate-check" },
    ape_agent_deprecate: { family: "fam-gate", outcome_hash: "deadbeef", reason: "gate-check" },
  };
  for (const n of names) {
    const r = await dispatchCall(n, samples[n] ?? {}, { headlessBypass: true });
    assert.ok(["complete", "input_required"].includes(r.resultType), `${n} resultType=${r.resultType}`);
    const res = r.structuredContent?.result ?? {};
    if (res.error) {
      assert.ok(["engine_not_configured", "unknown_tool", "handler_failed", "profile_not_found", "connector_not_found", "connector_unknown_operation", "missing_args"].includes(res.error), `${n} honest error (${res.error})`);
    }
  }
});

test("map/registry drift: ape-map.yaml tools == TOOL_DEFS", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const map = YAML.parse(readFileSync(join(root, "schemas", "ape-map.yaml"), "utf8"));
  const mapped = new Set(map.tools.map((t) => t.name));
  const defs = new Set(TOOL_DEFS.map((t) => t.name));
  const onlyMap = [...mapped].filter((x) => !defs.has(x));
  const onlyDefs = [...defs].filter((x) => !mapped.has(x));
  assert.deepEqual(onlyMap, [], "tools in map but not registered");
  assert.deepEqual(onlyDefs, [], "tools registered but not in map");
});

test("ape_evolve accept/reject route to real ADAM mutation tools (or explicit unavailable)", async () => {
  const a = await dispatchCall("ape_evolve", { action: "accept", proposal_id: "00000000-0000-0000-0000-000000000000" }, { headlessBypass: true });
  const ar = a.structuredContent.result;
  if (ar._adam === "ok") assert.equal(ar.tool, "adam_accept_mutation");
  else assert.ok(["unavailable", "spawn-error", "exited", "timeout", "rpc-error"].includes(ar._adam), "explicit not silent");
  const rj = await dispatchCall("ape_evolve", { action: "reject", proposal_id: "00000000-0000-0000-0000-000000000000" }, { headlessBypass: true });
  const rr = rj.structuredContent.result;
  if (rr._adam === "ok") assert.equal(rr.tool, "adam_reject_mutation");
  else assert.ok(["unavailable", "spawn-error", "exited", "timeout", "rpc-error"].includes(rr._adam), "explicit not silent");
});

test("dispatchCall accepts stringified arguments (hosts like opencode send JSON strings)", async () => {
  const r = await dispatchCall("ape_agent_run", JSON.stringify({
    profile: "repo-triage",
    objective: "regression",
    _mockScript: [{ tool: "finish", args: { summary: "ok" } }],
  }), { headlessBypass: true });
  const res = r.structuredContent.result;
  assert.notEqual(res.error, "profile_not_found", "string args must be parsed into an object");
  assert.ok(res.run_id, "run started from stringified arguments");
  // And the same call with an object must keep working.
  const r2 = await dispatchCall("ape_agent_run", { profile: "repo-triage", objective: "regression", _mockScript: [{ tool: "finish", args: { summary: "ok" } }] }, { headlessBypass: true });
  assert.ok(r2.structuredContent.result.run_id, "object args still work");
  // Malformed string degrades to {} (honest behavior, not a crash).
  const r3 = await dispatchCall("ape_task_get", "not-json{");
  assert.equal(r3.structuredContent.result.status, "not_found");
});

test("production inputs cannot smuggle mock-test controls (W-4)", async () => {
  const { stripMockInput } = await import("../src/server.js");
  const prev = process.env.APE_ALLOW_MOCK_INPUT;
  delete process.env.APE_ALLOW_MOCK_INPUT;
  try {
    const stripped = stripMockInput({ profile: "p", objective: "o", _mockScript: [{ tool: "finish" }], _mockCostPerCall: 9 });
    assert.ok(!("_mockScript" in stripped) && !("_mockCostPerCall" in stripped), "mock controls stripped by default");
    assert.equal(stripped.profile, "p", "real args preserved");
    assert.equal(stripMockInput(null), null, "null-safe");
  } finally {
    if (prev === undefined) delete process.env.APE_ALLOW_MOCK_INPUT;
    else process.env.APE_ALLOW_MOCK_INPUT = prev;
  }
  process.env.APE_ALLOW_MOCK_INPUT = "1";
  try {
    const kept = stripMockInput({ _mockScript: [{ tool: "finish" }] });
    assert.ok("_mockScript" in kept, "test flag preserves mock input");
  } finally {
    if (prev === undefined) delete process.env.APE_ALLOW_MOCK_INPUT;
    else process.env.APE_ALLOW_MOCK_INPUT = prev;
  }
});

test("tool content text is always valid JSON, even for long multi-step results", async () => {
  // Regression: slicing serialized JSON mid-token crashed clients on 12-step runs.
  // Drive an 11-step mock run (10 tools + finish, within max_steps), then assert the
  // status content parses AND is sufficient without structuredContent.
  const script = Array.from({ length: 10 }, (_, i) => ({ tool: "memory.recall", args: { query: "long-" + i + "-" + "x".repeat(300) } }));
  script.push({ tool: "finish", args: { summary: "done-" + "y".repeat(800) } });
  const r = await dispatchCall("ape_agent_run", {
    profile: "repo-triage",
    objective: "long run",
    _mockScript: script,
  }, { headlessBypass: true });
  const runId = r.structuredContent.result.run_id;
  let st = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((x) => setTimeout(x, 500));
    const g = await dispatchCall("ape_agent_status", { run_id: runId });
    st = g;
    if (st.structuredContent.result.status !== "running") break;
  }
  assert.notEqual(st.structuredContent.result.status, "running", "run reaches a terminal state within 60s");
  const text = st.content[0].text;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { assert.fail("content text must parse as JSON: " + e.message); }
  assert.ok(parsed, "status content parses");
  assert.ok(text.length <= 5000, "content stays bounded");
  // The display payload must be SUFFICIENT for the model even if the host never
  // forwards structuredContent: outcome + recent steps, not a bare marker.
  assert.ok(parsed.outcome && parsed.outcome.includes("done-"), "content carries the outcome");
  assert.ok(Array.isArray(parsed.recent_steps) && parsed.recent_steps.length > 0, "content carries recent steps");
  assert.ok(parsed.steps_omitted >= 0, "content reports omitted count");
  assert.equal(st.structuredContent.result.steps.length > 8, true, "structuredContent keeps the full ledger");
});

test("resources/list + prompts/list are SDK-conformant arrays", () => {
  const rl = resourcesList();
  assert.ok(Array.isArray(rl.resources), "resources is an array");
  assert.ok(rl.resources.every((r) => r.uri && r.name), "each resource has uri + name");
  const pl = promptsList();
  assert.ok(Array.isArray(pl.prompts), "prompts is an array");
  assert.ok(pl.prompts.every((p) => p.name), "each prompt has a name");
});

test("resources/read serves real content; unknown URIs error honestly", async () => {
  const g = await readResource("genome://current");
  assert.ok(Array.isArray(g.contents) && g.contents[0]?.uri === "genome://current");
  const t = await readResource("tasks://current");
  assert.ok(Array.isArray(t.contents));
  await assert.rejects(readResource("nope://x"), /not found/);
  const p = await getPrompt("ape-triage", { topic: "flaky tests" });
  assert.ok(p.messages[0]?.content?.text?.includes("flaky tests"));
  await assert.rejects(getPrompt("nope"), /unknown prompt/);
});
