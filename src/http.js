// APE HTTP server — extracted from bin/ape-mcp.js so tests can boot it on
// ephemeral ports. Route behavior is preserved verbatim; bin keeps CLI parsing
// and calls startHttp({ port, host }).
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dispatchCall, toolsList, discover, agentMethod, resourcesList, readResource, promptsList, getPrompt, PROTOCOL } from "./server.js";
import { listRuns, stepsSince, maxStepId } from "./runs.js";
import { agentCard, handleA2A } from "./agent/a2a.js";
import { taskGet } from "./tasks.js";
import { protectedResourceDoc, checkBearer, unauthorized } from "./auth.js";

// --- Host allowlist (§14: DNS-rebinding protection) ---
// When APE_ALLOWED_HOSTS is set (comma-separated, port-insensitive), any
// request whose Host is not listed is rejected before auth or dispatch. This
// is the DNS-rebinding guard: a browser reaching this server under an
// attacker domain gets nothing, even with valid credentials. Caddy enforces
// Host at the edge too; this is defense-in-depth for direct access. Unset =
// no enforcement (loopback/dev default). The OAuth discovery document stays
// public (protocol necessity: clients fetch it to learn auth).
export function allowedHost(req) {
  const list = String(process.env.APE_ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  return host !== "" && list.includes(host);
}
function hostAllowedOr403(req, res) {
  if (allowedHost(req)) return true;
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "host-not-allowed" }));
  return false;
}

// --- Rate limiting (§21): fixed-window per client IP on /mcp ---
// Checked BEFORE auth so the bearer endpoint itself resists brute force.
// Trusts X-Forwarded-For (single-proxy deployment: Caddy sets it; direct
// access is loopback-only where spoofing is meaningless).
const rateBuckets = new Map(); // ip -> { windowStart, count }
export function rateLimitRpm() {
  const v = Number(process.env.APE_RATE_LIMIT_RPM);
  return Number.isFinite(v) && v > 0 ? v : 240;
}
export function rateLimitWindowMs() {
  const v = Number(process.env.APE_RATE_LIMIT_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 60000;
}
export function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || "unknown";
}
export function checkRateLimit(ip, nowMs = Date.now()) {
  const rpm = rateLimitRpm();
  const win = rateLimitWindowMs();
  let b = rateBuckets.get(ip);
  if (!b || nowMs - b.windowStart >= win) {
    b = { windowStart: nowMs, count: 0 };
    rateBuckets.set(ip, b);
  }
  if (rateBuckets.size > 10000) {
    for (const [k, v] of rateBuckets) if (nowMs - v.windowStart >= win) rateBuckets.delete(k);
  }
  b.count++;
  if (b.count > rpm) return { limited: true, retryAfterMs: Math.max(0, b.windowStart + win - nowMs) };
  return { limited: false };
}
export function resetRateLimits() { rateBuckets.clear(); }
function rateLimitedOr429(req, res) {
  const verdict = checkRateLimit(clientIp(req));
  if (!verdict.limited) return true;
  res.writeHead(429, {
    "Content-Type": "application/json",
    "Retry-After": String(Math.ceil(verdict.retryAfterMs / 1000)),
  });
  res.end(JSON.stringify({ error: "rate_limited", retry_after_ms: verdict.retryAfterMs }));
  return false;
}

// --- Fail-closed bind policy (Phase 11) ---
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
export function resolveBindConfig({ host = "127.0.0.1" } = {}) {
  const h = String(host || "127.0.0.1");
  if (LOOPBACK_HOSTS.has(h.toLowerCase())) return { ok: true, host: h };
  const authed = process.env.APE_REQUIRE_AUTH === "1" &&
    String(process.env.APE_TOKENS || "").split(",").some((s) => s.trim());
  if (authed) return { ok: true, host: h };
  if (process.env.APE_ALLOW_OPEN_REMOTE === "1") {
    return { ok: true, host: h, warning: "UNSAFE: serving APE remotely with no bearer auth (APE_ALLOW_OPEN_REMOTE=1). Anyone who reaches this port can run tools. Not for production." };
  }
  return { ok: false, host: h, error: "refusing remote bind without bearer auth", hint: "set APE_REQUIRE_AUTH=1 and APE_TOKENS=<token>, or APE_ALLOW_OPEN_REMOTE=1 to override (unsafe)" };
}

// --- Exact-origin CORS (Phase 12): allowlist only, never wildcard, none by default ---
export function corsAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const allowed = String(process.env.APE_CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}
function applyCors(req, res) {
  const origin = corsAllowedOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  return origin;
}

// --- MCP sessions (Phases 3/4): in-memory, single-node, 30-min idle expiry ---
export const MCP_SESSION_TTL_MS = 30 * 60 * 1000;
export const MCP_SESSION_HEADER = "mcp-session-id";
export const MCP_SESSION_NOT_FOUND = -32001;
const mcpSessions = new Map(); // id -> { createdAt, lastSeen }
export function sweepSessions(nowMs = Date.now()) {
  let swept = 0;
  for (const [id, s] of mcpSessions) {
    if (nowMs - s.lastSeen > MCP_SESSION_TTL_MS) { mcpSessions.delete(id); swept++; }
  }
  return swept;
}
export function mcpSessionCount() { return mcpSessions.size; }

// --- MCP SSE streams (functional): run/step notifications + heartbeat ---
// Reuses the console's proven shape: snapshot-diff over the WAL ledger,
// cursors start at "now" (connect never replays history), per-stream timers,
// cleanup on client disconnect. Active streams introspectable for tests.
const mcpStreams = new Set();
export function mcpStreamCount() { return mcpStreams.size; }
export function mcpHeartbeatMs() {
  const v = Number(process.env.APE_MCP_HEARTBEAT_MS);
  return Number.isFinite(v) && v > 0 ? v : 15000;
}
function openMcpStream(req, res, sessionId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const stream = { sessionId, alive: true, lastStepId: 0, lastStatuses: new Map(), timer: null, hb: null };
  const close = () => {
    if (!stream.alive) return;
    stream.alive = false;
    clearInterval(stream.timer);
    clearInterval(stream.hb);
    mcpStreams.delete(stream);
    try { res.end(); } catch { /* ignore */ }
  };
  const send = (payload) => {
    if (!stream.alive) return false;
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); return true; }
    catch { close(); return false; }
  };
  const notify = (logger, data) => send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", logger, data } });
  const tick = () => {
    if (!stream.alive) return;
    try {
      // The open-time snapshot pre-fills lastStatuses, so an unknown id here
      // can only be a run created after connect: emit its creation, then any
      // later transition. (A run that finishes before its first sighting is
      // still reported — never swallowed as baseline.)
      for (const r of listRuns(50)) {
        const prev = stream.lastStatuses.get(r.run_id);
        stream.lastStatuses.set(r.run_id, r.status);
        if ((prev === undefined || prev !== r.status) && !notify("ape/runs", { run: r })) return;
      }
      for (const s of stepsSince(stream.lastStepId, 100)) {
        stream.lastStepId = Math.max(stream.lastStepId, s.id);
        if (!notify("ape/steps", { step: s })) return;
      }
    } catch { /* transient ledger miss — next tick retries */ }
  };
  // Baseline at "now": snapshot cursors without emitting history.
  try {
    for (const r of listRuns(50)) stream.lastStatuses.set(r.run_id, r.status);
    stream.lastStepId = maxStepId();
  } catch { /* first tick self-heals */ }
  req.on("close", close);
  res.write("retry: 10000\n");
  res.write(": connected ape/mcp stream\n\n");
  mcpStreams.add(stream);
  stream.timer = setInterval(tick, 1000);
  stream.hb = setInterval(() => {
    if (!stream.alive) return;
    try { res.write(":\n\n"); } catch { close(); }
  }, mcpHeartbeatMs());
}
function takeSession(req) {
  sweepSessions();
  const id = req.headers[MCP_SESSION_HEADER];
  if (!id || typeof id !== "string") return null;
  const s = mcpSessions.get(id);
  if (!s) return null;
  s.lastSeen = Date.now();
  return { id, ...s };
}
function newSession() {
  const id = randomUUID();
  const now = Date.now();
  mcpSessions.set(id, { createdAt: now, lastSeen: now });
  return id;
}

// --- MCP JSON-RPC dispatcher (Phases 2/5/8/9) ---
function mcpError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message: String(message).slice(0, 500) } };
}
function mcpOk(id, result) {
  return { jsonrpc: "2.0", id, result };
}

async function handleMcpMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return { response: mcpError(msg?.id, -32600, "invalid request") };
  }
  const { id, method, params } = msg;
  const isNotif = msg.id === undefined;
  if (typeof method !== "string") {
    return { response: mcpError(id, -32600, "invalid request: missing method") };
  }
  try {
    switch (method) {
      case "initialize": {
        // Pinned version (same policy as stdio): never echo the client.
        const result = {
          protocolVersion: PROTOCOL,
          capabilities: discover().capabilities,
          serverInfo: { name: "ape-mcp", version: "1.0.0" },
        };
        if (isNotif) return { notification: true };
        return { response: mcpOk(id, result), newSession: true };
      }
      case "ping": {
        if (isNotif) return { notification: true };
        return { response: mcpOk(id, {}) };
      }
      case "tools/list": {
        if (isNotif) return { notification: true };
        const tools = toolsList().tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        }));
        return { response: mcpOk(id, { tools }) };
      }
      case "tools/call": {
        if (isNotif) return { notification: true };
        const out = await dispatchCall(params?.name, params?.arguments ?? {});
        if (out?.resultType === "input_required") {
          const reqs = out.inputRequests ?? [];
          return {
            response: mcpOk(id, {
              content: [{ type: "text", text: "input_required: " + reqs.map((r) => r.message ?? r.id).join("; ") }],
              structuredContent: { inputRequests: reqs },
              isError: true,
            }),
          };
        }
        const sc = out?.structuredContent;
        const toolError = sc ? sc.ok === false : false;
        const content = Array.isArray(out?.content) && out.content.length
          ? out.content
          : [{ type: "text", text: JSON.stringify(sc?.result ?? out ?? null).slice(0, 8000) }];
        const result = { content };
        if (sc?.result !== undefined) result.structuredContent = sc.result;
        if (toolError) result.isError = true;
        return { response: mcpOk(id, result) };
      }
      case "resources/list": {
        if (isNotif) return { notification: true };
        return { response: mcpOk(id, resourcesList()) };
      }
      case "resources/read": {
        if (isNotif) return { notification: true };
        try {
          return { response: mcpOk(id, await readResource(params?.uri)) };
        } catch (e) {
          return { response: mcpError(id, -32002, `resource error: ${e?.message ?? e}`) };
        }
      }
      case "prompts/list": {
        if (isNotif) return { notification: true };
        return { response: mcpOk(id, promptsList()) };
      }
      case "prompts/get": {
        if (isNotif) return { notification: true };
        return { response: mcpOk(id, await getPrompt(params?.name, params?.arguments ?? {})) };
      }
      default: {
        if (isNotif) return { notification: true };
        return { response: mcpError(id, -32601, `unknown_method: ${method}`) };
      }
    }
  } catch (e) {
    if (isNotif) return { notification: true };
    return { response: mcpError(id, -32603, String(e?.message ?? e)) };
  }
}

const MCP_BODY_CAP = 4 * 1024 * 1024;
function readMcpBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MCP_BODY_CAP) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      body += c;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleMcpPost(req, res) {
  let body = "";
  try {
    body = await readMcpBody(req);
  } catch (e) {
    res.writeHead(e?.status === 413 ? 413 : 400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "body too large" }));
  }
  let payload;
  try {
    payload = JSON.parse(body || "null");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(mcpError(null, -32700, "parse error")));
  }
  const batch = Array.isArray(payload) ? payload : [payload];
  const responses = [];
  let newSessionId = null;
  for (const msg of batch) {
    const needsSession = !(msg && typeof msg === "object" && !Array.isArray(msg) && msg.method === "initialize");
    if (needsSession) {
      const session = takeSession(req);
      if (!session) {
        responses.push(mcpError(msg?.id, MCP_SESSION_NOT_FOUND, "session-not-found: initialize first and send mcp-session-id"));
        continue;
      }
    }
    const handled = await handleMcpMessage(msg);
    if (handled.newSession) {
      newSessionId = newSession();
    }
    if (handled.response) responses.push(handled.response);
  }
  if (newSessionId) res.setHeader(MCP_SESSION_HEADER, newSessionId);
  if (!responses.length) {
    res.writeHead(202);
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
}

export function startHttp({ port = 8787, host = "127.0.0.1" } = {}) {
  const server = createServer(async (req, res) => {
    const h = req.headers.host || `${host}:${port}`;
    if (req.method === "GET" && req.url === "/.well-known/oauth-protected-resource") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(protectedResourceDoc(h)));
    }
    // Host gate for everything past public discovery (DNS-rebinding defense).
    if (!hostAllowedOr403(req, res)) return;
    if (req.method === "GET" && req.url === "/.well-known/agent.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(agentCard(`http://${h}`)));
    }
    if (req.method === "POST" && req.url === "/a2a") {
      if (!checkBearer(req).ok) return unauthorized(res, h);
      let body = "";
      for await (const c of req) body += c;
      try {
        const { id, method, params } = JSON.parse(body || "{}");
        try {
          const result = await handleA2A(method, params ?? {});
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (e) {
          const code = typeof e?.code === "number" ? e.code : -32603;
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: String(e?.message ?? e).slice(0, 300) } }));
        }
      } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: String(e).slice(0, 200) })); }
    }
    if (req.method === "GET" && req.url === "/discover") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(discover()));
    }
    if (req.method === "GET" && req.url === "/tools") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(toolsList()));
    }
    if (req.method === "POST" && (req.url === "/call" || req.url === "/tasks/get" || req.url === "/agent")) {
      if (!checkBearer(req).ok) return unauthorized(res, h);
      let body = "";
      for await (const c of req) body += c;
      try {
        if (req.url === "/agent") {
          const { method, params } = JSON.parse(body || "{}");
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ resultType: "complete", result: await agentMethod(method, params ?? {}) }));
        }
        if (req.url === "/tasks/get") {
          const { task_id } = JSON.parse(body || "{}");
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ resultType: "complete", task: taskGet(task_id) }));
        }
        const { name, arguments: a } = JSON.parse(body || "{}");
        if ((req.headers["mcp-method"] && req.headers["mcp-method"] !== "tools/call")) {
          res.writeHead(400); return res.end(JSON.stringify({ error: { code: -32020, message: "HeaderMismatch" } }));
        }
        const out = await dispatchCall(name, a ?? {});
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: String(e).slice(0, 200) })); }
    }
    // MCP Streamable HTTP endpoint (v1): hand-rolled JSON-RPC dispatcher reusing
    // the stdio method set. Single-node in-memory sessions; no server-initiated
    // streams (GET -> 405). See docs/remote.md for the wire contract.
    const pathname = req.url.split("?")[0];
    if (pathname === "/mcp") {
      if (req.method === "OPTIONS") {
        // Preflight never carries auth: answer from CORS policy alone.
        if (!req.headers.origin) { res.writeHead(204); return res.end(); }
        if (!applyCors(req, res)) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "cors_denied" })); }
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, mcp-session-id",
        });
        return res.end();
      }
      applyCors(req, res);
      if (!rateLimitedOr429(req, res)) return;
      if (!checkBearer(req).ok) return unauthorized(res, h);
      if (req.method === "GET") {
        // Functional stream (no 405): session-gated, cursors at now.
        sweepSessions();
        const id = req.headers[MCP_SESSION_HEADER];
        const s = (typeof id === "string" && mcpSessions.get(id)) || null;
        if (!s) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(mcpError(null, MCP_SESSION_NOT_FOUND, "session-not-found: initialize first and send mcp-session-id")));
        }
        s.lastSeen = Date.now();
        return openMcpStream(req, res, id);
      }
      if (req.method === "DELETE") {
        sweepSessions();
        const id = req.headers[MCP_SESSION_HEADER];
        if (!id || typeof id !== "string" || !mcpSessions.has(id)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(mcpError(null, MCP_SESSION_NOT_FOUND, "session-not-found: unknown or expired session")));
        }
        mcpSessions.delete(id);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === "POST") {
        return handleMcpPost(req, res);
      }
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "method_not_allowed" }));
    }
    res.writeHead(404); res.end("{}");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" ? addr.port : port, host });
    });
  });
}
