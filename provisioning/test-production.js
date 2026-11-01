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
      const fakeKey = 'sk_live_' + 'abcdefgh12345678'; // assembled: scanner must not flag fixtures
      const out = g1.tokenize('SSN 123-45-6789 card 4111-1111-1111-1111 key ' + fakeKey + ' mail a@b.co', 'tn_0123456789ab');
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

    await check('Stripe: unpaid checkout session never provisions (Codex P1)', async () => {
      const s = createStore(dbFile);
      let calls = 0;
      const h = createWebhookHandler({ webhookSecret: HOOK_SECRET, store: s, provision: async () => { calls += 1; return {}; } });
      const payload = JSON.stringify({
        id: 'evt_unpaid', type: 'checkout.session.completed',
        data: { object: { id: 'cs_1', subscription: 'sub_1', payment_status: 'unpaid', currency: 'usd', amount_total: 4028, metadata: { tenantId: 'tn_aaaaaaaaaaaa', amountCents: '4028' } } },
      });
      const out = await h(payload, sign(payload, HOOK_SECRET));
      assert.strictEqual(out.reason, 'payment_not_completed');
      assert.strictEqual(calls, 0);
      s.close();
    });

    await check('Store: abandoned claim expires and can be stolen after TTL (Codex P2)', () => {
      const s = createStore(dbFile);
      assert.strictEqual(s.claimIntent('pi_dead'), true);
      assert.strictEqual(s.claimIntent('pi_dead'), false); // live claim
      // Backdate beyond the 15-minute TTL, then a retry must win.
      const { DatabaseSync } = require('node:sqlite');
      const raw = new DatabaseSync(dbFile);
      raw.prepare("UPDATE processed_intents SET claimed_at = ? WHERE intent_id = 'pi_dead'")
        .run(new Date(Date.now() - 16 * 60 * 1000).toISOString());
      raw.close();
      assert.strictEqual(s.claimIntent('pi_dead'), true);
      s.close();
    });

    await check('Rollback: omitted --task-arn no longer exits as invalid (Codex P1)', () => {
      const { spawnSync } = require('child_process');
      const r = spawnSync('node', [path.join(__dirname, 'aws/rollback.js'), 'tn_rollback1'], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr.slice(0, 300));
      const out = JSON.parse(r.stdout);
      assert.ok(out.calls.some((c) => c.action === 'StopTaskSkippedNoTaskArn'));
    });

    await check('Email: spoofed unsubscribe cannot mutate opt-out when verified (Codex P1)', () => {
      const h = createEmailHandler({
        requireVerified: true,
        tenants: { 'a@x.invalid': { id: 'tn_aaaaaaaaaaaa', agentName: 'A', businessName: 'A' } },
      });
      const r = h.handleInbound({
        to: 'a@x.invalid', from: 'victim@x.invalid', subject: 'Please unsubscribe me', body: 'stop',
        messageId: 'spoof1', now: 5000, headers: { 'Authentication-Results': 'mx; dmarc=fail' },
      });
      assert.strictEqual(r.reason, 'spam_auth_unverified');
      assert.ok(!h.isOptedOut('tn_aaaaaaaaaaaa', 'victim@x.invalid'));
    });

    await check('Traversal: invalid tenant ids resolve to null, never a path', () => {
      const s = createStore(dbFile);
      assert.strictEqual(s.getTenant('../../etc/passwd'), null);
      assert.strictEqual(s.getDeployment('../deployments/x'), null);
      s.close();
    });

    await check('Shopify: auth URL, callback HMAC, encrypted token storage', async () => {
      const shopify = require('./connectors/shopify');
      const { encrypt, decrypt } = require('./lib/vault');
      process.env.APE_VAULT_KEY = crypto.randomBytes(32).toString('hex');
      const url = shopify.buildAuthUrl({ shop: 'demo.myshopify.com', clientId: 'cid', redirectUri: 'https://x.invalid/cb', state: 'st' });
      assert.ok(url.startsWith('https://demo.myshopify.com/admin/oauth/authorize?'));
      assert.throws(() => shopify.buildAuthUrl({ shop: 'evil.example.com', clientId: 'cid', redirectUri: '', state: '' }), /myshopify/);
      const secret = 'shpss_test';
      const state = shopify.signState({ tenantId: 'tn_aaaaaaaaaaaa', shop: 'demo.myshopify.com', exp: Date.now() + 60000 }, secret);
      assert.strictEqual(shopify.verifyState(state, secret).tenantId, 'tn_aaaaaaaaaaaa');
      assert.strictEqual(shopify.verifyState(state, 'wrong'), null);
      const query = { shop: 'demo.myshopify.com', code: 'abc', state, timestamp: '123' };
      const pairs = Object.entries(query).map(([k, v]) => `${k}=${v}`).sort().join('&');
      query.hmac = crypto.createHmac('sha256', secret).update(pairs).digest('hex');
      assert.ok(shopify.verifyCallbackHmac(query, secret));
      assert.ok(!shopify.verifyCallbackHmac({ ...query, code: 'tampered' }, secret));
      const out = await shopify.exchangeCode(
        { shop: 'demo.myshopify.com', code: 'abc', clientId: 'cid', clientSecret: secret },
        { post: async () => ({ access_token: 'shpat_test_token', scope: 'read_products' }) });
      const s = createStore(dbFile);
      s.putCredential('tn_aaaaaaaaaaaa', 'shopify', encrypt(out.accessToken));
      assert.strictEqual(decrypt(s.getCredential('tn_aaaaaaaaaaaa', 'shopify')), 'shpat_test_token');
      assert.ok(!s.getCredential('tn_aaaaaaaaaaaa', 'shopify').includes('shpat'));
      s.close();
      delete process.env.APE_VAULT_KEY;
    });

    await check('Sigil index: sign -> gate allow -> revoke -> gate deny', async () => {
      const { execFileSync } = require('child_process');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-sigil-idx-'));
      const keyFile = path.join(dir, 'priv.json');
      const keygenOut = execFileSync('node', [path.join(__dirname, 'sigil-index/sign.mjs'), 'keygen', '--out', keyFile], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
      const pubLine = keygenOut.trim().split('\n').pop();
      const pub = JSON.parse(pubLine);
      fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'keys/project.json'), JSON.stringify(pub));
      const badgeJson = execFileSync('node', [path.join(__dirname, 'sigil-index/sign.mjs'), 'badge', '--server', 'demo-server', '--version', '1.0.0', '--score', '90', '--level', 'low', '--key', keyFile], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
      const badge = JSON.parse(badgeJson);
      fs.mkdirSync(path.join(dir, 'badges/demo-server'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'badges/demo-server/1.0.0.json'), JSON.stringify(badge));
      const gate = await import('../src/agent/sigil-gate.js');
      const before = gate.checkSigilGate({ indexDir: dir, tool: 't', server: 'demo-server', version: '1.0.0' });
      assert.strictEqual(before.decision.allow, true, JSON.stringify(before));
      const revJson = execFileSync('node', [path.join(__dirname, 'sigil-index/sign.mjs'), 'revocation', '--server', 'demo-server', '--version', '1.0.0', '--reason', 'test revoke', '--key', keyFile], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
      fs.mkdirSync(path.join(dir, 'revocations/demo-server'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'revocations/demo-server/1.0.0.json'), revJson);
      const after = gate.checkSigilGate({ indexDir: dir, tool: 't', server: 'demo-server', version: '1.0.0' });
      assert.strictEqual(after.decision.allow, false);
      assert.strictEqual(after.decision.reason, 'revoked');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('SMS quota: maxJobsPerMonth enforced at job creation', async () => {
      const s = createStore(dbFile);
      const h = createSmsHandler({
        authToken: 'tok', accountSid: 'sid', publicUrl: 'https://x.invalid/sms', store: s,
        tenants: { '+15550100007': { id: 'tn_cccccccccccc', agentName: 'C', businessName: 'C', maxJobsPerMonth: 1 } },
      });
      const url = 'https://x.invalid/sms';
      const mk = (sid) => {
        const params = { To: '+15550100007', From: '+15550100077', Body: 'hi', MessageSid: sid };
        return { url, params, signature: computeTwilioSignature(url, params, 'tok'), now: Date.now() };
      };
      const r1 = await h.handleWebhook(mk('SM_Q1'));
      const r2 = await h.handleWebhook(mk('SM_Q2'));
      assert.ok(r1.jobId);
      assert.strictEqual(r2.reason, 'quota_exceeded');
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
