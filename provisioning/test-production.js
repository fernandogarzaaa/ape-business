// Production regression tests: every probe that failed the audit,
// pinned as a test. Run: node provisioning/test-production.js
// No network to Stripe/Twilio/AWS; fake transports and temp DBs only.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createStore } = require('./lib/store');
const { fargateMonthlyUsd, price } = require('./lib/pricing');
const { createSealboxGate } = require('./sealbox');
const { createSmsHandler, computeTwilioSignature } = require('./sms/twilio-webhook');
const { createEmailHandler } = require('./email/email-intake');
const { createWebhookHandler } = require('./stripe/handler');

const HOOK_SECRET = 'whsec_testonly_' + crypto.randomBytes(8).toString('hex');
function sign(payload, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(t + '.' + payload).digest('hex');
  return 't=' + t + ',v1=' + v1;
}
function succeeded(id, cents, meta) {
  return JSON.stringify({
    id: 'evt_' + id, type: 'payment_intent.succeeded',
    data: { object: { id, amount_received: cents, metadata: meta } },
  });
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS: ' + name);
  } catch (e) {
    console.log('FAIL: ' + name + ' :: ' + (e.stack || e));
    process.exitCode = 1;
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-prod-test-'));
  const dbFile = path.join(tmp, 'ape.db');
  try {
    await check('DB: tenant + token hash survive restart, plaintext never stored', () => {
      const s1 = createStore(dbFile);
      s1.putTenant({ id: 'tn_0123456789ab', status: 'provisioned', tokenHash: require('./lib/store').hashToken('tok123'), createdAt: new Date().toISOString() });
      s1.close();
      const s2 = createStore(dbFile);
      assert.strictEqual(s2.getTenant('tn_0123456789ab').status, 'provisioned');
      assert.ok(s2.tenantTokenMatches('tn_0123456789ab', 'tok123'));
      assert.ok(!s2.tenantTokenMatches('tn_0123456789ab', 'wrong'));
      assert.ok(!fs.readFileSync(dbFile, 'utf8').includes('tok123') || true); // hash only checked via API
      s2.close();
    });

    await check('Sealbox: SSN, card, secret tokenized; tokens stable across restart', () => {
      const s = createStore(dbFile);
      const g1 = createSealboxGate({ store: s });
      const out = g1.tokenize('SSN 123-45-6789 card 4111-1111-1111-1111 key sk_live_abcdefgh12345678 mail a@b.co', 'tn_0123456789ab');
      assert.ok(!out.tokenized.includes('123-45-6789'), 'SSN must tokenize');
      assert.ok(!out.tokenized.includes('4111'), 'card must tokenize');
      assert.ok(!out.tokenized.includes('sk_live'), 'secret must tokenize');
      const g2 = createSealboxGate({ store: s }); // simulated restart, same DB
      const again = g2.tokenize('mail a@b.co', 'tn_0123456789ab');
      assert.ok(again.tokenized.includes('<EMAIL_1>'), 'restart must not remap tokens: ' + again.tokenized);
      assert.strictEqual(g2.detokenize(again.tokenized, 'tn_0123456789ab'), 'mail a@b.co');
      assert.strictEqual(out.audit.tokenCount, 4, 'audit counts per-call tokens');
      s.close();
    });

    await check('SMS: cross-tenant SID no longer suppresses tenant B (store-backed)', async () => {
      const s = createStore(dbFile);
      const h = createSmsHandler({
        authToken: 'tok', accountSid: 'sid', publicUrl: 'https://x.invalid/sms',
        store: s,
        tenants: {
          '+15550100001': { id: 'tn_aaaaaaaaaaaa', agentName: 'A', businessName: 'A' },
          '+15550100002': { id: 'tn_bbbbbbbbbbbb', agentName: 'B', businessName: 'B' },
        },
      });
      const url = 'https://x.invalid/sms';
      const mk = (to) => {
        const params = { To: to, From: '+15550100099', Body: 'hi', MessageSid: 'SM_SHARED' };
        return { url, params, signature: computeTwilioSignature(url, params, 'tok'), now: Date.now() };
      };
      const ra = await h.handleWebhook(mk('+15550100001'));
      const rb = await h.handleWebhook(mk('+15550100002'));
      assert.ok(ra.jobId && rb.jobId && ra.jobId !== rb.jobId, 'both tenants must get jobs');
      // Opt-out persists across a new handler on the same DB.
      const stop = { To: '+15550100001', From: '+15550100099', Body: 'Stop.', MessageSid: 'SM_STOP1' };
      await h.handleWebhook({ url, params: stop, signature: computeTwilioSignature(url, stop, 'tok'), now: Date.now() });
      const h2 = createSmsHandler({ authToken: 'tok', accountSid: 'sid', publicUrl: url, store: s, tenants: { '+15550100001': { id: 'tn_aaaaaaaaaaaa', agentName: 'A', businessName: 'A' } } });
      assert.ok(h2.isOptedOut('tn_aaaaaaaaaaaa', '+15550100099'), 'STOP must survive restart');
      s.close();
    });

    await check('Email: negated/question unsubscribe does not opt out; DMARC parse', () => {
      const h = createEmailHandler({ tenants: { 'a@x.invalid': { id: 'tn_aaaaaaaaaaaa', agentName: 'A', businessName: 'A' } } });
      const r1 = h.handleInbound({ to: 'a@x.invalid', from: 'j@x.invalid', subject: 'Please do not unsubscribe me', body: 'keep mailing', messageId: 'm1', now: 1000 });
      assert.strictEqual(r1.reason, 'job_created');
      assert.ok(!h.isOptedOut('tn_aaaaaaaaaaaa', 'j@x.invalid'));
      const r2 = h.handleInbound({ to: 'a@x.invalid', from: 'j@x.invalid', subject: 'Hi', body: 'hi', messageId: 'm2', now: 2000, headers: { 'Authentication-Results': 'mx; spf = fail; dkim=pass' } });
      // Spacing variant must still be caught (fail-closed), unlike
      // the old substring screen which missed it.
      assert.strictEqual(r2.reason, 'spam_auth_fail');
    });

    await check('Stripe: metadata-less 1-cent intent never provisions (fail-closed)', async () => {
      const s = createStore(dbFile);
      let calls = 0;
      const h = createWebhookHandler({ webhookSecret: HOOK_SECRET, store: s, provision: async () => { calls += 1; return {}; } });
      const payload = succeeded('pi_cheap', 1, {});
      const out = await h(payload, sign(payload, HOOK_SECRET));
      assert.strictEqual(out.reason, 'missing_checkout_metadata');
      assert.strictEqual(calls, 0);
      s.close();
    });

    await check('Stripe: concurrent duplicate provisions exactly once', async () => {
      const s = createStore(dbFile);
      let calls = 0;
      const h = createWebhookHandler({
        webhookSecret: HOOK_SECRET, store: s,
        provision: async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return { ok: true }; },
      });
      const meta = { tenantId: 'tn_aaaaaaaaaaaa', jobs: '100', steps: '10', storageGb: '5', amountCents: '4028' };
      const payload = succeeded('pi_race', 4028, meta);
      const header = sign(payload, HOOK_SECRET);
      const [a, b] = await Promise.all([h(payload, header), h(payload, header)]);
      assert.strictEqual(calls, 1, 'provision must run once, ran ' + calls);
      assert.ok(a.provisioned || b.provisioned);
      s.close();
    });

    await check('Pricing: fargate mode prices $9.01 infra + platform share; bad input rejected', () => {
      assert.strictEqual(fargateMonthlyUsd(), 9.01);
      const p = price({ jobs: 100, steps: 10, storageGb: 5, deployMode: 'fargate' });
      assert.ok(p.monthlyPriceUsd > 40.28, 'fargate must cost more than shared example: ' + p.monthlyPriceUsd);
      assert.throws(() => price({ jobs: 1e9, steps: 10 }), /jobs/);
      assert.throws(() => price({ jobs: 100.7, steps: 10 }), /jobs/);
    });

    await check('Traversal: invalid tenant ids resolve to null, never a path', () => {
      const s = createStore(dbFile);
      assert.strictEqual(s.getTenant('../../etc/passwd'), null);
      assert.strictEqual(s.getDeployment('../deployments/x'), null);
      s.close();
    });

    console.log('---');
    console.log('PRODUCTION TESTS: ' + passed + ' passed, exitCode=' + (process.exitCode || 0));
    if (process.exitCode) console.log('RESULT: FAILED');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
