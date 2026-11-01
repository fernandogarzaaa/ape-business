// Inbound email webhook server (provider-facing entry point).
//
// email-intake.js decides; this server authenticates the provider.
// The provider (SES/Gmail forwarder) presents EMAIL_WEBHOOK_SECRET
// as a Bearer [REDACTED] (env name only), and messages must carry a
// DMARC-aligned Authentication-Results pass (handler requireVerified).
// Without both, a spoofed From could inject jobs or poison another
// sender's opt-out — the exact probes that failed the library-only
// intake in the production audit. Replies are drafts, never sent.
//
//   POST /email/webhook  { to, from, subject, body, messageId, headers }
//   GET  /email/health
// Env: EMAIL_WEBHOOK_SECRET, EMAIL_TENANTS_FILE, EMAIL_PORT, HOST.
'use strict';

const http = require('http');
const fs = require('fs');
const { createEmailHandler } = require('./email-intake');
const { createStore } = require('../lib/store');
const { readJsonBody, sendJson, tokenMatches } = require('../lib/http');

const PORT = process.env.EMAIL_PORT || 8791;
const HOST = process.env.HOST || '127.0.0.1';

function loadTenants(file) {
  if (!file) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createEmailServer(handler) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/email/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/email/webhook') {
      const expected = process.env.EMAIL_WEBHOOK_SECRET || '';
      const auth = req.headers.authorization || '';
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!expected || !tokenMatches(provided, expected)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      try {
        const msg = await readJsonBody(req, 262144);
        const out = handler.handleInbound(msg);
        return sendJson(res, out.status === 404 ? 404 : 200, out);
      } catch (e) {
        if (e.code === 'bad_json') return sendJson(res, 400, { error: 'bad_json' });
        if (e.code === 'payload_too_large') return sendJson(res, 413, { error: 'payload_too_large' });
        return sendJson(res, 500, { error: 'internal_error' });
      }
    }
    return sendJson(res, 404, { error: 'not_found' });
  });
}

if (require.main === module) {
  const handler = createEmailHandler({
    tenants: loadTenants(process.env.EMAIL_TENANTS_FILE || ''),
    requireVerified: true,
    store: createStore(),
  });
  createEmailServer(handler).listen(PORT, HOST, () =>
    console.log('APE email webhook on http://' + HOST + ':' + PORT));
}

module.exports = { createEmailServer };
