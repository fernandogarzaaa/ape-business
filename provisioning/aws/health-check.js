#!/usr/bin/env node
// Health check for one tenant APE endpoint. Two steps, both must pass:
// 1. GET <base>/discover  -> status: server.name must be ape-mcp, capabilities present.
// 2. GET <base>/tools     -> read-only discovery: a tools list, no write performed.
// Usage: health-check.js <base-url> [--retries 3]  (default base http://127.0.0.1:8787)
// Exit 0 only if both pass. Never prints a bearer token.
'use strict';
async function getJson(url, timeoutMs) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: c.signal }); const body = await r.json(); return { status: r.status, body }; }
  finally { clearTimeout(t); }
}
async function main() {
  const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
  const retries = Number(process.argv[process.argv.indexOf('--retries') + 1] || 3);
  let last = '';
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const s = await getJson(`${base}/discover`, 10000);
      if (s.status !== 200 || s.body?.server?.name !== 'ape-mcp' || !s.body?.capabilities) { last = `discover failed: status ${s.status}`; }
      else {
        const d = await getJson(`${base}/tools`, 10000);
        const tools = d.body?.tools ?? d.body;
        if (d.status !== 200 || !(Array.isArray(tools) || (tools && typeof tools === 'object'))) { last = `tools discovery failed: status ${d.status}`; }
        else { console.log(JSON.stringify({ ok: true, base, discoverServer: s.body.server, toolsShape: Array.isArray(tools) ? 'array' : 'object', attempt }, null, 2)); return process.exit(0); }
      }
    } catch (e) { last = String(e.message || e).slice(0, 200); }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 5000));
  }
  console.error(JSON.stringify({ ok: false, base, reason: last }));
  process.exit(1);
}
main();
