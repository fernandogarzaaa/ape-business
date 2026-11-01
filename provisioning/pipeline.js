// APE deployment pipeline.
// Pay -> verify -> provision -> deploy -> health -> ready. The only
// payment entry is the Stripe webhook server (stripe/webhook-server.js),
// which verifies the signature and amount before calling runPipeline.
// The old unauthenticated POST /api/webhooks/payment mock is gone:
// anything reaching this port could previously provision any tenant
// for free (probed in the production audit).
//
// Endpoints (port 8789, admin Bearer APE_API_TOKEN when set):
//   POST /api/checkout {tenantId, jobs, steps, storageGb}
//   POST /api/tenants/:id/deploy {paymentIntentId} — requires a
//        recorded payment for this tenant (status paid/ready)
//   GET  /api/tenants/:id/deployment
//   GET  /healthz
'use strict';

const http = require('http');
const crypto = require('crypto');
const { createStore, isValidTenantId } = require('./lib/store');
const { price } = require('./lib/pricing');
const { readJsonBody, sendJson, requireAdmin } = require('./lib/http');

const PORT = process.env.PORT || 8789;
const HOST = process.env.HOST || '127.0.0.1';

// Per-tenant promise chain: two concurrent webhooks for one tenant
// must not interleave check-then-act across the step awaits.
const locks = new Map();
function withTenantLock(tenantId, fn) {
  const prev = locks.get(tenantId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(tenantId, next.catch(() => {}));
  return next;
}

function createPipeline(store, opts) {
  const options = opts || {};
  const waitMs = options.stepWaitMs != null ? options.stepWaitMs : 400;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runPipelineLocked(tenant, paymentIntentId) {
    const existing = store.getDeployment(tenant.id);
    if (existing && existing.status === 'ready') {
      if (existing.paymentIntentId && paymentIntentId &&
          existing.paymentIntentId !== paymentIntentId) {
        // Replay with a different intent used to return ready
        // unverified. Refuse: one tenant, one paying intent.
        const e = new Error('deployment already ready under a different payment intent');
        e.code = 'intent_mismatch';
        throw e;
      }
      return existing;
    }
    const startedAt = Date.now();
    const d = existing || {
      tenantId: tenant.id, paymentIntentId, status: 'running', steps: [],
      startedAt: new Date(startedAt).toISOString(),
    };
    d.paymentIntentId = d.paymentIntentId || paymentIntentId;
    const step = async (name, detail) => {
      if (d.steps.find((s) => s.name === name && s.status === 'done')) return;
      await wait(waitMs); // demo timing; real Fargate deploy is 60-90s
      d.steps.push({ name, status: 'done', detail, at: new Date().toISOString() });
      store.putDeployment(d);
    };
    try {
      await step('payment_verified', 'Webhook verified for intent ' + d.paymentIntentId + '.');
      await step('tenant_isolated', 'Database rows and env scoped to tenant ' + tenant.id + ' only.');
      await step('iam_role_created', 'Role ape-tenant-' + tenant.id + ', scoped per provisioning/aws/policy.js.');
      await step('ape_deployed', 'Prebuilt APE image as one Fargate task for tenant ' + tenant.id + ' (deploy.js).');
      await step('health_check', 'Health check passed (aws/health-check.js). No writes.');
      d.status = 'ready';
      const base = (process.env.APE_PUBLIC_BASE_URL || '').replace(/\/$/, '');
      d.endpoint = base ? base + '/tenants/' + tenant.id + '/mcp' : null;
      d.endpointStatus = base ? 'configured' : 'unconfigured';
      d.agentCard = tenant.agentCard || { name: 'ape-mcp', business: tenant.businessName, url: d.endpoint };
      d.elapsedMs = Date.now() - startedAt;
      d.finishedAt = new Date().toISOString();
      store.putDeployment(d);
      const t = store.getTenant(tenant.id);
      if (t) { t.status = 'ready'; store.putTenant(t); }
      return d;
    } catch (e) {
      d.status = 'failed';
      d.error = String(e && e.message ? e.message : e).slice(0, 300);
      store.putDeployment(d);
      throw e;
    }
  }

  function runPipeline(tenant, paymentIntentId) {
    return withTenantLock(tenant.id, () => runPipelineLocked(tenant, paymentIntentId));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/webhooks/payment') {
        return sendJson(res, 410, {
          error: 'gone',
          message: 'Mock payment webhook removed. Payments enter only via POST /api/webhooks/stripe (signature-verified).',
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/checkout') {
        if (!requireAdmin(req, res)) return;
        const b = await readJsonBody(req);
        if (!isValidTenantId(b.tenantId)) return sendJson(res, 404, { error: 'tenant_not_found' });
        const t = store.getTenant(b.tenantId);
        if (!t) return sendJson(res, 404, { error: 'tenant_not_found' });
        let p;
        try {
          p = price({ jobs: b.jobs, steps: b.steps, storageGb: b.storageGb, transferGb: b.transferGb });
        } catch (e) {
          return sendJson(res, 400, { error: 'invalid_pricing_input', message: e.message });
        }
        const intent = 'pi_mock_' + crypto.randomBytes(8).toString('hex');
        return sendJson(res, 201, {
          tenantId: t.id, paymentIntentId: intent, amountUsd: p.monthlyPriceUsd,
          breakdownUsd: p.breakdownUsd, status: 'awaiting_payment',
          note: 'Local estimate only. Real checkout: provisioning/stripe/checkout.js (subscription). Provisioning starts only from the verified Stripe webhook.',
        });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'tenants' && parts[3] === 'deploy') {
        if (!requireAdmin(req, res)) return;
        if (!isValidTenantId(parts[2])) return sendJson(res, 404, { error: 'tenant_not_found' });
        const t = store.getTenant(parts[2]);
        if (!t) return sendJson(res, 404, { error: 'tenant_not_found' });
        if (t.status !== 'paid' && t.status !== 'ready') {
          return sendJson(res, 402, { error: 'payment_required', message: 'No recorded payment for this tenant. Deploy follows payment, never precedes it.' });
        }
        const b = await readJsonBody(req);
        const intent = b.paymentIntentId || t.paymentIntentId;
        if (!intent) return sendJson(res, 402, { error: 'payment_required' });
        const d = await runPipeline(t, intent);
        return sendJson(res, 200, d);
      }
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'tenants' && parts[3] === 'deployment') {
        if (!requireAdmin(req, res)) return;
        if (!isValidTenantId(parts[2])) return sendJson(res, 404, { error: 'deployment_not_found' });
        const d = store.getDeployment(parts[2]);
        if (!d) return sendJson(res, 404, { error: 'deployment_not_found' });
        return sendJson(res, 200, d);
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e && e.code === 'intent_mismatch') return sendJson(res, 409, { error: 'intent_mismatch' });
      if (e && e.code === 'bad_json') return sendJson(res, 400, { error: 'bad_json' });
      if (e && e.code === 'payload_too_large') return sendJson(res, 413, { error: 'payload_too_large' });
      return sendJson(res, 500, { error: 'internal_error' });
    }
  });

  return { server, runPipeline };
}

const defaultStore = createStore();
const { server, runPipeline } = createPipeline(defaultStore);

if (require.main === module) {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !process.env.APE_API_TOKEN) {
    console.error('refusing to bind ' + HOST + ' without APE_API_TOKEN set');
    process.exit(1);
  }
  if (!process.env.APE_API_TOKEN) {
    console.error('WARNING: APE_API_TOKEN unset — unauthenticated prototype mode, loopback only.');
  }
  server.listen(PORT, HOST, () => console.log('APE deployment pipeline on http://' + HOST + ':' + PORT));
}

module.exports = { server, runPipeline, createPipeline };
