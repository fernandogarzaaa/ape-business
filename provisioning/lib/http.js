// Shared HTTP plumbing: strict JSON bodies, security headers, and
// Bearer [REDACTED] Malformed JSON is a 400, never a silent {}
// that creates a default tenant (probed against the old code).
'use strict';

const crypto = require('crypto');

function readJsonBody(req, limitBytes) {
  const limit = limitBytes || 1e6;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      const e = new Error(message);
      e.code = code;
      reject(e);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail('payload_too_large', 'request body too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch {
        const e = new Error('request body is not valid JSON');
        e.code = 'bad_json';
        reject(e);
      }
    });
    req.on('error', () => fail('bad_request', 'request error'));
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj, null, 2));
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Admin gate: APE_API_TOKEN (env name only; value from the vault).
// When unset the servers bind loopback and log a warning instead of
// pretending to be authenticated (SECURITY.md's earlier claim).
function requireAdmin(req, res) {
  const expected = process.env.APE_API_TOKEN || '';
  if (!expected) return true; // loopback-only prototype mode, warned at listen
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (tokenMatches(provided, expected)) return true;
  sendJson(res, 401, { error: 'unauthorized' });
  return false;
}

module.exports = { readJsonBody, sendJson, requireAdmin, tokenMatches };
