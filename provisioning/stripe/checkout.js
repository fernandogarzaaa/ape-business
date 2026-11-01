// Stripe Checkout session parameters and creation. Node only, no deps.
//
// Price source of truth: the calculator in ../server.js (base $19 plus
// usage cost x 1.40). This file does NOT re-implement pricing; it
// converts the calculator's monthlyPriceUsd to integer cents and puts
// it in a Checkout session. If the calculator changes, Checkout
// changes with it, so the two amounts cannot drift apart silently.
//
// Test mode only in this build. The live API is contacted only when
// the caller supplies a key (STRIPE_SECRET_KEY from the vault) AND
// calls createCheckoutSession. The test harness injects a fake
// transport and never touches api.stripe.com. No key, real or test,
// is stored in this file, in tests, or in any output.
'use strict';
const https = require('https');
const { price } = require('../lib/pricing');

function toCents(usd) {
  return Math.round(Number(usd) * 100);
}

// Pure, testable. Returns the exact form-encoded field set that
// createCheckoutSession posts to Stripe, plus the computed price.
// mode is 'subscription': PRICING.md sells a monthly product, so the
// charge recurs; a one-time payment for a monthly product (the old
// v1) left month 2+ with no charge path and the deployment 'ready'
// forever. Provisioning keys off checkout.session.completed (see
// handler.js); payment_intent.succeeded remains handled for test
// mode. EVERY pricing input is persisted in metadata, and the
// handler recomputes from exactly those inputs — the old handler
// hardcoded tenantsPerInstance/transfer, so legitimate payers with
// non-default inputs mismatched and were silently never provisioned.
function buildCheckoutSessionParams(input) {
  const opts = input || {};
  if (!opts.tenantId) throw new Error('tenantId is required');
  const { isValidTenantId } = require('../lib/store');
  if (!isValidTenantId(opts.tenantId)) throw new Error('tenantId has an unexpected format');
  for (const k of ['successUrl', 'cancelUrl']) {
    if (opts[k] && !String(opts[k]).startsWith('https://')) {
      throw new Error(k + ' must be an https URL');
    }
  }
  const p = price({
    jobs: opts.jobs != null ? opts.jobs : 100,
    steps: opts.steps != null ? opts.steps : 10,
    storageGb: opts.storageGb != null ? opts.storageGb : 5,
    transferGb: opts.transferGb || 0,
    tenantsPerInstance: opts.tenantsPerInstance || 10,
    deployMode: opts.deployMode,
  });
  const amountCents = toCents(p.monthlyPriceUsd);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error('calculator produced a non-positive amount');
  }
  const idempotencyKey = 'ape_' + require('crypto').createHash('sha256')
    .update([opts.tenantId, amountCents, opts.jobs, opts.steps].join(':'))
    .digest('hex').slice(0, 32);
  return {
    price: p,
    amountCents,
    idempotencyKey,
    // Field set for POST https://api.stripe.com/v1/checkout/sessions,
    // application/x-www-form-urlencoded, Authorization: Bearer <key>.
    fields: {
      mode: 'subscription',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]':
        'APE for Business - ' + (opts.businessName || opts.tenantId),
      'line_items[0][price_data][unit_amount]': String(amountCents),
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][quantity]': '1',
      'metadata[tenantId]': opts.tenantId,
      'metadata[jobs]': String(opts.jobs != null ? opts.jobs : 100),
      'metadata[steps]': String(opts.steps != null ? opts.steps : 10),
      'metadata[storageGb]': String(opts.storageGb != null ? opts.storageGb : 5),
      'metadata[transferGb]': String(opts.transferGb || 0),
      'metadata[tenantsPerInstance]': String(opts.tenantsPerInstance || 10),
      'metadata[amountCents]': String(amountCents),
      'subscription_data[metadata][tenantId]': opts.tenantId,
      success_url: opts.successUrl || 'https://example.invalid/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: opts.cancelUrl || 'https://example.invalid/checkout/cancel',
    },
  };
}

function encodeForm(fields) {
  return Object.entries(fields)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

// Real Stripe transport, behind an injectable post function so tests
// never hit the network. Default transport posts to api.stripe.com
// with Bearer auth. It is only called when the caller provides a key.
function defaultPost(apiKey, body, extra) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path: '/v1/checkout/sessions',
      method: 'POST',
      timeout: 15000,
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Idempotency-Key': (extra && extra.idempotencyKey) || '',
      },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(s); } catch { parsed = { raw: s }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error('Stripe API error ' + res.statusCode);
          e.statusCode = res.statusCode;
          e.body = parsed;
          return reject(e);
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function createCheckoutSession(input, deps) {
  const d = deps || {};
  const apiKey = d.apiKey != null ? d.apiKey : process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    const e = new Error('STRIPE_SECRET_KEY is not configured; refusing to create a Checkout session');
    e.code = 'missing_secret';
    throw e;
  }
  const built = buildCheckoutSessionParams(input);
  const post = d.post || defaultPost;
  const session = await post(apiKey, encodeForm(built.fields), {
    idempotencyKey: built.idempotencyKey,
  });
  return { session, price: built.price, amountCents: built.amountCents };
}

module.exports = {
  buildCheckoutSessionParams, createCheckoutSession, encodeForm, toCents,
};
