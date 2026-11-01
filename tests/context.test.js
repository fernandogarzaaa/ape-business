import test from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Isolate the ledger/stash DB before any lazy open() happens.
process.env.APE_DATA_DIR = mkdtempSync(join(tmpdir(), "ape-context-"));

import {
  truncateToolOutput,
  resolveHygiene,
  validateContextLayer,
  CONTEXT_DEFAULTS,
} from "../src/agent/context.js";
import { stashResult, retrieveResult } from "../src/agent/stash.js";
import { ingestToolResult, runAgent } from "../src/agent/loop.js";
import { internalTools, invokeTool } from "../src/agent/registry.js";
import { loadGlobalConfig, clearGlobalConfigCache } from "../src/globalConfig.js";

// --- truncateToolOutput ---

test("context: under-budget text passes through untouched", () => {
  const r = truncateToolOutput("short result", { toolName: "t" });
  assert.equal(r.truncated, false);
  assert.equal(r.text, "short result");
  assert.equal(r.omittedTokens, 0);
});

test("context: over-budget head-tail preview keeps both ends and names the ref", () => {
  const body = "HEAD-" + "x".repeat(7900) + "-TAIL";
  const r = truncateToolOutput(body, { toolName: "bigtool", ref: "tr-abc123" });
  assert.equal(r.truncated, true);
  assert.ok(r.text.startsWith("HEAD-"), "head preserved");
  assert.ok(r.text.endsWith("-TAIL"), "tail preserved");
  assert.ok(r.text.includes('[truncated ~'), "explicit marker");
  assert.ok(r.text.includes('"bigtool"'), "tool named in marker");
  assert.ok(r.text.includes('tr-abc123'), "ref embedded");
  assert.ok(r.text.includes("context.retrieve"), "retrieval hint present");
  assert.ok(r.omittedTokens > 0);
});

test("context: head and tail modes", () => {
  const body = "HEAD-" + "x".repeat(7900) + "-TAIL";
  const head = truncateToolOutput(body, { mode: "head", toolName: "t" });
  assert.ok(head.text.startsWith("HEAD-") && !head.text.endsWith("-TAIL"), "head only");
  const tail = truncateToolOutput(body, { mode: "tail", toolName: "t" });
  assert.ok(tail.text.endsWith("-TAIL") && !tail.text.startsWith("HEAD-"), "tail only");
});

test("context: marker without ref omits the retrieval hint", () => {
  const r = truncateToolOutput("x".repeat(8000), { toolName: "t" });
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes("[truncated ~"), "marker present");
  assert.ok(!r.text.includes("context.retrieve"), "no retrieval hint without ref");
});

// --- resolveHygiene layering: defaults < global < profile < per-tool ---

test("context: defaults resolve when no config is given", () => {
  assert.deepEqual(resolveHygiene({}), {
    maxTokens: 1500,
    previewTokens: 750,
    mode: "head-tail",
    retrieve: true,
    maxStashChars: 100000,
  });
});

test("context: global < profile < per-tool precedence", () => {
  const h = resolveHygiene({
    global: { max_result_tokens: 2000, per_tool: { noisy: { max_result_tokens: 400 } } },
    profile: { max_result_tokens: 2500, per_tool: { noisy: { max_result_tokens: 600 } } },
    toolName: "noisy",
  });
  assert.equal(h.maxTokens, 600, "profile per-tool beats global per-tool");
  const h2 = resolveHygiene({
    global: { max_result_tokens: 2000 },
    profile: { max_result_tokens: 2500 },
    toolName: "other",
  });
  assert.equal(h2.maxTokens, 2500, "profile beats global");
  const h3 = resolveHygiene({ global: { max_result_tokens: 2000 }, toolName: "other" });
  assert.equal(h3.maxTokens, 2000, "global beats default");
});

test("context: preview is clamped to the max budget", () => {
  const h = resolveHygiene({ profile: { max_result_tokens: 200, preview_tokens: 900 } });
  assert.equal(h.previewTokens, 200);
});

test("context: validateContextLayer clamps garbage and drops unknown fields", () => {
  const v = validateContextLayer({ max_result_tokens: "abc", preview_tokens: 10, mode: "sideways", bogus: 1 });
  assert.equal(v.max_result_tokens, CONTEXT_DEFAULTS.max_result_tokens);
  assert.equal(v.preview_tokens, 100, "clamped to min");
  assert.equal(v.mode, "head-tail", "invalid mode falls back");
  assert.ok(!("bogus" in v), "unknown fields dropped");
});

// --- stash roundtrip ---

test("context: stash stores the full text and retrieval pages through it", () => {
  const full = "0123456789".repeat(2000); // 20000 chars
  const s = stashResult({ runKey: "run-a", tool: "bigtool", fullText: full });
  assert.ok(s.ref && s.stashed, "stashed with ref");
  const p1 = retrieveResult({ runKey: "run-a", ref: s.ref, offsetChars: 0, limitChars: 5000 });
  assert.equal(p1.error, undefined);
  assert.equal(p1.totalChars, 20000);
  assert.equal(p1.returnedChars, 5000);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.text, full.slice(0, 5000));
  const p2 = retrieveResult({ runKey: "run-a", ref: s.ref, offsetChars: 15000, limitChars: 5000 });
  assert.equal(p2.hasMore, false);
  assert.equal(p2.text, full.slice(15000));
  // Walk the whole stash in pages and reassemble: pages tile exactly.
  let rebuilt = "";
  let offset = 0;
  for (;;) {
    const pg = retrieveResult({ runKey: "run-a", ref: s.ref, offsetChars: offset, limitChars: 7000 });
    assert.equal(pg.error, undefined);
    rebuilt += pg.text;
    if (!pg.hasMore) break;
    offset += pg.returnedChars;
  }
  assert.equal(rebuilt, full);
});

test("context: unknown ref and missing run key fail closed", () => {
  assert.equal(retrieveResult({ runKey: "run-a", ref: "tr-nope" }).error, "unknown_ref");
  assert.equal(retrieveResult({ ref: "tr-nope" }).error, "missing_ref");
  assert.equal(retrieveResult({ runKey: "other-run", ref: "tr-nope" }).error, "unknown_ref", "refs are per-run");
  const s = stashResult({ tool: "t", fullText: "abc" });
  assert.equal(s.stashed, false, "no run key: not stashed");
});

test("context: stash caps oversized results", () => {
  const s = stashResult({ runKey: "run-a", tool: "t", fullText: "x".repeat(200), maxChars: 100 });
  assert.equal(s.capped, true);
  const p = retrieveResult({ runKey: "run-a", ref: s.ref });
  assert.equal(p.totalChars, 100);
  assert.equal(p.capped, true);
});

// --- ingestToolResult ---

test("context: ingest passes small results through with no stash write", () => {
  let truncated = 0;
  const r = ingestToolResult({
    runKey: "run-b", toolName: "t", toolCallId: "c1",
    res: { ok: true }, onTruncated: () => truncated++,
  });
  assert.equal(r.truncated, false);
  assert.equal(truncated, 0);
  assert.ok(r.message.content.includes('"ok":true'));
  assert.equal(r.message.role, "tool");
});

test("context: ingest truncates, stashes, and the ref round-trips", () => {
  const big = { blob: "y".repeat(20000) };
  let omitted = 0;
  const r = ingestToolResult({
    runKey: "run-b", toolName: "bigtool", toolCallId: "c2",
    res: big, onTruncated: (n) => { omitted = n; },
  });
  assert.equal(r.truncated, true);
  assert.ok(omitted > 0);
  assert.ok(r.ref, "ref issued");
  assert.ok(r.message.content.includes(r.ref), "ref in the framed message");
  const back = retrieveResult({ runKey: "run-b", ref: r.ref, offsetChars: 0, limitChars: 8000 });
  assert.equal(back.text, JSON.stringify(big).slice(0, 8000), "first page matches the original");
  assert.equal(back.hasMore, true);
});

test("context: ingest honors a profile override that disables truncation", () => {
  const r = ingestToolResult({
    runKey: "run-b", toolName: "t", toolCallId: "c3",
    res: { blob: "y".repeat(20000) },
    policyCtx: { max_result_tokens: 100000 },
  });
  assert.equal(r.truncated, false, "high budget: no truncation");
});

// --- global config ---

test("context: global config loads the context section from the example config", () => {
  clearGlobalConfigCache();
  const cfg = loadGlobalConfig();
  assert.ok(cfg.context && typeof cfg.context === "object");
  assert.equal(cfg.context.max_result_tokens, 1500, "example config is the fallback");
});

// --- registry wiring ---

test("context: context.retrieve is auto-added unless disabled", () => {
  const tools = internalTools({ tools: [{ builtin: "finish" }], policy: {} });
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("context.retrieve"), "auto-added");
  assert.ok(names.includes("finish"), "existing tools untouched");
  const off = internalTools({ tools: [], policy: { context: { retrieve: false } } });
  assert.ok(!off.map((t) => t.name).includes("context.retrieve"), "opt-out respected");
});

test("context: invokeTool dispatches context.retrieve through the stash", async () => {
  const s = stashResult({ runKey: "run-c", tool: "t", fullText: "hello-stash" });
  const tool = internalTools({ tools: [], policy: {} }).find((t) => t.name === "context.retrieve");
  const out = await invokeTool(tool, { ref: s.ref }, { runKey: "run-c", organism_id: "default" });
  assert.equal(out.text, "hello-stash");
  const missing = await invokeTool(tool, { ref: "tr-nope" }, { runKey: "run-c", organism_id: "default" });
  assert.equal(missing.error, "unknown_ref");
  const nokey = await invokeTool(tool, { ref: s.ref }, { organism_id: "default" });
  assert.equal(nokey.error, "missing_ref", "no run key in ctx fails closed");
});

// --- loop integration ---

test("context: agent can call context.retrieve inside the loop", async () => {
  const profile = {
    name: "ctx-profile",
    model: { provider: "mock", id: "mock-model" },
    system: "test",
    tools: [{ builtin: "finish" }],
    limits: { max_steps: 10, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0 },
    stop_conditions: ["no_tool_call_in_step", "explicit_final_answer", "budget_exhausted"],
  };
  const script = [
    { tool: "context.retrieve", args: { ref: "tr-doesnotexist" } },
    { tool: "finish", args: { summary: "done" } },
  ];
  const steps = [];
  const res = await runAgent({
    profile,
    objective: "retrieve a missing ref",
    runId: "ctx-loop-run",
    onStep: (s) => steps.push(s),
    mockScript: script,
  });
  assert.equal(res.stop_reason, "explicit_final_answer");
  const retrieveStep = steps.find((s) => s.kind === "tool" && s.tool === "context.retrieve");
  assert.ok(retrieveStep, "retrieve ran as a first-class tool, not unknown_tool");
  assert.equal(res.receipt.tool_truncations, 0, "no truncation happened");
});

test("context: oversized tool results truncate inside the loop with ledger tags", async () => {
  // Seed the stash, then let the loop's own context.retrieve return a full
  // 8000-char page: with a tiny budget that page itself exceeds the budget and
  // is truncated by the real ingest path — deterministic, no external tools.
  const seed = stashResult({ runKey: "ctx-trunc-run", tool: "seed", fullText: "z".repeat(20000) });
  assert.ok(seed.ref, "seed stashed");
  const profile = {
    name: "ctx-trunc-profile",
    model: { provider: "mock", id: "mock-model" },
    system: "test",
    tools: [{ builtin: "finish" }],
    // Tiny budget so the 8000-char retrieve page truncates deterministically.
    policy: { context: { max_result_tokens: 100, preview_tokens: 50 } },
    limits: { max_steps: 10, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0 },
    stop_conditions: ["no_tool_call_in_step", "explicit_final_answer", "budget_exhausted"],
  };
  const script = [
    { tool: "context.retrieve", args: { ref: seed.ref, limit_chars: 8000 } },
    { tool: "finish", args: { summary: "done" } },
  ];
  const steps = [];
  const res = await runAgent({
    profile,
    objective: "force a truncation",
    runId: "ctx-trunc-run",
    onStep: (s) => steps.push(s),
    mockScript: script,
  });
  assert.equal(res.stop_reason, "explicit_final_answer");
  assert.ok(res.receipt.tool_truncations >= 1, "truncation counted in the receipt");
  const retrieveStep = steps.find((s) => s.kind === "tool" && s.tool === "context.retrieve");
  assert.ok(retrieveStep && retrieveStep.resultSummary.startsWith("trunc:tr-"), "ledger tags the stash ref");
  // The truncation's own ref round-trips through the real stash.
  const ref = retrieveStep.resultSummary.split(" ")[0].slice("trunc:".length).split(":")[0];
  const back = retrieveResult({ runKey: "ctx-trunc-run", ref });
  assert.ok(back.text && !back.error, "stashed full text recoverable by ref");
  assert.ok(back.text.includes("z".repeat(100)), "recovered text is the retrieve page");
});

// --- isContextOverflowError ---

test("context: overflow detector matches provider context-length rejections", async () => {
  const { isContextOverflowError } = await import("../src/agent/context.js");
  assert.equal(isContextOverflowError(new Error("This model's maximum context length is 8192 tokens")), true);
  assert.equal(isContextOverflowError(new Error("context_length_exceeded: too long")), true);
  assert.equal(isContextOverflowError({ status: 400, message: "context_length_exceeded" }), true);
  assert.equal(isContextOverflowError({ statusCode: 413, message: "input too large, reduce the length of the messages" }), true);
  assert.equal(isContextOverflowError(new Error("Prompt is too long for the context window")), true);
});

test("context: overflow detector rejects non-overflow failures", async () => {
  const { isContextOverflowError } = await import("../src/agent/context.js");
  assert.equal(isContextOverflowError(new Error("rate limit exceeded, retry later")), false);
  assert.equal(isContextOverflowError(new Error("no anthropic credential")), false);
  assert.equal(isContextOverflowError({ status: 500, message: "internal server error" }), false);
  assert.equal(isContextOverflowError({ status: 400, message: "invalid tool schema" }), false);
  assert.equal(isContextOverflowError(null), false);
  assert.equal(isContextOverflowError(undefined), false);
});

// --- recoverFromOverflow ---

test("context: recoverFromOverflow halves estimate and keeps the tail", async () => {
  const { recoverFromOverflow, estimateTokens } = await import("../src/agent/context.js");
  const messages = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "assistant", toolCalls: [{ name: "t" }], content: "a".repeat(400) });
    messages.push({ role: "tool", toolCallId: `x${i}`, content: "b".repeat(2000) });
  }
  const before = estimateTokens(messages);
  const rec = recoverFromOverflow(messages);
  assert.ok(rec, "expected a recovery plan");
  assert.equal(rec.before, before);
  assert.ok(rec.after < rec.before, `after (${rec.after}) < before (${rec.before})`);
  assert.ok(rec.compressed > 0, "digested at least one turn");
  assert.equal(rec.messages[0].role, "system", "system head preserved");
});

test("context: recoverFromOverflow returns null at the digest floor", async () => {
  const { recoverFromOverflow } = await import("../src/agent/context.js");
  assert.equal(recoverFromOverflow([{ role: "system", content: "s" }, { role: "user", content: "hi" }]), null);
});
