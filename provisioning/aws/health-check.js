#!/usr/bin/env node
// Health check for one tenant APE endpoint. Two steps, both must pass:
// 1. GET <base>/discover  -> status: server.name must be ape-mcp, capabilities present.
// 2. GET <base>/tools     -> tools must be a LIST (an error object used to pass).
// Usage: health-check.js <base-url> [--retries 3]  (default base http://127.0.0.1:8787)
// Bearer [REDACTED] from APE_HEALTH_TOKEN (env name only; never printed).
// Exit 0 only if both pass. Total budget capped at 25s.
'use strict';

function parseArgs(argv) {
  const args = argv.slice(2);
  const base = (args.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:8787').replace(/\/$/, '');
  let retries = 3;
  const i = args.indexOf('--retries');
  if (i >= 0) {
    const n = Number(args[i + 1]);
    if (Number.isInteger(n) && n >= 1 && n <= 10) retries = n;
  }
  return { base, retries };
}

async function getJson(url, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const headers = {};
    const token = process.env.APE_HEALTH_TOKEN || process.env.APE_TOKENS || '';
    // APE_TOKENS may hold a JSON map; only a plain token is sent here.
    if (token && !token.trim().startsWith('{')) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(url, { signal: c.signal, headers });
    const body = await r.json();
    return { status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const { base, retries } = parseArgs(process.argv);
  const deadline = Date.now() + 25000;
  let last = '';
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const s = await getJson(`${base}/discover`, 8000);
      if (s.status !== 200 || s.body?.server?.name !== 'ape-mcp' || !s.body?.capabilities) {
        last = `discover failed: status ${s.status}`;
      } else {
        const d = await getJson(`${base}/tools`, 8000);
        const tools = d.body?.tools ?? d.body;
        if (d.status !== 200 || !Array.isArray(tools)) {
          last = `tools discovery failed: status ${d.status} (tools must be a list)`;
        } else {
          console.log(JSON.stringify({ ok: true, base, discoverServer: s.body.server, toolsShape: 'array', attempt }, null, 2));
          return process.exit(0);
        }
      }
    } catch (e) { last = String(e.message || e).slice(0, 200); }
    if (attempt < retries) {
      const wait = Math.min(3000, Math.max(0, deadline - Date.now()));
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  console.error(JSON.stringify({ ok: false, base, reason: last }));
  process.exit(1);
}

if (require.main === module) main();
module.exports = { parseArgs };
