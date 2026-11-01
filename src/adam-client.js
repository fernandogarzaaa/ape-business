// Persistent ADAM client: ONE child process holds the vendored adam-mcp binary's
// JSON-RPC session open; concurrent calls multiplex over it with request-id →
// promise mapping, and the child auto-reconnects on exit/error.
// Fallback contract unchanged: {_adam: "unavailable"|"timeout"|"spawn-error"|...} —
// never a silent stub.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function adamBinary() {
  const cands = [
    join(root, "vendors", "adam", "target", "release", process.platform === "win32" ? "adam-mcp.exe" : "adam-mcp"),
    join(root, "vendors", "adam", "target", "debug", process.platform === "win32" ? "adam-mcp.exe" : "adam-mcp"),
  ];
  // NOTE: vendors/adam/bin/adam-mcp is a self-build WRAPPER (shell script), not a
  // binary — intentionally excluded so we never spawn it as an MCP process.
  return cands.find((p) => existsSync(p)) ?? null;
}

export function dataDir() {
  const d = process.env.APE_DATA_DIR || join(process.cwd(), ".ape");
  mkdirSync(d, { recursive: true });
  return d;
}

let spawnCount = 0;
export function adamSpawnCount() { return spawnCount; }

let session = null;
let brokenUntil = 0;
let consecutiveTimeouts = 0;

function makeSession(bin) {
  const child = spawn(bin, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ADAM_MEMORY_PATH: join(dataDir(), "adam_memory.db"),
      ADAM_GENOME_PATH: join(dataDir(), "adam_genome.json"),
      ADAM_DATA_DIR: dataDir(),
    },
  });
  spawnCount++;
  child.unref(); // child must not keep the parent process alive
  try { child.stdin.unref(); child.stdout.unref(); } catch { /* non-pipe modes */ }
  process.once("exit", () => { try { child.kill(); } catch { /* already gone */ } });
  const s = {
    bin, child, alive: true, nextId: 1, pending: new Map(), buf: "", initPromise: null,
    send(method, params, id) {
      try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); } catch { /* ignore */ }
    },
    invoke(tool, args, timeoutMs = 60000) {
      return new Promise((resolve) => {
        const id = s.nextId++;
        const timer = setTimeout(() => {
          s.pending.delete(id);
          consecutiveTimeouts++;
          // A hung child poisons every future call — kill it and cool down so
          // subsequent calls fail fast instead of each burning a full timeout.
          try { s.child.kill(); } catch { /* gone */ }
          if (consecutiveTimeouts >= 2) {
            s.alive = false;
            if (session === s) session = null;
            brokenUntil = Date.now() + 300000;
            consecutiveTimeouts = 0;
          }
          resolve({ _adam: "timeout", tool });
        }, timeoutMs);
        s.pending.set(id, { resolve, tool, timer });
        s.send("tools/call", { name: tool, arguments: args }, id);
      });
    },
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    s.buf += c;
    let idx;
    while ((idx = s.buf.indexOf("\n")) >= 0) {
      const line = s.buf.slice(0, idx).trim(); s.buf = s.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          const p = s.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            s.pending.delete(msg.id);
            consecutiveTimeouts = 0;
            p.resolve(msg.error
              ? { _adam: "rpc-error", tool: p.tool, error: msg.error }
              : { _adam: "ok", tool: p.tool, result: msg.result?.content ?? msg.result?.result ?? msg });
          }
        }
      } catch { /* skip non-JSON */ }
    }
  });
  const teardown = (reason) => {
    if (!s.alive) return;
    s.alive = false;
    for (const p of s.pending.values()) { clearTimeout(p.timer); p.resolve({ _adam: reason, tool: p.tool }); }
    s.pending.clear();
    if (session === s) session = null;
  };
  child.on("error", () => teardown("spawn-error"));
  child.on("exit", () => teardown("exited"));
  // Initialize handshake before the session is usable.
  s.initPromise = new Promise((resolve) => {
    const id = s.nextId++;
    const timer = setTimeout(() => { teardown("timeout"); resolve(null); }, 15000);
    s.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, tool: "initialize", timer });
    s.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ape-mcp", version: "1.0.0" } }, id);
  });
  return s;
}

async function ensureSession() {
  if (Date.now() < brokenUntil) return null;
  const bin = adamBinary();
  if (!bin) return null;
  if (session && session.alive && session.bin === bin) {
    if (session.initPromise) await session.initPromise;
    return session.alive ? session : null;
  }
  session = makeSession(bin);
  await session.initPromise;
  if (!session.alive) {
    brokenUntil = Date.now() + 120000;
    return null;
  }
  // Health probe: a binary that answers initialize but never answers tools/call
  // would otherwise burn the full 60s invoke timeout on EVERY call. Probe once
  // with a short timeout; on failure, fail fast for a cooldown window.
  const probe = await session.invoke("adam_genome", { organism_id: "health" }, 5000);
  if (probe._adam !== "ok") {
    try { session.child.kill(); } catch { /* gone */ }
    session.alive = false;
    session = null;
    brokenUntil = Date.now() + 300000;
    consecutiveTimeouts = 0;
    return null;
  }
  consecutiveTimeouts = 0;
  return session;
}

export async function adamCall(tool, args = {}, organismId = "default") {
  const s = await ensureSession();
  if (!s) return { _adam: "unavailable", tool, hint: "run `node scripts/fetch-adam.mjs` or `cargo build --release -p adam-mcp` in vendors/adam" };
  return await s.invoke(tool, { ...args, organism_id: organismId });
}