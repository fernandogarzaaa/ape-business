// Stripe webhook handler: verify, then provision, exactly once.
//
// Order is the security property:
//   1. Verify the signature. Unverified payloads never provision,
//      and are never recorded as processed.
//   2. Ignore non-succeeded events. A failed payment never starts
//      provisioning (same rule as pipeline.js).
//   3. Check amount against the calculator when the event carries
//      the jobs/steps metadata Checkout wrote. A mismatch stops the
//      pipeline for a human look (DEPLOYMENT_PIPELINE.md), it does
//      not provision at the wrong price.
//   4. Check idempotency on payment intent id. A duplicate delivery
//      returns the stored result and never calls provision again.
//   5. Only then call provision(paymentIntentId, event).
//
// Store interface: { has(intentId), get(intentId), record(intentId, result) }.
// Default store is a JSON file next to this module; tests inject an
// in-memory store so test runs leave no persistent state. The store
// holds intent ids and provisioning results only, never secrets.
'use strict';
const fs = require('fs');
const path = require('path');
const { verifyWebhookSignature } = require('./verify.js');
// Calculator lives in server.js; used for the amount-mismatch check.
const { price: calcPrice } = require('../server.js');

function fileStore(filePath) {
  const file = filePath || path.join(__dirname, 'processed-intents.json');
  function readAll() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return {}; }
  }
  return {
    has: (id) => Object.prototype.hasOwnProperty.call(readAll(), id),
    get: (id) => readAll()[id],
    record: (id, result) => {
      const all = readAll();
      all[id] = result;
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    },
  };
}

function createWebhookHandler(deps) {
  const d = deps || {};
  if (typeof d.provision !== 'function') {
    throw new Error('provision function is required');
  }
  const store = d.store || fileStore(d.storePath);
  const webhookSecret = d.webhookSecret != null
    ? d.webhookSecret : process.env.STRIPE_WEBHOOK_SECRET;

  return async function handleStripeWebhook(rawBody, signatureHeader, opts) {
    const options = opts || {};
    // Step 1: signature, or nothing else happens.
    const { event } = verifyWebhookSignature(
      rawBody, signatureHeader, webhookSecret, options,
    );
    // Step 2: only a succeeded payment intent starts provisioning.
    if (event.type !== 'payment_intent.succeeded') {
      return { ignored: true, reason: 'event_type_not_succeeded', type: event.type };
    }
    const obj = event.data && event.data.object ? event.data.object : {};
    const paymentIntentId = obj.id;
    if (!paymentIntentId) {
      const e = new Error('payment_intent.succeeded event has no payment intent id');
      e.code = 'missing_intent';
      throw e;
    }
    // Step 4 (checked before provisioning, after signature): duplicate.
    if (store.has(paymentIntentId)) {
      return { duplicate: true, paymentIntentId, result: store.get(paymentIntentId) };
    }
    // Step 3: amount check, only when Checkout metadata is present.
    const md = obj.metadata || {};
    if (md.amountCents && md.jobs != null && md.steps != null) {
      const expected = calcPrice({
        jobs: Number(md.jobs), steps: Number(md.steps),
        storageGb: Number(md.storageGb || 5), tenantsPerInstance: 10,
      });
      const expectedCents = Math.round(expected.monthlyPriceUsd * 100);
      const receivedCents = obj.amount_received != null
        ? obj.amount_received : obj.amount;
      if (receivedCents != null && Number(receivedCents) !== expectedCents) {
        return {
          ignored: true, reason: 'amount_mismatch',
          paymentIntentId, receivedCents: Number(receivedCents),
          expectedCents, expectedAmountCentsInMetadata: Number(md.amountCents),
        };
      }
    }
    // Step 5: provision, then record. If provision throws, nothing is
    // recorded, so a later redelivery can retry instead of silently
    // marking a failed deploy as done.
    const result = await d.provision(paymentIntentId, event);
    store.record(paymentIntentId, result);
    return { provisioned: true, paymentIntentId, result };
  };
}

module.exports = { createWebhookHandler, fileStore };
