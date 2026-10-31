// Phase 1 exit test: one demo tenant, onboarding to a text receipt
// and an email receipt, in under 5 minutes.
//
// Test mode only. No real Stripe charge, no real AWS resource, no
// real SMS or email sent. The pipeline's deploy timing is mocked
// (400 ms per step), so the wall-clock gate below proves the
// wiring end to end, not a real Fargate deploy time. That limit
// is stated in the receipt, not hidden.
//
// Run: node e2e-test.js
// Exit 0 on pass, 1 on any failed assertion. Servers are spawned
// on ports 8788 and 8789 and killed on exit. The demo tenant file
// and deployment file are deleted in cleanup, so the repo tree
// is left unchanged.
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createSmsHandler, computeTwilioSignature } = require('./sms/twilio-webhook');
const { createEmailHandler } = require('./email/email-intake');

const PROV = 'http://localhost:8788';
const PIPE = 'http://localhost:8789';
const SMS_URL = 'https://example.invalid/sms/webhook';
const AGENT_NUMBER = '+15550100001';
const AGENT_EMAIL = 'maya@demo-store.invalid';
const CUSTOMER_NUMBER = '+15550100099';
const CUSTOMER_EMAIL = 'jane@example.invalid';

async function post(base, p, body) {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null, assert below */ }
  return { status: r.status, json, text };
}

async function waitReady(base) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/pricing/calculate?jobs=100'); return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up: ' + base);
}

async function main() {
  const started = Date.now();
  const prov = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'ignore' });
  const pipe = spawn(process.execPath, [path.join(__dirname, 'pipeline.js')], { stdio: 'ignore' });
  let tenantId = null;
  try {
    await waitReady(PROV);
    await waitReady(PIPE);

    // 1. Onboarding: create, connect one system, provision.
    const created = await post(PROV, '/api/tenants', {
      businessName: 'Demo Store', industry: 'shopify', objective: 'Answer stock questions',
      profile: 'repo-triage', connectors: ['web'], maxSteps: 50, maxCostUsd: 5,
    });
    assert.strictEqual(created.status, 201, 'tenant create must return 201: ' + created.text);
    tenantId = created.json.id;
    const connected = await post(PROV, `/api/tenants/${tenantId}/connect`, { system: 'shopify' });
    assert.strictEqual(connected.status, 200, 'connect must return 200: ' + connected.text);
    const provisioned = await post(PROV, `/api/tenants/${tenantId}/provision`, {});
    assert.strictEqual(provisioned.status, 200, 'provision must return 200: ' + provisioned.text);
    assert.ok(provisioned.json.agentCard, 'provision must return an agent card');

    // 2. Pay-to-ready: mock checkout, succeeded webhook, deployment ready.
    const checkout = await post(PIPE, '/api/checkout', { tenantId, jobs: 100, steps: 10, storageGb: 5 });
    assert.strictEqual(checkout.status, 201, 'checkout must return 201: ' + checkout.text);
    const deployed = await post(PIPE, '/api/webhooks/payment', {
      tenantId, paymentIntentId: checkout.json.paymentIntentId, status: 'succeeded',
    });
    assert.strictEqual(deployed.status, 200, 'payment webhook must return 200: ' + deployed.text);
    assert.strictEqual(deployed.json.status, 'ready', 'deployment must reach ready');
    assert.deepStrictEqual(
      deployed.json.steps.map((s) => s.name),
      ['payment_verified', 'tenant_isolated', 'iam_role_created', 'ape_deployed', 'health_check'],
    );

    // 3. Text receipt: inbound SMS becomes one job, first message
    // identifies the agent as an AI assistant.
    const sms = createSmsHandler({
      authToken: 'FAKE-E2E-TOKEN-NOT-REAL', accountSid: 'FAKE-E2E-SID-NOT-REAL',
      publicUrl: SMS_URL,
      tenants: { [AGENT_NUMBER]: { id: tenantId, agentName: 'Maya', businessName: 'Demo Store' } },
    });
    const params = { To: AGENT_NUMBER, From: CUSTOMER_NUMBER, Body: 'Do you have this in stock?', MessageSid: 'SM_E2E_001' };
    const smsResult = await sms.handleWebhook({
      url: SMS_URL, params, signature: computeTwilioSignature(SMS_URL, params, 'FAKE-E2E-TOKEN-NOT-REAL'), now: Date.now(),
    });
    assert.strictEqual(smsResult.status, 200, 'SMS intake must accept');
    assert.ok(smsResult.jobId, 'SMS intake must create a job');
    assert.ok(/AI assistant/i.test(smsResult.twiml), 'first SMS must identify as AI agent');
    assert.strictEqual(sms.getJobs().length, 1);

    // 4. Email receipt: inbound email becomes one job, reply is a
    // draft only, never sent by the intake module.
    const email = createEmailHandler({
      tenants: { [AGENT_EMAIL]: { id: tenantId, agentName: 'Maya', businessName: 'Demo Store' } },
    });
    const emailResult = email.handleInbound({
      to: AGENT_EMAIL, from: CUSTOMER_EMAIL, subject: 'Stock question',
      body: 'Do you have this in stock?', messageId: 'EM_E2E_001', now: Date.now(),
    });
    assert.ok(emailResult.jobId, 'email intake must create a job');
    assert.ok(/AI assistant/i.test(emailResult.replyDraft), 'first email reply must identify as AI agent');
    assert.strictEqual(email.getJobs().length, 1);
    assert.ok(!('sent' in emailResult) || emailResult.sent !== true, 'email module must not send');

    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 300000, `exit gate is under 5 minutes, took ${elapsedMs} ms`);
    console.log(JSON.stringify({
      receipt: 'phase1-exit-test-passed',
      tenantId, elapsedMs,
      deploymentSteps: deployed.json.steps.map((s) => s.name),
      smsJobId: smsResult.jobId, emailJobId: emailResult.jobId,
      limits: 'test mode only: mock payment, mock deploy timing, no real SMS or email sent, no real AWS resource',
    }, null, 2));
    console.log('ALL E2E TESTS PASSED');
  } finally {
    prov.kill();
    pipe.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (tenantId) {
      for (const f of [
        path.join(__dirname, 'tenants', tenantId + '.json'),
        path.join(__dirname, 'deployments', tenantId + '.json'),
      ]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
      try { fs.rmdirSync(path.join(__dirname, 'deployments')); } catch { /* not empty or gone */ }
    }
  }
}

main().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
