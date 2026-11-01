// Host provider autodetection — APE resolves the provider the platform is CURRENTLY
// using by reading the host's active-session state, not just its credential vault.
//   - OpenCode: readOnly SQLite session table → newest session.model JSON {id, providerID}
//   - Claude Code: ~/.claude.json model + OAuth access token
//   - Codex: config.toml model + auth.json token
//   - env: ANTHROPIC_API_KEY / OPENAI_API_KEY / ... (+ *_MODEL for the active model)
//   - local: Ollama / llama.cpp probe
// Credentials are read, never written or logged. All reads are readOnly + try/catch;
// a locked or migrated store degrades to the next source, never crashes.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function readText(p) {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function opencodeHome() {
  return process.env.OPENCODE_HOME || join(homedir(), ".local", "share", "opencode");
}

// --- OpenCode: active provider+model from the session DB + keys from auth.json ---
export async function opencodeActive() {
  const dbPath = join(opencodeHome(), "opencode.db");
  if (!existsSync(dbPath)) return null;
  let row = null;
  try {
    const { DatabaseSync } = await import("../sqlite.js");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=2000");
    try { row = db.prepare("SELECT model FROM session ORDER BY time_updated DESC LIMIT 1").get(); } catch { /* schema drift */ }
    db.close();
  } catch { return null; }
  if (!row?.model) return null;
  const keys = opencodeKeys();
  const parsed = parseModelField(row.model);
  if (!parsed) return null;
  const key = keys[parsed.provider] ?? null;
  return { provider: parsed.provider, model: parsed.model, key, kind: "active", source: "opencode session" };
}

function parseModelField(field) {
  if (typeof field === "object" && field) {
    if (field.providerID && field.id) return { provider: field.providerID, model: field.id };
    return null;
  }
  if (typeof field === "string") {
    try {
      const j = JSON.parse(field);
      if (j.providerID && j.id) return { provider: j.providerID, model: j.id };
    } catch { /* plain string */ }
    const parts = field.split("/");
    if (parts.length >= 2) return { provider: parts[0], model: parts.slice(1).join("/") };
    return null;
  }
  return null;
}

export function opencodeKeys() {
  const j = readJson(join(opencodeHome(), "auth.json"));
  if (!j) return {};
  const out = {};
  for (const [name, v] of Object.entries(j)) {
    if (v?.type === "api" && typeof v.key === "string" && v.key) out[name] = v.key;
  }
  return out;
}

// --- Claude Code: ~/.claude.json model + OAuth access token ---
export function claudeActive() {
  const claudeRoot = process.env.APE_CLAUDE_HOME || homedir(); // dir containing .claude/ and .claude.json
  let model = process.env.ANTHROPIC_MODEL || null;
  const cfg = readJson(join(claudeRoot, ".claude.json"));
  if (!model && cfg?.model && typeof cfg.model === "string") model = cfg.model;
  let token = process.env.ANTHROPIC_API_KEY || null;
  let refreshToken = null;
  if (!token) {
    const creds = readJson(join(claudeRoot, ".claude", ".credentials.json"));
    token = creds?.claudeAiOauth?.accessToken || null;
    refreshToken = creds?.claudeAiOauth?.refreshToken || null;
  }
  if (!token) return null;
  return { provider: "anthropic", model, key: token, refreshToken, oauth: !process.env.ANTHROPIC_API_KEY, kind: "active", source: "claude code" };
}

// --- Codex: config.toml model + auth token ---
export function codexActive() {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const cfg = readText(join(home, "config.toml"));
  let model = null;
  if (cfg) {
    const m = /^\s*model\s*=\s*"?([^\s"#]+)/m.exec(cfg);
    if (m) model = m[1];
  }
  const auth = readJson(join(home, "auth.json"));
  let key = auth?.OPENAI_API_KEY || auth?.tokens?.access_token || auth?.api_key || null;
  if (!key) return null;
  return { provider: "openai", model, key, kind: "active", source: "codex" };
}

// --- env: active model + key when the host exports them ---
export function envActive() {
  const table = [
    ["anthropic", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
    ["openai", "OPENAI_API_KEY", "OPENAI_MODEL"],
    ["openrouter", "OPENROUTER_API_KEY", "OPENROUTER_MODEL"],
    ["groq", "GROQ_API_KEY", "GROQ_MODEL"],
    ["nebius", "APE_NEBIUS_API_KEY", "APE_NEBIUS_MODEL"],
    ["google", "GOOGLE_API_KEY", "GOOGLE_MODEL"],
  ];
  for (const [provider, keyEnv, modelEnv] of table) {
    if (process.env[keyEnv]) {
      return { provider, key: process.env[keyEnv], model: process.env[modelEnv] || null, kind: "env", source: "environment" };
    }
  }
  return null;
}

// --- local inference probe ---
export async function localProbe() {
  if (process.env.APE_NO_LOCAL === "1") return null;
  const bases = [
    process.env.APE_LOCAL_BASE_URL && process.env.APE_LOCAL_BASE_URL.replace(/\/$/, ""),
    "http://localhost:11434",
    "http://localhost:1234",
  ].filter(Boolean);
  for (const base of bases) {
    // OpenAI-compatible models endpoint: <base>/v1/models, unless base already ends in /v1.
    const url = (base.endsWith("/v1") ? base : base + "/v1") + "/models";
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (res.ok) {
        const j = await res.json();
        const id = j?.data?.[0]?.id || null;
        return { provider: "local", model: id, key: null, baseUrl: base.endsWith("/v1") ? base : base + "/v1", kind: "local", source: "ollama/llama.cpp" };
      }
    } catch { /* next */ }
  }
  return null;
}

function requireSqlite() {
  // placeholder removed — sqlite is imported directly in the async reader
}

// --- composite detection ---
export async function detectActiveProvider() {
  return envActive() ?? (await opencodeActive()) ?? claudeActive() ?? codexActive() ?? (await localProbe());
}

// --- stored credentials across hosts (used for explicit provider + best-effort fallback) ---
export function storedCredentials() {
  const out = {};
  Object.assign(out, opencodeKeys());
  const claude = claudeActive();
  if (claude) out.anthropic = { key: claude.key, oauth: claude.oauth, refreshToken: claude.refreshToken };
  const codex = codexActive();
  if (codex) out.openai = codex.key;
  return out;
}

export async function credentialFor(provider) {
  const envMap = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    google: "GOOGLE_API_KEY",
    nebius: "APE_NEBIUS_API_KEY",
    opencode: "OPENCODE_API_KEY",
    meta: "META_API_KEY",
  };
  const env = envMap[provider];
  if (env && process.env[env]) return { key: process.env[env], source: "environment" };
  // Meta dashboard guides also name the key MODEL_API_KEY; accept it as a
  // fallback so a key copied from those guides still resolves.
  if (provider === "meta" && process.env.MODEL_API_KEY) {
    return { key: process.env.MODEL_API_KEY, source: "environment" };
  }
  const stored = storedCredentials();
  const v = stored[provider];
  if (v) {
    if (typeof v === "string") return { key: v, source: "host credentials" };
    return { key: v.key, source: "host credentials", oauth: v.oauth, refreshToken: v.refreshToken };
  }
  return null;
}

// Names only — used by ape_status; never exposes keys.
export async function detectProviders() {
  const found = new Set();
  const env = envActive();
  if (env) found.add(env.provider);
  const oc = await opencodeActive();
  if (oc) found.add(oc.provider);
  const claude = claudeActive();
  if (claude) found.add("anthropic");
  const codex = codexActive();
  if (codex) found.add("openai");
  const local = await localProbe();
  if (local) found.add("local");
  return [...found].sort();
}