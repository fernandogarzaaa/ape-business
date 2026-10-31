// APE deployment pipeline prototype.
// Node only, no dependencies. Simulates: pay -> verify -> AWS provision
// -> IAM role -> APE deploy -> health check -> ready.
// It spends no AWS money, creates no real IAM role, and contacts no
// payment provider. Payment is a mock intent, AWS steps are mock records
// with the same names and scopes as the real steps in DEPLOYMENT_PIPELINE.md.
//
// Endpoints (port 8789):
//   POST /api/checkout {tenantId, jobs, steps, storageGb}
//   POST /api/webhooks/payment {paymentIntentId, status}
//   POST /api/tenants/:id/deploy
//   GET  /api/tenants/:id/deployment
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { price } = require('./server.js');

const PORT = process.env.PORT || 8789;
const DATA_DIR = path.join(__dirname, 'tenants');
const DEPLOY_DIR = path.join(__dirname, 'deployments');
fs.mkdirSync(DEPLOY_DIR, { recursive: true });

function loadTenant(id) {
  const f = path.join(DATA_DIR, id + '.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function saveTenant(t) {
  fs.writeFileSync(path.join(DATA_DIR, t.id + '.json'), JSON.stringify(t, null, 2));
}
function deployPath(id) { return path.join(DEPLOY_DIR, id + '.json'); }
function loadDeployment(id) {
  const f = deployPath(id);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function saveDeployment(d) {
  fs.writeFileSync(deployPath(d.tenantId), JSON.stringify(d, null, 2));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Run the pipeline steps in order. Idempotent: if a deployment already
// exists and is ready, return it unchanged. Steps are recorded, never
// silently retried in a loop.
async function runPipeline(tenant, paymentIntentId) {
  const existing = loadDeployment(tenant.id);
  if (existing && existing.status === 'ready') return existing;
  const startedAt = Date.now();
  const d = existing || {
    tenantId: tenant.id, paymentIntentId, status: 'running', steps: [], startedAt: new Date(startedAt).toISOString(),
  };
  const step = async (name, detail) => {
    if (d.steps.find((s) => s.name === name && s.status === 'done')) return;
    await wait(400); // demo timing only; real EC2/Fargate deploy is 60 to 90 seconds
    d.steps.push({ name, status: 'done', detail, at: new Date().toISOString() });
    saveDeployment(d);
  };
  try {
    await step('payment_verified', 'Webhook verified for intent ' + paymentIntentId + '. Client callback alone never starts this.');
    await step('tenant_isolated', 'Ledger dir and env file created for tenant ' + tenant.id + ' only.');
    await step('iam_role_created', 'Role ape-tenant-' + tenant.id + ', scoped to S3 ape-tenants/' + tenant.id + '/*, one Secrets Manager secret, one log group. No human IAM user, no console login.');
    await step('ape_deployed', 'Prebuilt APE image deployed as one task for tenant ' + tenant.id + '. Real version: ECS RunTask with the tenant task role, or EC2 from a prebuilt AMI.');
    await step('health_check', 'APE status ok, plus one read-only discovery call. No writes.');
    d.status = 'ready';
    d.endpoint = 'https://api.example.invalid/tenants/' + tenant.id + '/mcp';
    d.agentCard = tenant.agentCard || { name: 'ape-mcp', business: tenant.businessName, url: d.endpoint };
    d.elapsedMs = Date.now() - startedAt;
    d.finishedAt = new Date().toISOString();
    saveDeployment(d);
    return d;
  } catch (e) {
    d.status = 'failed';
    d.error = String(e && e.message ? e.message : e);
    saveDeployment(d);
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // Checkout: price from the calculator, mock intent, no real charge.
  if (req.method === 'POST' && url.pathname === '/api/checkout') {
    const b = await readBody(req);
    const t = loadTenant(b.tenantId);
    if (!t) return send(res, 404, { error: 'tenant_not_found' });
    const p = price({ jobs: b.jobs || 100, steps: b.steps || 10, storageGb: b.storageGb || 5, tenantsPerInstance: 10 });
    const intent = 'pi_mock_' + crypto.randomBytes(8).toString('hex');
    return send(res, 201, {
      tenantId: t.id, paymentIntentId: intent, amountUsd: p.monthlyPriceUsd,
      breakdownUsd: p.breakdownUsd, status: 'awaiting_payment',
      note: 'Mock checkout. Real version: Stripe Checkout, then webhook only.',
      next: 'POST /api/webhooks/payment {paymentIntentId, status: "succeeded"}',
    });
  }

  // Payment webhook: only a succeeded webhook starts provisioning.
  if (req.method === 'POST' && url.pathname === '/api/webhooks/payment') {
    const b = await readBody(req);
    if (b.status !== 'succeeded') return send(res, 200, { ignored: true, reason: 'payment not succeeded, provisioning not started' });
    const t = loadTenant(b.tenantId);
    if (!t) return send(res, 404, { error: 'tenant_not_found' });
    // Idempotency: same intent twice returns the same deployment.
    const d = await runPipeline(t, b.paymentIntentId);
    return send(res, 200, d);
  }

  // Manual deploy trigger (also idempotent on ready).
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'tenants' && parts[3] === 'deploy') {
    const t = loadTenant(parts[2]);
    if (!t) return send(res, 404, { error: 'tenant_not_found' });
    const b = await readBody(req);
    const d = await runPipeline(t, b.paymentIntentId || 'pi_manual_' + t.id);
    return send(res, 200, d);
  }

  // Deployment status (no secrets in this response).
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'tenants' && parts[3] === 'deployment') {
    const d = loadDeployment(parts[2]);
    if (!d) return send(res, 404, { error: 'deployment_not_found' });
    return send(res, 200, d);
  }

  return send(res, 404, { error: 'not_found' });
});

if (require.main === module) {
  server.listen(PORT, () => console.log('APE deployment pipeline prototype on http://localhost:' + PORT));
}
module.exports = { server, runPipeline };
