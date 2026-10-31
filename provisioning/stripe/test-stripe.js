// Test harness for stripe/. Node only, no dependencies, no network.
// Run: node ~/workspace/ape-provisioning/stripe/test-stripe.js
//
// The signing secret below is GENERATED AT RUNTIME with crypto.randomBytes.
// It is test-only, it is not a Stripe key, it is never a real key, and
// it is never written to a file. It exists only so this test can sign
// a payload the way Stripe would, then verify it the way the handler
// will. Nothing in this file contacts api.stripe.com.
'use strict';
const crypto = require('crypto');
const assert = require('assert');
const { verifyWebhookSignature } = require('./verify.js');
const { buildCheckoutSessionParams, createCheckoutSession } = require('./checkout.js');
const { createWebhookHandler } = require('./handler.js');

// TEST-ONLY secret, generated per run. Not a Stripe key. Not persisted.
const TEST_WEBHOOK_SECRET = 'whsec_testonly_' + crypto.randomBytes(16).toString('hex');

function sign(payload, secret, timestamp) {
  const t = timestamp != null ? timestamp : Math.floor(Date.now() / 1000);
  const signed = t + '.' + payload;
  const v1 = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return { header: 't=' + t + ',v1=' + v1, timestamp: t };
}

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('PASS: ' + name); })
    .catch((e) => { console.log('FAIL: ' + name + ' :: ' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
}

function memoryStore() {
  const m = new Map();
  return {
    has: (id) => m.has(id),
    get: (id) => m.get(id),
    record: (id, v) => { m.set(id, v); },
  };
}

function succeededEvent(intentId, amountCents, meta) {
  return JSON.stringify({
    id: 'evt_test_' + crypto.randomBytes(4).toString('hex'),
    type: 'payment_intent.succeeded',
    data: { object: { id: intentId, amount_received: amountCents, metadata: meta || {} } },
  });
}

async function main() {
  // 1. Valid signature verifies, event parses.
  await check('valid signature verifies', () => {
    const payload = succeededEvent('pi_test_valid', 4028, {});
    const { header } = sign(payload, TEST_WEBHOOK_SECRET);
    const { event } = verifyWebhookSignature(payload, header, TEST_WEBHOOK_SECRET);
    assert.strictEqual(event.type, 'payment_intent.succeeded');
    assert.strictEqual(event.data.object.id, 'pi_test_valid');
  });

  // 2. Tampered payload is rejected.
  await check('tampered payload rejected', () => {
    const payload = succeededEvent('pi_test_tamper', 4028, {});
    const { header } = sign(payload, TEST_WEBHOOK_SECRET);
    const tampered = payload.replace('4028', '4029');
    assert.throws(
      () => verifyWebhookSignature(tampered, header, TEST_WEBHOOK_SECRET),
      (e) => e.code === 'invalid_signature',
    );
  });

  // 3. Tampered signature is rejected.
  await check('tampered signature rejected', () => {
    const payload = succeededEvent('pi_test_sig', 4028, {});
    const { header } = sign(payload, TEST_WEBHOOK_SECRET);
    const bad = header.replace(/v1=[0-9a-f]+/, 'v1=00');
    assert.throws(
      () => verifyWebhookSignature(payload, bad, TEST_WEBHOOK_SECRET),
      (e) => e.code === 'invalid_signature',
    );
  });

  // 4. Stale timestamp is rejected (replay protection).
  await check('stale timestamp rejected', () => {
    const payload = succeededEvent('pi_test_stale', 4028, {});
    const old = Math.floor(Date.now() / 1000) - 600;
    const { header } = sign(payload, TEST_WEBHOOK_SECRET, old);
    assert.throws(
      () => verifyWebhookSignature(payload, header, TEST_WEBHOOK_SECRET),
      (e) => e.code === 'stale_timestamp',
    );
  });

  // 5. Missing header is rejected.
  await check('missing header rejected', () => {
    const payload = succeededEvent('pi_test_noheader', 4028, {});
    assert.throws(
      () => verifyWebhookSignature(payload, null, TEST_WEBHOOK_SECRET),
      (e) => e.code === 'missing_signature',
    );
  });

  // 6. Checkout params match the calculator: 100 jobs, 10 steps, 5 GB
  //    is $40.28 in PRICING.md, so 4028 cents.
  await check('checkout price matches calculator ($40.28 = 4028 cents)', () => {
    const built = buildCheckoutSessionParams({
      tenantId: 'tn_test', jobs: 100, steps: 10, storageGb: 5,
    });
    assert.strictEqual(built.price.monthlyPriceUsd, 40.28);
    assert.strictEqual(built.amountCents, 4028);
    assert.strictEqual(built.fields['line_items[0][price_data][unit_amount]'], '4028');
    assert.strictEqual(built.fields['metadata[tenantId]'], 'tn_test');
  });

  // 7. createCheckoutSession posts the right shape, via fake transport
  //    (no network), and refuses without a key.
  await check('createCheckoutSession uses Bearer auth via fake transport, no network', async () => {
    let seen = null;
    const fakePost = async (key, body) => {
      seen = { key, body };
      return { id: 'cs_test_fake', url: 'https://checkout.stripe.com/fake' };
    };
    const out = await createCheckoutSession(
      { tenantId: 'tn_test', jobs: 100, steps: 10, storageGb: 5 },
      { apiKey: 'sk_test_FAKE_TRANSPORT_ONLY', post: fakePost },
    );
    assert.strictEqual(seen.key, 'sk_test_FAKE_TRANSPORT_ONLY');
    // Form body URL-encodes brackets, so decode before asserting.
    assert.ok(decodeURIComponent(seen.body).includes('unit_amount]=4028'));
    assert.strictEqual(out.session.id, 'cs_test_fake');
    assert.strictEqual(out.amountCents, 4028);
  });
  await check('createCheckoutSession refuses without a key', async () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      await assert.rejects(
        createCheckoutSession({ tenantId: 'tn_test' }, { apiKey: null }),
        (e) => e.code === 'missing_secret',
      );
    } finally {
      if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved;
    }
  });

  // 8. Handler: duplicate webhook delivery provisions exactly once.
  await check('duplicate webhook provisions exactly once', async () => {
    const store = memoryStore();
    let provisionCalls = 0;
    const tenants = new Map();
    const handler = createWebhookHandler({
      webhookSecret: TEST_WEBHOOK_SECRET,
      store,
      provision: async (intentId, event) => {
        provisionCalls += 1;
        const tenantId = event.data.object.metadata.tenantId;
        if (!tenants.has(tenantId)) {
          tenants.set(tenantId, { tenantId, deployments: 0 });
        }
        const t = tenants.get(tenantId);
        t.deployments += 1;
        return { tenantId, status: 'ready', paymentIntentId: intentId };
      },
    });
    const meta = { tenantId: 'tn_dup', jobs: '100', steps: '10', storageGb: '5', amountCents: '4028' };
    const payload = succeededEvent('pi_dup_001', 4028, meta);
    const { header } = sign(payload, TEST_WEBHOOK_SECRET);
    const first = await handler(payload, header);
    const second = await handler(payload, header);
    assert.strictEqual(first.provisioned, true);
    assert.strictEqual(second.duplicate, true);
    assert.strictEqual(provisionCalls, 1);
    assert.strictEqual(tenants.size, 1);
    assert.strictEqual(tenants.get('tn_dup').deployments, 1);
  });

  // 9. Handler: bad signature never provisions.
  await check('bad signature never provisions', async () => {
    let calls = 0;
    const handler = createWebhookHandler({
      webhookSecret: TEST_WEBHOOK_SECRET,
      store: memoryStore(),
      provision: async () => { calls += 1; return {}; },
    });
    const payload = succeededEvent('pi_bad_sig', 4028, {});
    const { header } = sign(payload, TEST_WEBHOOK_SECRET);
    await assert.rejects(
      handler(payload, header.replace(/v1=[0-9a-f]+/, 'v1=00')),
      (e) => e.code === 'invalid_signature',
    );
    assert.strictEqual(calls, 0);
  });

  // 10. Handler: non-succeeded and amount-mismatch events never provision.
  await check('failed payment event ignored', async () => {
    let calls = 0;
    const handler = createWebhookHandler({
      webhookSecret: TEST_WEBHOOK_SECRET,
      store: memoryStore(),
      provision: async () => { calls += 1; return {}; },
    });
    const payload = JSON.stringify({
      id: 'evt_test_fail', type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_fail_001' } },
    });
    const { header } = sign(payload, TEST_WEBHOOK_SECRET);
    const out = await handler(payload, header);
    assert.strictEqual(out.ignored, true);
    assert.strictEqual(calls, 0);
  });
  await check('amount mismatch ignored, no provision', async () => {
    let calls = 0;
    const handler = createWebhookHandler({
      webhookSecret: TEST_WEBHOOK_SECRET,
      store: memoryStore(),
      provision: async () => { calls += 1; return {}; },
    });
    const meta = { tenantId: 'tn_mm', jobs: '100', steps: '10', storageGb: '5', amountCents: '4028' };
    const payload = succeededEvent('pi_mm_001', 9999, meta);
    const { header } = sign(payload, TEST_WEBHOOK_SECRET);
    const out = await handler(payload, header);
    assert.strictEqual(out.ignored, true);
    assert.strictEqual(out.reason, 'amount_mismatch');
    assert.strictEqual(calls, 0);
  });

  console.log('---');
  console.log('TOTAL PASSED: ' + passed + ' checks, exitCode=' + (process.exitCode || 0));
  if (process.exitCode) console.log('RESULT: FAILED');
  else console.log('RESULT: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
