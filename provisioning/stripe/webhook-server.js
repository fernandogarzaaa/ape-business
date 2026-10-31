// Stripe webhook HTTP server for the APE pipeline. Test mode only.
//
// Why a separate endpoint: Stripe signs the RAW request body. The
// existing pipeline.js webhook parses JSON first, which destroys the
// exact bytes the signature covers, so it cannot verify a real
// Stripe webhook. This server reads the raw body, verifies it with
// stripe/verify.js, and only then calls the existing runPipeline
// from pipeline.js (whose AWS steps are still mock records in this
// build; see DEPLOYMENT_PIPELINE.md).
//
//   POST /api/webhooks/stripe   (raw body, Stripe-Signature header)
//   GET  /api/webhooks/stripe/health
//
// Env names only: STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_PORT.
// No key value is read from a file, logged, or returned.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createWebhookHandler } = require('./handler.js');
const { runPipeline } = require('../pipeline.js');

const PORT = process.env.STRIPE_WEBHOOK_PORT || 8790;
const TENANTS_DIR = path.join(__dirname, '..', 'tenants');

function loadTenant(id) {
  const f = path.join(TENANTS_DIR, id + '.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function buildHandler(deps) {
  const d = deps || {};
  return createWebhookHandler({
    webhookSecret: d.webhookSecret != null
      ? d.webhookSecret : process.env.STRIPE_WEBHOOK_SECRET,
    store: d.store,
    storePath: d.storePath,
    provision: async (paymentIntentId, event) => {
      const obj = event.data.object || {};
      const tenantId = obj.metadata && obj.metadata.tenantId;
      if (!tenantId) throw new Error('webhook metadata has no tenantId');
      const tenant = d.loadTenant
        ? d.loadTenant(tenantId) : loadTenant(tenantId);
      if (!tenant) throw new Error('tenant_not_found: ' + tenantId);
      const run = d.runPipeline || runPipeline;
      return run(tenant, paymentIntentId);
    },
  });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 1e6) req.destroy();
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}

const handler = buildHandler();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/webhooks/stripe/health') {
    return send(res, 200, { ok: true, mode: 'test_only', secretConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET) });
  }
  if (req.method === 'POST' && url.pathname === '/api/webhooks/stripe') {
    try {
      const raw = await readRaw(req);
      const out = await handler(raw, req.headers['stripe-signature']);
      return send(res, 200, out);
    } catch (e) {
      // Signature failures are 400, like Stripe expects; provisioning
      // failures are 500 and are NOT recorded as processed.
      const code = e.code === 'invalid_signature' || e.code === 'missing_signature'
        || e.code === 'stale_timestamp' || e.code === 'invalid_payload' ? 400 : 500;
      return send(res, code, { error: e.code || 'handler_error', message: e.message });
    }
  }
  return send(res, 404, { error: 'not_found' });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(
    'APE Stripe webhook server (test mode only) on http://localhost:' + PORT));
}
module.exports = { server, buildHandler };
