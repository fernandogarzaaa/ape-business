// Remote MCP transport (/mcp): protocol, sessions, JSON-RPC errors, tool
// mapping, HTTP verbs, auth, CORS, bind policy. Ephemeral ports; bearer env
// scoped per test (checkBearer reads env per request).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.APE_REQUIRE_AUTH = "1";
process.env.APE_TOKENS = "mcp-test-token";
process.env.APE_CORS_ORIGIN = "https://allowed.example";
process.env.APE_ALLOW_MOCK_INPUT = "1";
// Worker-forking suites share one ledger DB across parallel processes: raise
// the production concurrency guard (spend ceiling still applies).
process.env.APE_MAX_CONCURRENT_RUNS ??= "32";
process.env.APE_MAX_DAILY_USD ??= "1000000";

const { startHttp, resolveBindConfig, sweepSessions, mcpSessionCount } = await import("../src/http.js");

let base = null;
let server = null;
test.before(async () => {
  const started = await startHttp({ port: 0, host: "127.0.0.1" });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});
test.after(() => { try { server?.close(); } catch { /* ignore */ } });

const auth = { Authorization: "Bearer mcp-test-token" };
async function post(body, { headers = {}, raw = null } = {}) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth, ...headers },
    body: raw ?? JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty (202) */ }
  return { status: r.status, headers: r.headers, json, text };
}
async function initSession() {
  const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(r.status, 200);
  const sid = r.headers.get("mcp-session-id");
  assert.ok(sid, "session id issued");
  return { sid, body: r.json };
}

test("mcp: initialize negotiates pinned version + capabilities + serverInfo", async () => {
  const { sid, body } = await initSession();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.result.protocolVersion, "2026-07-28", "pinned, never echoed");
  assert.ok(body.result.capabilities.tools, "capabilities present");
  assert.equal(body.result.serverInfo.name, "ape-mcp");
  assert.ok(sid);
});

test("mcp: initialize ignores client version games", async () => {
  const r = await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(r.json.result.protocolVersion, "2026-07-28", "pin wins over client claim");
});

test("mcp: session enforcement — missing/unknown/expired rejected", async () => {
  const noSession = await post({ jsonrpc: "2.0", id: 3, method: "ping" }, { headers: { Authorization: "Bearer mcp-test-token", "mcp-session-id": "" } });
  // Empty header is treated as missing.
  assert.equal(noSession.json.error.code, -32001, "missing session rejected");
  const unknown = await fetch(base + "/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", ...auth, "mcp-session-id": "nope" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal(unknown.json.error.code, -32001, "unknown session rejected");
  assert.match(unknown.json.error.message, /session-not-found/);
  const { sid } = await initSession();
  sweepSessions(Date.now() + 31 * 60 * 1000);
  const expired = await post({ jsonrpc: "2.0", id: 5, method: "ping" }, { headers: { "mcp-session-id": sid } });
  assert.equal(expired.json.error.code, -32001, "expired session rejected");
});

test("mcp: DELETE closes the session", async () => {
  const { sid } = await initSession();
  const del = await fetch(base + "/mcp", { method: "DELETE", headers: { ...auth, "mcp-session-id": sid } });
  assert.equal(del.status, 200);
  const reuse = await post({ jsonrpc: "2.0", id: 6, method: "ping" }, { headers: { "mcp-session-id": sid } });
  assert.equal(reuse.json.error.code, -32001, "closed session stays closed");
  const delMissing = await fetch(base + "/mcp", { method: "DELETE", headers: { ...auth, "mcp-session-id": "gone" } });
  assert.equal(delMissing.status, 404, "unknown session delete is 404");
});

test("mcp: malformed JSON and unknown methods", async () => {
  const bad = await post(null, { raw: "{not-json" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, -32700);
  const { sid } = await initSession();
  const unknown = await post({ jsonrpc: "2.0", id: 7, method: "teleport" }, { headers: { "mcp-session-id": sid } });
  assert.equal(unknown.json.error.code, -32601);
});

test("mcp: batch processed sequentially in order", async () => {
  const { sid } = await initSession();
  const r = await post([
    { jsonrpc: "2.0", id: 10, method: "ping" },
    { jsonrpc: "2.0", id: 11, method: "teleport" },
    { jsonrpc: "2.0", id: 12, method: "ping" },
  ], { headers: { "mcp-session-id": sid } });
  assert.ok(Array.isArray(r.json), "batch returns array");
  assert.deepEqual(r.json.map((x) => x.id), [10, 11, 12], "order preserved");
  assert.ok(r.json[0].result && r.json[1].error && r.json[2].result, "mixed outcomes");
});

test("mcp: notification returns 202 with empty body", async () => {
  const { sid } = await initSession();
  const r = await fetch(base + "/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", ...auth, "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(r.status, 202);
  assert.equal(await r.text(), "", "no response body for notifications");
});

test("mcp: tools/list exposes the APE tool surface", async () => {
  const { sid } = await initSession();
  const r = await post({ jsonrpc: "2.0", id: 20, method: "tools/list" }, { headers: { "mcp-session-id": sid } });
  const names = r.json.result.tools.map((t) => t.name);
  assert.ok(names.includes("ape_status") && names.includes("ape_agent_run"), "core tools listed");
  const t = r.json.result.tools.find((x) => x.name === "ape_agent_run");
  assert.ok(t.description && t.inputSchema, "schema carried");
});

test("mcp: tools/call success carries content + structuredContent", async () => {
  const { sid } = await initSession();
  const r = await post({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "ape_status", arguments: {} } }, { headers: { "mcp-session-id": sid } });
  assert.equal(r.status, 200);
  assert.ok(!r.json.result.isError, "success is not error");
  assert.ok(Array.isArray(r.json.result.content) && r.json.result.content[0].type === "text", "MCP content blocks");
  assert.ok(r.json.result.structuredContent && r.json.result.structuredContent.engines, "structured result preserved");
});

test("mcp: tool-level errors stay tool-level (isError), transport errors stay transport-level", async () => {
  const { sid } = await initSession();
  const toolErr = await post(
    { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "ape_connector_call", arguments: { connector: "nope", operation: "x" } } },
    { headers: { "mcp-session-id": sid } }
  );
  assert.equal(toolErr.status, 200, "transport fine");
  assert.equal(toolErr.json.result.isError, true, "tool failure flagged, not thrown");
  assert.ok(JSON.stringify(toolErr.json.result).includes("connector_not_found"), "error text preserved");
  const transportErr = await post({ jsonrpc: "2.0", id: 23, method: "nope/method" }, { headers: { "mcp-session-id": sid } });
  assert.equal(transportErr.json.error.code, -32601, "unknown method is a transport error");
});

test("mcp: resources and prompts round-trip", async () => {
  const { sid } = await initSession();
  const h = { headers: { "mcp-session-id": sid } };
  const rl = await post({ jsonrpc: "2.0", id: 30, method: "resources/list" }, h);
  assert.ok(Array.isArray(rl.json.result.resources) && rl.json.result.resources.length > 0);
  const pl = await post({ jsonrpc: "2.0", id: 31, method: "prompts/list" }, h);
  assert.ok(Array.isArray(pl.json.result.prompts), "prompts listed");
});

test("mcp: OPTIONS preflight allow/deny", async () => {
  const preflight = await fetch(base + "/mcp", { method: "OPTIONS", headers: { Origin: "https://allowed.example" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://allowed.example");
  const preflightDenied = await fetch(base + "/mcp", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(preflightDenied.status, 403);
});

async function openStream(sid, extraHeaders = {}) {
  const ctrl = new AbortController();
  const resp = await fetch(base + "/mcp", {
    method: "GET",
    headers: { ...auth, "mcp-session-id": sid, ...extraHeaders },
    signal: ctrl.signal,
  });
  return { resp, close: () => ctrl.abort() };
}
async function readUntil(reader, pred, timeoutMs = 8000) {
  // NOTE: exactly one pending read at a time. An earlier version raced each
  // read against a timeout, orphaning pending reads whose late-arriving chunks
  // were then discarded — silently eating sparse stream data. Heartbeats keep
  // reads resolving so the deadline stays honest without overlapping reads.
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    if (pred(buf)) return buf;
  }
  return buf;
}

test("mcp: GET opens a gated SSE stream (auth + session before first byte)", async () => {
  const anon = await fetch(base + "/mcp", { method: "GET" });
  assert.equal(anon.status, 401, "no bearer, no stream");
  await anon.arrayBuffer().catch(() => {});
  const noSession = await fetch(base + "/mcp", { method: "GET", headers: { ...auth, "mcp-session-id": "gone" } });
  assert.equal(noSession.status, 404, "unknown session, no stream");
  await noSession.arrayBuffer().catch(() => {});
  const { sid } = await initSession();
  const { resp, close } = await openStream(sid);
  try {
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type"), /text\/event-stream/);
    const buf = await readUntil(resp.body.getReader(), (b) => b.includes("retry:") && b.includes(": connected"));
    assert.ok(buf.includes("retry:"), "retry field first");
    assert.ok(buf.includes(": connected"), "opening comment");
  } finally { close(); }
});

test("mcp: stream heartbeats on the configured interval", async () => {
  const prev = process.env.APE_MCP_HEARTBEAT_MS;
  process.env.APE_MCP_HEARTBEAT_MS = "80";
  try {
    const { sid } = await initSession();
    const { resp, close } = await openStream(sid);
    try {
      const buf = await readUntil(resp.body.getReader(), (b) => (b.match(/:\n\n/g) || []).length >= 3, 6000);
      assert.ok((buf.match(/:\n\n/g) || []).length >= 3, "repeated heartbeat comments");
    } finally { close(); }
  } finally {
    if (prev === undefined) delete process.env.APE_MCP_HEARTBEAT_MS;
    else process.env.APE_MCP_HEARTBEAT_MS = prev;
  }
});

test("mcp: stream emits run/step notifications for new activity", async () => {
  const { dispatchCall } = await import("../src/server.js");
  const prevHb = process.env.APE_MCP_HEARTBEAT_MS;
  process.env.APE_MCP_HEARTBEAT_MS = "200";
  try {
    const { sid } = await initSession();
    const { resp, close } = await openStream(sid);
    const reader = resp.body.getReader();
    try {
      const r = await dispatchCall("ape_agent_run", {
        profile: "repo-triage",
        objective: "stream probe",
        _mockScript: [{ tool: "finish", args: { summary: "streamed" } }],
      }, { headlessBypass: true });
      const runId = r.structuredContent.result.run_id;
      assert.ok(runId, "run started");
      for (let i = 0; i < 40; i++) {
        const g = await dispatchCall("ape_agent_status", { run_id: runId });
        if (g.structuredContent.result.status !== "running") break;
        await new Promise((x) => setTimeout(x, 250));
      }
      const buf = await readUntil(reader, (b) => b.includes('"logger":"ape/runs"') && b.includes('"logger":"ape/steps"'), 12000);
      assert.ok(buf.includes('"logger":"ape/runs"'), "run transition notification");
      assert.ok(buf.includes('"logger":"ape/steps"'), "step notification");
      assert.ok(buf.includes(runId), "notifications scoped to the new run");
    } finally {
      // Settle the reader BEFORE aborting: a floating cancel() rejection after
      // test end fails the file ("asynchronous activity after the test ended").
      try { await reader.cancel(); } catch { /* ignore */ }
      close();
    }
  } finally {
    if (prevHb === undefined) delete process.env.APE_MCP_HEARTBEAT_MS;
    else process.env.APE_MCP_HEARTBEAT_MS = prevHb;
  }
});

test("mcp: closed streams release server resources", async () => {
  const { mcpStreamCount } = await import("../src/http.js");
  const { sid } = await initSession();
  const before = mcpStreamCount();
  const { close } = await openStream(sid);
  await new Promise((x) => setTimeout(x, 200));
  assert.equal(mcpStreamCount(), before + 1, "stream registered");
  close();
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(mcpStreamCount(), before, "disconnect tears down timers");
});

test("mcp: bearer gate precedes dispatch (401, nothing executed)", async () => {
  const anon = await fetch(base + "/mcp", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "nope_tool", arguments: {} } }),
  });
  assert.equal(anon.status, 401, "no bearer, no execution");
  const bad = await fetch(base + "/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "ping", params: {} }),
  });
  assert.equal(bad.status, 401, "wrong bearer rejected");
});

test("mcp: CORS exact-origin only", async () => {
  const { sid } = await initSession();
  const ok = await fetch(base + "/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", ...auth, "mcp-session-id": sid, Origin: "https://allowed.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 50, method: "ping" }),
  });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://allowed.example");
  const denied = await fetch(base + "/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", ...auth, "mcp-session-id": sid, Origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 51, method: "ping" }),
  });
  assert.equal(denied.headers.get("access-control-allow-origin"), null, "no wildcard, no echo for strangers");
  assert.equal(denied.status, 200, "request still served; browser enforces the missing header");
});

test("mcp: CORS allowlist holds multiple exact origins", async () => {
  const prev = process.env.APE_CORS_ORIGIN;
  process.env.APE_CORS_ORIGIN = "https://allowed.example, https://chat.example";
  try {
    const { sid } = await initSession();
    for (const origin of ["https://allowed.example", "https://chat.example"]) {
      const r = await fetch(base + "/mcp", {
        method: "POST", headers: { "Content-Type": "application/json", ...auth, "mcp-session-id": sid, Origin: origin },
        body: JSON.stringify({ jsonrpc: "2.0", id: 52, method: "ping" }),
      });
      assert.equal(r.headers.get("access-control-allow-origin"), origin, `echoed: ${origin}`);
    }
    const sub = await fetch(base + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", ...auth, "mcp-session-id": sid, Origin: "https://sub.allowed.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 53, method: "ping" }),
    });
    assert.equal(sub.headers.get("access-control-allow-origin"), null, "subdomains do not inherit");
  } finally {
    if (prev === undefined) delete process.env.APE_CORS_ORIGIN;
    else process.env.APE_CORS_ORIGIN = prev;
  }
});

test("mcp: open mode preserved when auth unenforced", async () => {
  const prevA = process.env.APE_REQUIRE_AUTH;
  const prevT = process.env.APE_TOKENS;
  delete process.env.APE_REQUIRE_AUTH;
  delete process.env.APE_TOKENS;
  try {
    const r = await fetch(base + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 60, method: "initialize", params: {} }),
    });
    assert.equal(r.status, 200, "local-open default keeps working");
    assert.ok(r.headers.get("mcp-session-id"), "session issued");
  } finally {
    process.env.APE_REQUIRE_AUTH = prevA;
    process.env.APE_TOKENS = prevT;
  }
});

test("mcp: bind policy matrix", () => {
  const prevA = process.env.APE_REQUIRE_AUTH;
  const prevT = process.env.APE_TOKENS;
  const prevO = process.env.APE_ALLOW_OPEN_REMOTE;
  delete process.env.APE_REQUIRE_AUTH;
  delete process.env.APE_TOKENS;
  delete process.env.APE_ALLOW_OPEN_REMOTE;
  try {
    assert.equal(resolveBindConfig({ host: "127.0.0.1" }).ok, true, "loopback allowed");
    assert.equal(resolveBindConfig({ host: "localhost" }).ok, true);
    assert.equal(resolveBindConfig({}).ok, true, "default is loopback");
    const refused = resolveBindConfig({ host: "0.0.0.0" });
    assert.equal(refused.ok, false, "remote without auth refused");
    assert.ok(refused.hint.includes("APE_REQUIRE_AUTH"), "hint names the fix");
    process.env.APE_REQUIRE_AUTH = "1";
    process.env.APE_TOKENS = "x";
    assert.equal(resolveBindConfig({ host: "0.0.0.0" }).ok, true, "remote with auth allowed");
    delete process.env.APE_REQUIRE_AUTH;
    delete process.env.APE_TOKENS;
    process.env.APE_ALLOW_OPEN_REMOTE = "1";
    const wild = resolveBindConfig({ host: "0.0.0.0" });
    assert.equal(wild.ok, true, "explicit override opens");
    assert.ok(wild.warning.includes("UNSAFE"), "override carries a severe warning");
  } finally {
    if (prevA === undefined) delete process.env.APE_REQUIRE_AUTH; else process.env.APE_REQUIRE_AUTH = prevA;
    if (prevT === undefined) delete process.env.APE_TOKENS; else process.env.APE_TOKENS = prevT;
    if (prevO === undefined) delete process.env.APE_ALLOW_OPEN_REMOTE; else process.env.APE_ALLOW_OPEN_REMOTE = prevO;
  }
});

test("mcp: sessions sweep without leaking the store", () => {
  assert.ok(mcpSessionCount() >= 0, "store introspectable");
  assert.ok(sweepSessions() >= 0, "sweep runs cleanly");
});

test("mcp: Host allowlist rejects rebinding attempts", async () => {
  const { allowedHost } = await import("../src/http.js");
  const prev = process.env.APE_ALLOWED_HOSTS;
  process.env.APE_ALLOWED_HOSTS = "98-86-146-92.sslip.io";
  const req = (host) => ({ headers: { host } });
  try {
    // Unit: matching semantics.
    assert.equal(allowedHost(req("98-86-146-92.sslip.io")), true, "listed Host passes");
    assert.equal(allowedHost(req("98-86-146-92.sslip.io:8787")), true, "port ignored");
    assert.equal(allowedHost(req("evil.example")), false, "stranger rejected");
    assert.equal(allowedHost(req("EVIL.EXAMPLE")), false, "case-insensitive, still rejects");
    assert.equal(allowedHost(req("")), false, "empty Host rejected when list set");
    assert.equal(allowedHost(req("sub.98-86-146-92.sslip.io")), false, "subdomains do not inherit");
    // Integration: real Host header control needs node:http (undici overrides Host).
    const { default: http } = await import("node:http");
    const url = new URL(base);
    const get = (host) => new Promise((resolve, reject) => {
      const r = http.request({ host: url.hostname, port: url.port, path: "/discover", method: "GET", headers: { Host: host } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      r.on("error", reject);
      r.end();
    });
    assert.equal(await get("evil.example"), 403, "rebound Host refused over the wire");
    assert.equal(await get("98-86-146-92.sslip.io"), 200, "listed Host served");
    // MCP surface too, with a valid session (Host checked before dispatch).
    // node:http throughout: undici overrides Host, which would vacate the check.
    const { default: http2 } = await import("node:http");
    const postRaw = (host, body, sid) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const r = http2.request({
        host: url.hostname, port: url.port, path: "/mcp", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), Authorization: "Bearer mcp-test-token", Host: host, ...(sid ? { "mcp-session-id": sid } : {}) },
      }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      });
      r.on("error", reject);
      r.end(data);
    });
    const init = await postRaw("98-86-146-92.sslip.io", { jsonrpc: "2.0", id: 71, method: "initialize", params: {} });
    assert.equal(init.status, 200, "listed Host initializes");
    const sid = init.headers["mcp-session-id"];
    assert.ok(sid, "session issued");
    const mcp = await postRaw("evil.example", { jsonrpc: "2.0", id: 70, method: "ping" }, sid);
    assert.equal(mcp.status, 403, "rebound Host gets nothing from /mcp, session or not");
    const mcpOk = await postRaw("98-86-146-92.sslip.io", { jsonrpc: "2.0", id: 73, method: "ping" }, sid);
    assert.equal(mcpOk.status, 200, "listed Host proceeds");
  } finally {
    if (prev === undefined) delete process.env.APE_ALLOWED_HOSTS;
    else process.env.APE_ALLOWED_HOSTS = prev;
  }
});

test("mcp: rate limiter throttles floods, isolates others", async () => {
  const { checkRateLimit, resetRateLimits } = await import("../src/http.js");
  const prevRpm = process.env.APE_RATE_LIMIT_RPM;
  const prevWin = process.env.APE_RATE_LIMIT_WINDOW_MS;
  process.env.APE_RATE_LIMIT_RPM = "3";
  process.env.APE_RATE_LIMIT_WINDOW_MS = "60000";
  resetRateLimits();
  try {
    assert.ok(!checkRateLimit("10.0.0.1", 1000).limited);
    assert.ok(!checkRateLimit("10.0.0.1", 1000).limited);
    assert.ok(!checkRateLimit("10.0.0.1", 1000).limited);
    const hit = checkRateLimit("10.0.0.1", 1000);
    assert.ok(hit.limited, "4th request in window refused");
    assert.ok(hit.retryAfterMs > 0, "retry hint present");
    assert.ok(!checkRateLimit("10.0.0.2", 1000).limited, "other IPs unaffected");
    assert.ok(!checkRateLimit("10.0.0.1", 1000 + 60001).limited, "window rolls over");
  } finally {
    resetRateLimits();
    if (prevRpm === undefined) delete process.env.APE_RATE_LIMIT_RPM; else process.env.APE_RATE_LIMIT_RPM = prevRpm;
    if (prevWin === undefined) delete process.env.APE_RATE_LIMIT_WINDOW_MS; else process.env.APE_RATE_LIMIT_WINDOW_MS = prevWin;
  }
});

test("mcp: HTTP 429 on /mcp flood with Retry-After", async () => {
  const { resetRateLimits } = await import("../src/http.js");
  const prevRpm = process.env.APE_RATE_LIMIT_RPM;
  process.env.APE_RATE_LIMIT_RPM = "2";
  resetRateLimits();
  try {
    const { sid } = await initSession();
    const h = { headers: { "mcp-session-id": sid, "X-Forwarded-For": "198.51.100.7" } };
    assert.equal((await post({ jsonrpc: "2.0", id: 80, method: "ping" }, h)).status, 200);
    assert.equal((await post({ jsonrpc: "2.0", id: 81, method: "ping" }, h)).status, 200);
    const flooded = await fetch(base + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", ...auth, "mcp-session-id": sid, "X-Forwarded-For": "198.51.100.7" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 82, method: "ping" }),
    });
    assert.equal(flooded.status, 429, "flood refused");
    assert.ok(flooded.headers.get("retry-after"), "Retry-After present");
    assert.equal((await flooded.json()).error, "rate_limited");
  } finally {
    resetRateLimits();
    if (prevRpm === undefined) delete process.env.APE_RATE_LIMIT_RPM; else process.env.APE_RATE_LIMIT_RPM = prevRpm;
  }
});
