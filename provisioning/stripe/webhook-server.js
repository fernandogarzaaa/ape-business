// Stripe webhook HTTP server for the APE pipeline.
//
// Stripe signs the RAW request body, so this server reads raw bytes,
// verifies with stripe/verify.js + handler.js, and only then runs
// the pipeline. Tenant state lives in the store (lib/store.js).
// A verified payment marks the tenant 'paid' — the pipeline deploy
// endpoint refuses everyone else, so payment gates deployment.
//
//   POST /api/webhooks/stripe   (raw body, Stripe-Signature header)
//   GET  /api/webhooks/stripe/health  (liveness only, no internals)
//
// Env names only: STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_PORT, HOST.
// No key value is read from a file, logged, or returned. Error
// responses carry a machine code, never an internal message/stack.
'use strict';

const http = require('http');
const { createWebhookHandler } = require('./handler.js');
const { createPipeline } = require('../pipeline.js');
const { createStore, isValidTenantId } = require('../lib/store');
const { sendJson } = require('../lib/http');

const PORT = process.env.STRIPE_WEBHOOK_PORT || 8790;
const HOST = process.env.HOST || '127.0.0.1';

function buildHandler(deps) {
  const d = deps || {};
  const store = d.store || createStore();
  const pipeline = d.pipeline || createPipeline(store, d.pipelineOpts).runPipeline;
  return createWebhookHandler({
    webhookSecret: d.webhookSecret != null
      ? d.webhookSecret : process.env.STRIPE_WEBHOOK_SECRET,
    store,
    provision: async (key, event) => {
      const obj = event.data.object || {};
      const tenantId = obj.metadata && obj.metadata.tenantId;
      if (!tenantId || !isValidTenantId(tenantId)) {
        throw new Error('webhook metadata has no valid tenantId');
      }
      const tenant = store.getTenant(tenantId);
      if (!tenant) throw new Error('tenant_not_found');
      tenant.status = 'paid';
      tenant.paymentIntentId = key;
      store.putTenant(tenant);
      return pipeline(tenant, key);
    },
    onSubscriptionEvent: async (event) => {
      const obj = event.data.object || {};
      const tenantId = obj.metadata && obj.metadata.tenantId;
      if (!tenantId || !isValidTenantId(tenantId)) return null;
      const tenant = store.getTenant(tenantId);
      if (!tenant) return null;
      if (event.type === 'invoice.paid') tenant.status = 'paid';
      if (event.type === 'customer.subscription.deleted') tenant.status = 'suspended';
      if (event.type === 'invoice.payment_failed') tenant.status = 'past_due';
      store.putTenant(tenant);
      return { tenantId, status: tenant.status };
    },
  });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 1e6 && !settled) {
        settled = true;
        const e = new Error('payload too large');
        e.code = 'payload_too_large';
        reject(e);
        req.destroy();
      }
    });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function createWebhookServer(handler) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/webhooks/stripe/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/stripe') {
      try {
        const raw = await readRaw(req);
        const out = await handler(raw, req.headers['stripe-signature']);
        return sendJson(res, 200, out);
      } catch (e) {
        const clientCodes = ['invalid_signature', 'missing_signature',
          'stale_timestamp', 'invalid_payload', 'missing_intent', 'payload_too_large'];
        const code = clientCodes.includes(e.code) ? 400 : 500;
        return sendJson(res, code, { error: e.code || 'handler_error' });
      }
    }
    return sendJson(res, 404, { error: 'not_found' });
  });
}

const handler = buildHandler();
const server = createWebhookServer(handler);

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(
    'APE Stripe webhook server on http://' + HOST + ':' + PORT));
}

module.exports = { server, buildHandler, createWebhookServer };
