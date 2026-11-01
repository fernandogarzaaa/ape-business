// Phase 1 wiring gate: one demo tenant from onboarding through a
// VERIFIED Stripe test webhook to ready, plus a text receipt and an
// email receipt. This replaces the old mock-webhook e2e, which never
// invoked the Stripe handler and therefore proved only that the mock
// agreed with itself (production audit H16).
//
// Real path exercised here, all over HTTP:
//   server.js (create/connect/provision, admin Bearer)
//   -> stripe/webhook-server.js (raw-body HMAC verify, fail-closed
//      amount guard, atomic claim, tenant marked paid)
//   -> pipeline.runPipeline (shared SQLite store) -> ready
//   -> pipeline.js GET deployment
// SMS/email receipts call the real handlers with fake signatures /
// test headers. No real charge, deploy, SMS, or email: the pipeline
// steps and their 400ms timing are still test doubles, and the
// receipt says so. Deploy timing against Fargate is a separate,
// live-only measurement — not claimed here.
//
// Run: node provisioning/e2e-test.js   (exit 0 = pass)
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSmsHandler, computeTwilioSignature } = require('./sms/twilio-webhook');
const { createEmailHandler } = require('./email/email-intake');

const PROV_PORT = 18788;
const PIPE_PORT = 18789;
const HOOK_PORT = 18790;
const PROV = 'http://127.0.0.1:' + PROV_PORT;
const PIPE = 'http://127.0.0.1:' + PIPE_PORT;
const HOOK = 'http://127.0.0.1:' + HOOK_PORT;
const ADMIN = 'e2e-admin-token-not-real';
const HOOK_SECRET = 'whsec_e2e_' + crypto.randomBytes(8).toString('hex');
const SMS_URL = 'https://example.invalid/sms/webhook';
const AGENT_NUMBER = '+15550100001';
const AGENT_EMAIL = 'maya@demo-store.invalid';
const CUSTOMER_NUMBER = '+15550100099';
const CUSTOMER_EMAIL = 'jane@example.invalid';

function signStripe(payload, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(t + '.' + payload).digest('hex');
  return 't=' + t + ',v1=' + v1;
}

async function postJson(base, p, body, headers) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* asserted below */ }
  return { status: r.status, json, text };
}

async function waitReady(base, tries) {
  for (let i = 0; i < (tries || 50); i++) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up: ' + base);
}

async function main() {
  const started = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-e2e-'));
  const dbPath = path.join(tmp, 'ape.db');
  const env = {
    ...process.env,
    APE_DB_PATH: dbPath,
    APE_API_TOKEN: ADMIN,
    STRIPE_WEBHOOK_SECRET: HOOK_SECRET,
    HOST: '127.0.0.1',
  };
  const kids = [];
  const spawnSvc = (file, extra) => {
    const k = spawn(process.execPath, [path.join(__dirname, file)], {
      env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    k.stderr.on('data', (d) => process.stderr.write('[' + file + '] ' + d));
    kids.push(k);
    return k;
  };
  let tenantId = null;
  try {
    spawnSvc('server.js', { PORT: String(PROV_PORT) });
    spawnSvc('pipeline.js', { PORT: String(PIPE_PORT) });
    spawnSvc('stripe/webhook-server.js', { STRIPE_WEBHOOK_PORT: String(HOOK_PORT) });
    await waitReady(PROV);
    await waitReady(PIPE);
    await waitReady(HOOK.replace('/api/webhooks/stripe', '') + '', 5).catch(() => {});
    // webhook-server health lives under its own path:
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(HOOK + '/api/webhooks/stripe/health');
        if (r.ok) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const auth = { Authorization: 'Bearer ' + ADMIN };

    // 1. Onboarding (authenticated; unauthenticated must fail).
    const noAuth = await postJson(PROV, '/api/tenants', { businessName: 'Nope' });
    assert.strictEqual(noAuth.status, 401, 'unauthenticated create must be 401: ' + noAuth.text);
    const created = await postJson(PROV, '/api/tenants', {
      businessName: 'Demo Store', industry: 'shopify', objective: 'Answer stock questions',
      profile: 'repo-triage', connectors: ['web'], maxSteps: 50, maxCostUsd: 5,
    }, auth);
    assert.strictEqual(created.status, 201, 'tenant create must return 201: ' + created.text);
    tenantId = created.json.id;
    const connected = await postJson(PROV, `/api/tenants/${tenantId}/connect`, { system: 'shopify' }, auth);
    assert.strictEqual(connected.status, 200, 'connect must return 200: ' + connected.text);
    const provisioned = await postJson(PROV, `/api/tenants/${tenantId}/provision`, {}, auth);
    assert.strictEqual(provisioned.status, 200, 'provision must return 200: ' + provisioned.text);
    assert.ok(provisioned.json.bearerToken, 'provision returns the token once');
    const repro = await postJson(PROV, `/api/tenants/${tenantId}/provision`, {}, auth);
    assert.strictEqual(repro.status, 409, 'second provision must be 409, never a silent token rotation');

    // Deploy before payment must refuse.
    const early = await postJson(PIPE, `/api/tenants/${tenantId}/deploy`, {}, auth);
    assert.strictEqual(early.status, 402, 'deploy before payment must be 402: ' + early.text);
    // The removed mock webhook must stay removed.
    const mock = await postJson(PIPE, '/api/webhooks/payment', { tenantId, status: 'succeeded' });
    assert.strictEqual(mock.status, 410, 'mock payment webhook must be gone (410)');

    // 2. Verified Stripe test webhook -> paid -> ready.
    // $40.28 = 4028c for 100 jobs / 10 steps / 5 GB (shared mode).
    const payload = JSON.stringify({
      id: 'evt_e2e_1', type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_e2e_001', amount_received: 4028,
          metadata: { tenantId, jobs: '100', steps: '10', storageGb: '5', amountCents: '4028' },
        },
      },
    });
    const hook = await fetch(HOOK + '/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(payload, HOOK_SECRET) },
      body: payload,
    });
    const hookJson = await hook.json();
    assert.strictEqual(hook.status, 200, 'stripe webhook must return 200: ' + JSON.stringify(hookJson));
    assert.strictEqual(hookJson.provisioned, true, 'verified webhook must provision');
    const dup = await fetch(HOOK + '/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signStripe(payload, HOOK_SECRET) },
      body: payload,
    });
    const dupJson = await dup.json();
    assert.strictEqual(dupJson.duplicate, true, 'redelivery must be a duplicate, never a second provision');

    const depRes = await fetch(PIPE + `/api/tenants/${tenantId}/deployment`, { headers: auth });
    const dep = await depRes.json();
    assert.strictEqual(dep.status, 'ready', 'deployment must reach ready');
    assert.deepStrictEqual(
      dep.steps.map((s) => s.name),
      ['payment_verified', 'tenant_isolated', 'iam_role_created', 'ape_deployed', 'health_check'],
    );

    // 3. Text receipt.
    const sms = createSmsHandler({
      authToken: 'FAKE-E2E-TOKEN-NOT-REAL', accountSid: 'FAKE-E2E-SID-NOT-REAL',
      publicUrl: SMS_URL,
      tenants: { [AGENT_NUMBER]: { id: tenantId, agentName: 'Maya', businessName: 'Demo Store' } },
    });
    const params = { To: AGENT_NUMBER, From: CUSTOMER_NUMBER, Body: 'Do you have this in stock?', MessageSid: 'SM_E2E_001' };
    const smsResult = await sms.handleWebhook({
      url: SMS_URL, params, signature: computeTwilioSignature(SMS_URL, params, 'FAKE-E2E-TOKEN-NOT-REAL'), now: Date.now(),
    });
    assert.strictEqual(smsResult.status, 200);
    assert.ok(smsResult.jobId);
    assert.ok(/AI assistant/i.test(smsResult.twiml));

    // 4. Email receipt (draft only, never sent).
    const email = createEmailHandler({
      tenants: { [AGENT_EMAIL]: { id: tenantId, agentName: 'Maya', businessName: 'Demo Store' } },
    });
    const emailResult = email.handleInbound({
      to: AGENT_EMAIL, from: CUSTOMER_EMAIL, subject: 'Stock question',
      body: 'Do you have this in stock?', messageId: 'EM_E2E_001', now: Date.now(),
    });
    assert.ok(emailResult.jobId);
    assert.ok(/AI assistant/i.test(emailResult.replyDraft));

    const elapsedMs = Date.now() - started;
    console.log(JSON.stringify({
      receipt: 'phase1-wiring-gate-passed',
      tenantId, elapsedMs,
      deploymentSteps: dep.steps.map((s) => s.name),
      smsJobId: smsResult.jobId, emailJobId: emailResult.jobId,
      limits: 'test mode only: signed test webhook (no real charge), mock deploy steps/timing, no real SMS/email/AWS',
    }, null, 2));
    console.log('ALL E2E TESTS PASSED');
  } finally {
    for (const k of kids) k.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('E2E FAILED:', e.stack || e.message); process.exit(1); });
