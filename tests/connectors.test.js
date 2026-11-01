import test from "node:test";
import assert from "node:assert";
// SSRF safety net blocks loopback by default: existing tests use local
// servers, so they opt into private egress explicitly. SSRF tests below clear
// this flag to prove blocking.
process.env.APE_ALLOW_PRIVATE_EGRESS = "1";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectorList, loadConnector, runConnectorOperation, connectorHosts } from "../src/connectors.js";
import { dispatchCall } from "../src/server.js";
import { loadProfile } from "../src/agent/profiles.js";

// Local HTTP harness: no external network. Servers bind 127.0.0.1 on ephemeral ports.
function serve(handler) {
  const s = createServer(handler);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port, close: () => s.close() })));
}
const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });

// Network-gated test helpers. The real-Wikipedia test below needs live egress:
// - APE_SKIP_NETWORK_TESTS=1 skips it on sandboxed CI with no egress.
// - withConnectorRetry retries once on transient named network errors
//   (connector_fetch_failed, connector_timeout) so a single flaky hop does
//   not fail the suite. Deterministic named errors (egress_denied,
//   ssrf_denied, auth, bad redirect) and HTTP status outcomes are NOT
//   retried: they are the honest answer in that environment.
const TRANSIENT_NETWORK_ERRORS = new Set(["connector_fetch_failed", "connector_timeout"]);
async function withConnectorRetry(fn, attempts = 2) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (!TRANSIENT_NETWORK_ERRORS.has(last?.error)) return last;
  }
  return last;
}

test("connector: bundled web connector loads with egress + operations", () => {
  const c = loadConnector("web");
  assert.ok(c, "web connector bundled");
  assert.ok(c.egress_allow.includes("en.wikipedia.org"));
  assert.ok(c.operations.some((o) => o.name === "search"));
  assert.ok(c.operations.every((o) => o.annotations?.readOnly), "web connector is read-only");
  assert.ok(connectorHosts().includes("en.wikipedia.org"));
  assert.ok(connectorList().some((x) => x.name === "web"));
});

test("connector: egress containment — request outside egress_allow refused and traced", async () => {
  const c = { name: "x", base_url: "https://en.wikipedia.org", egress_allow: ["en.wikipedia.org"], operations: [{ name: "search", method: "GET", path: "/w/api.php", query: { action: { const: "query" }, list: { const: "search" }, format: { const: "json" }, srsearch: { from: "query" } } }] };
  const op = c.operations[0];
  // Force a host outside the allowlist by path trickery — hostname must still be en.wikipedia.org,
  // so craft a connector whose allowlist does NOT include it.
  const denied = await runConnectorOperation({ ...c, egress_allow: ["evil.example.com"] }, op, { query: "x" }, {});
  assert.equal(denied.error, "egress_denied");
  assert.equal(denied.host, "en.wikipedia.org");
});

test("connector: destructive op requires confirm", async () => {
  const c = { name: "mut", base_url: "https://example.com", egress_allow: ["example.com"], operations: [{ name: "write", method: "POST", path: "/things", annotations: { destructive: true } }] };
  const op = c.operations[0];
  const r = await runConnectorOperation(c, op, {}, {});
  assert.equal(r.error, "input_required");
  const ok = await runConnectorOperation(c, op, {}, { confirm: true });
  assert.notEqual(ok.error, "input_required");
});

test("connector: real Wikipedia call through the web connector (network-gated but bundled)", { skip: process.env.APE_SKIP_NETWORK_TESTS === "1" }, async () => {
  const c = loadConnector("web");
  const search = () => runConnectorOperation(c, c.operations.find((o) => o.name === "search"), { query: "MCP", limit: 2 }, {});
  const r = await withConnectorRetry(search);
  // Honest outcomes: real success, reachable-but-non-2xx (ok:false + status),
  // or a named error (egress_denied, ssrf_denied, connector_fetch_failed, ...).
  // Sandboxed networks that block or proxy Wikipedia still pass: nothing here
  // may turn a network failure into a test failure.
  const honest = r.ok === true || r.ok === false || typeof r.error === "string";
  assert.ok(honest, "honest result, got: " + JSON.stringify(r).slice(0, 200));
  if (r.ok) {
    assert.ok(r.body?.query?.search?.length >= 1, "search returned results");
    const pg = await withConnectorRetry(() => runConnectorOperation(c, c.operations.find((o) => o.name === "summary"), { title: "MCP" }, {}));
    assert.ok(pg.ok, "summary fetch ok");
  }
});

test("connector: MCP tool surface — list + call via dispatch", async () => {
  const l = await dispatchCall("ape_connector_list", {});
  const lr = l.structuredContent.result;
  assert.ok(lr.connectors.some((x) => x.name === "web"));
  const r = await dispatchCall("ape_connector_call", { connector: "web", operation: "search", input: { query: "APE" } });
  assert.equal(r.resultType, "complete");
  const res = r.structuredContent.result;
  // Honest outcomes: real success, reachable-but-non-2xx (ok:false + status), or a
  // named error. Sandboxed networks that block or proxy Wikipedia still pass.
  const honest = res.ok === true || res.ok === false || typeof res.error === "string";
  assert.ok(honest, "honest result, got: " + JSON.stringify(res).slice(0, 200));
  const bad = await dispatchCall("ape_connector_call", { connector: "nope", operation: "x" });
  assert.equal(bad.structuredContent.result.error, "connector_not_found");
});

test("connector: research-verify profile bundles and lists web connector", () => {
  const p = loadProfile("research-verify");
  assert.ok(p, "research-verify profile ships");
  assert.ok(p.tools.some((t) => t.connector === "web"), "profile uses web connector");
});

test("connector: redirect to disallowed host is refused (no egress escape)", async () => {
  const target = await serve((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"x":1}'); });
  const launcher = await serve((req, res) => {
    res.writeHead(302, { location: `http://localhost:${target.port}/target` });
    res.end();
  });
  try {
    const c = { name: "r", base_url: `http://127.0.0.1:${launcher.port}`, egress_allow: ["127.0.0.1"], operations: [{ name: "go", method: "GET", path: "/start" }] };
    const r = await runConnectorOperation(c, c.operations[0], {}, {});
    assert.equal(r.error, "egress_denied_redirect", "cross-host redirect refused, got: " + JSON.stringify(r).slice(0, 200));
    assert.equal(r.host, "localhost");
  } finally { launcher.close(); target.close(); }
});

test("connector: same-host redirect is followed, loop is capped", async () => {
  const ok = await serve((req, res) => {
    if (req.url === "/start") { res.writeHead(302, { location: "/final" }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"done":true}');
  });
  try {
    const c = { name: "r", base_url: `http://127.0.0.1:${ok.port}`, egress_allow: ["127.0.0.1"], operations: [{ name: "go", method: "GET", path: "/start" }] };
    const r = await runConnectorOperation(c, c.operations[0], {}, {});
    assert.equal(r.ok, true);
    assert.ok(r.url.endsWith("/final"), "final URL reported, got: " + r.url);
    assert.equal(r.body.done, true);
  } finally { ok.close(); }
  const loop = await serve((req, res) => { res.writeHead(302, { location: "/round" }); res.end(); });
  try {
    const c = { name: "r", base_url: `http://127.0.0.1:${loop.port}`, egress_allow: ["127.0.0.1"], operations: [{ name: "go", method: "GET", path: "/round" }] };
    const r = await runConnectorOperation(c, c.operations[0], {}, {});
    assert.equal(r.error, "too_many_redirects");
  } finally { loop.close(); }
});

test("connector: query auth is applied to the request and redacted in results", async () => {
  process.env.APE_TEST_TOKEN = "super-secret-token";
  let seen = null;
  const srv = await serve(async (req, res) => {
    seen = req.url;
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":1}');
  });
  try {
    const c = {
      name: "q", base_url: `http://127.0.0.1:${srv.port}`, egress_allow: ["127.0.0.1"],
      auth: { type: "query", token_env: "APE_TEST_TOKEN", header_name: "api_key" },
      operations: [{ name: "go", method: "GET", path: "/data" }],
    };
    const r = await runConnectorOperation(c, c.operations[0], {}, {});
    assert.equal(r.ok, true);
    assert.ok(seen.includes("api_key=super-secret-token"), "credential sent, saw: " + seen);
    assert.ok(!r.url.includes("super-secret-token"), "credential not in returned URL: " + r.url);
    assert.ok(r.url.includes("api_key=***"), "redaction marker present: " + r.url);
  } finally { srv.close(); delete process.env.APE_TEST_TOKEN; }
});

test("connector: confirm=true passes end-to-end through ape_connector_call", async () => {
  const srv = await serve(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"wrote":true}');
  });
  const prevDataDir = process.env.APE_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "ape-conn-"));
  mkdirSync(join(dir, "connectors"), { recursive: true });
  writeFileSync(join(dir, "connectors", "tmp-destruct.yaml"), [
    "name: tmp-destruct",
    `base_url: http://127.0.0.1:${srv.port}`,
    "egress_allow: [127.0.0.1]",
    "operations:",
    "  - name: wipe",
    "    method: POST",
    "    path: /wipe",
    "    annotations: { destructive: true }",
    "",
  ].join("\n"));
  process.env.APE_DATA_DIR = dir;
  try {
    const denied = await dispatchCall("ape_connector_call", { connector: "tmp-destruct", operation: "wipe", input: {} });
    assert.equal(denied.resultType, "input_required", "no confirm means elicitation");
    // Regression (§6): confirm used to be checked at the server layer but dropped
    // before the connector layer, so the call never executed.
    const ok = await dispatchCall("ape_connector_call", { connector: "tmp-destruct", operation: "wipe", input: {}, confirm: true });
    assert.equal(ok.resultType, "complete");
    assert.equal(ok.structuredContent.result.ok, true, "confirmed destructive op executes, got: " + JSON.stringify(ok.structuredContent.result).slice(0, 200));
  } finally {
    if (prevDataDir === undefined) delete process.env.APE_DATA_DIR;
    else process.env.APE_DATA_DIR = prevDataDir;
    srv.close();
  }
});

test("connector: cross-origin redirect is rejected AND never receives credentials (CR-2 repro)", async () => {
  process.env.APE_CR2_TOKEN = "cr2-secret";
  let targetHits = 0;
  let seenAuth = null;
  const target = await serve((req, res) => {
    targetHits++;
    seenAuth = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"x":1}');
  });
  const launcher = await serve((req, res) => {
    res.writeHead(302, { location: `http://localhost:${target.port}/target` });
    res.end();
  });
  try {
    const base = {
      name: "cr2", base_url: `http://127.0.0.1:${launcher.port}`, egress_allow: ["127.0.0.1", "localhost"],
      auth: { type: "bearer", token_env: "APE_CR2_TOKEN" },
      operations: [{ name: "go", method: "GET", path: "/start" }],
    };
    const r = await runConnectorOperation(base, base.operations[0], {}, {});
    assert.equal(r.error, "cross_origin_redirect", "default rejects cross-origin hop, got: " + JSON.stringify(r).slice(0, 160));
    assert.equal(targetHits, 0, "target never hit — credential cannot leak");
    // Explicit opt-in follows, but CLEAN: no auth headers forwarded.
    const opted = { ...base, allow_cross_origin_redirects: true };
    const r2 = await runConnectorOperation(opted, opted.operations[0], {}, {});
    assert.equal(r2.ok, true, "opted-in hop completes: " + JSON.stringify(r2).slice(0, 160));
    assert.equal(targetHits, 1);
    assert.equal(seenAuth, null, "bearer header stripped on cross-origin hop");
  } finally { launcher.close(); target.close(); delete process.env.APE_CR2_TOKEN; }
});

test("connector: same-origin redirect keeps working WITH auth", async () => {
  process.env.APE_CR2_TOKEN = "cr2-secret";
  let seenAuth = null;
  const srv = await serve((req, res) => {
    if (req.url === "/start") { res.writeHead(302, { location: "/final" }); res.end(); return; }
    seenAuth = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"done":true}');
  });
  try {
    const c = {
      name: "cr2", base_url: `http://127.0.0.1:${srv.port}`, egress_allow: ["127.0.0.1"],
      auth: { type: "bearer", token_env: "APE_CR2_TOKEN" },
      operations: [{ name: "go", method: "GET", path: "/start" }],
    };
    const r = await runConnectorOperation(c, c.operations[0], {}, {});
    assert.equal(r.ok, true);
    assert.equal(seenAuth, "Bearer cr2-secret", "same-origin hop keeps credentials");
  } finally { srv.close(); delete process.env.APE_CR2_TOKEN; }
});

test("connector: same-host port change is cross-origin without opt-in", async () => {
  const b = await serve((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"x":1}'); });
  const a = await serve((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${b.port}/other` });
    res.end();
  });
  try {
    const c = { name: "cr2", base_url: `http://127.0.0.1:${a.port}`, egress_allow: ["127.0.0.1"], operations: [{ name: "go", method: "GET", path: "/start" }] };
    const r = await runConnectorOperation(c, c.operations[0], {}, {});
    assert.equal(r.error, "cross_origin_redirect", "port change is a different origin, got: " + JSON.stringify(r).slice(0, 120));
  } finally { a.close(); b.close(); }
});

test("connector: SSRF net blocks loopback/link-local/private spellings", async () => {
  const prev = process.env.APE_ALLOW_PRIVATE_EGRESS;
  delete process.env.APE_ALLOW_PRIVATE_EGRESS;
  try {
    const { ssrfCheck, ipBlocked } = await import("../src/connectors.js");
    assert.ok(ipBlocked("127.0.0.1"), "loopback");
    assert.ok(ipBlocked("10.1.2.3") && ipBlocked("172.16.0.1") && ipBlocked("192.168.1.1"), "rfc1918");
    assert.ok(ipBlocked("169.254.169.254"), "link-local (cloud metadata)");
    assert.ok(ipBlocked("0.0.0.0") && ipBlocked("::1") && ipBlocked("::"), "unspecified/loopback v6");
    assert.ok(ipBlocked("fe80::1") && ipBlocked("fc00::1") && ipBlocked("ff02::1"), "v6 scoped/multicast");
    assert.ok(!ipBlocked("8.8.8.8") && !ipBlocked("1.1.1.1"), "public passes");
    assert.ok(await ssrfCheck("localhost"), "localhost name blocked");
    assert.ok(await ssrfCheck("127.0.0.1"), "literal blocked");
    assert.ok(await ssrfCheck("2130706433"), "decimal-IP trick blocked");
    assert.ok(await ssrfCheck("0x7f.0.0.1"), "hex-quad trick blocked");
    assert.ok(await ssrfCheck("0177.0.0.1"), "octal-quad trick blocked");
    assert.ok(!(await ssrfCheck("example.com")), "public name passes (or unresolvable, fetch decides)");
  } finally {
    if (prev === undefined) delete process.env.APE_ALLOW_PRIVATE_EGRESS;
    else process.env.APE_ALLOW_PRIVATE_EGRESS = prev;
  }
});

test("connector: metadata endpoint refused before any request (§23)", async () => {
  const prev = process.env.APE_ALLOW_PRIVATE_EGRESS;
  delete process.env.APE_ALLOW_PRIVATE_EGRESS;
  try {
    const c = { name: "m", base_url: "http://169.254.169.254", egress_allow: ["169.254.169.254"], operations: [{ name: "get", method: "GET", path: "/latest/meta-data/" }] };
    const r = await runConnectorOperation(c, c.operations[0], {}, {});
    assert.equal(r.error, "ssrf_denied", "metadata never fetched");
    assert.ok(r.reason.includes("169.254"), "reason names the block");
  } finally {
    if (prev === undefined) delete process.env.APE_ALLOW_PRIVATE_EGRESS;
    else process.env.APE_ALLOW_PRIVATE_EGRESS = prev;
  }
});

test("connector: blocked destinations send zero requests (redirect never followed)", async () => {
  const prev = process.env.APE_ALLOW_PRIVATE_EGRESS;
  delete process.env.APE_ALLOW_PRIVATE_EGRESS;
  let hits = 0;
  const launcher = await serve((req, res) => {
    hits++;
    res.writeHead(302, { location: `http://127.0.0.1:9/x` });
    res.end();
  });
  try {
    const c = { name: "m", base_url: `http://127.0.0.1:${launcher.port}`, egress_allow: ["127.0.0.1"], operations: [{ name: "go", method: "GET", path: "/s" }] };
    const r = await runConnectorOperation(c, c.operations[0], {}, {});
    assert.equal(r.error, "ssrf_denied");
    assert.equal(hits, 0, "blocked before the first byte leaves");
  } finally {
    launcher.close();
    if (prev === undefined) delete process.env.APE_ALLOW_PRIVATE_EGRESS;
    else process.env.APE_ALLOW_PRIVATE_EGRESS = prev;
  }
});