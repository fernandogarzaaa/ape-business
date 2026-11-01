// Stripe webhook handler: verify, then provision, exactly once.
//
// Order is the security property:
//   1. Verify the signature. Unverified payloads never provision
//      and are never recorded as processed.
//   2. Claim the idempotency key ATOMICALLY before any await, so
//      two concurrent deliveries of one event provision once. The
//      old has()->await->record() sequence provisioned twice under
//      a concurrent retry (probed). If provision throws, the claim
//      is released and Stripe's retry can succeed.
//   3. Fail-closed amount check: a provisioning event MUST carry
//      the Checkout metadata (tenantId, amountCents, jobs, steps)
//      and amount_received MUST equal both the metadata amount and
//      the calculator amount recomputed from ALL persisted pricing
//      inputs. The old guard skipped silently when metadata was
//      absent, so a 1-cent intent provisioned (probed). Metadata-
//      less intents are ignored for human review, never provisioned.
//   4. Provision, then record. Subscription lifecycle:
//      checkout.session.completed provisions (subscription id is
//      the key), invoice.paid keeps the tenant paid,
//      customer.subscription.deleted / invoice.payment_failed
//      suspend via deps.onSubscriptionEvent when wired.
'use strict';

const { verifyWebhookSignature } = require('./verify.js');
const { price: calcPrice } = require('../lib/pricing');

function createWebhookHandler(deps) {
  const d = deps || {};
  if (typeof d.provision !== 'function') {
    throw new Error('provision function is required');
  }
  const store = d.store;
  if (!store) throw new Error('store is required (see lib/store.js)');
  const webhookSecret = d.webhookSecret != null
    ? d.webhookSecret : process.env.STRIPE_WEBHOOK_SECRET;

  function expectedCentsFor(md) {
    const expected = calcPrice({
      jobs: Number(md.jobs), steps: Number(md.steps),
      storageGb: Number(md.storageGb || 5),
      transferGb: Number(md.transferGb || 0),
      tenantsPerInstance: Number(md.tenantsPerInstance || 10),
      deployMode: md.deployMode || undefined,
    });
    return Math.round(expected.monthlyPriceUsd * 100);
  }

  async function provisionOnce(key, amountGate, obj) {
    // Amount gate runs before the claim so a tampered redelivery is
    // flagged as a mismatch, not masked as a duplicate.
    if (amountGate) {
      const verdict = amountGate();
      if (verdict) return verdict;
    }
    if (!store.claimIntent(key)) {
      const prior = store.getIntent(key);
      if (prior) return { duplicate: true, paymentIntentId: key, result: prior };
      return { duplicate: true, paymentIntentId: key, result: null, note: 'concurrent delivery in progress' };
    }
    try {
      const result = await d.provision(key, obj.event);
      store.recordIntent(key, result);
      return { provisioned: true, paymentIntentId: key, result };
    } catch (e) {
      store.releaseIntent(key);
      throw e;
    }
  }

  return async function handleStripeWebhook(rawBody, signatureHeader, opts) {
    const options = opts || {};
    const { event } = verifyWebhookSignature(
      rawBody, signatureHeader, webhookSecret, options,
    );
    const obj = event.data && event.data.object ? event.data.object : {};

    // Subscription provisioning entry. Signature verification
    // authenticates the event; it does NOT prove payment. Gate on
    // payment_status + amount exactly like the intent path — an
    // 'unpaid' session must never mark a tenant paid (Codex P1).
    // Deferred success arrives as checkout.session.async_payment_succeeded.
    if (event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded') {
      const md = obj.metadata || {};
      if (obj.payment_status !== 'paid') {
        return { ignored: true, reason: 'payment_not_completed', type: event.type };
      }
      if (!md.tenantId || !md.amountCents) {
        return { ignored: true, reason: 'missing_checkout_metadata', type: event.type };
      }
      if (obj.currency && obj.currency !== 'usd') {
        return { ignored: true, reason: 'amount_mismatch', type: event.type };
      }
      if (obj.amount_total == null || Number(obj.amount_total) !== Number(md.amountCents)) {
        return {
          ignored: true, reason: 'amount_mismatch', type: event.type,
          receivedCents: obj.amount_total == null ? null : Number(obj.amount_total),
          expectedAmountCentsInMetadata: Number(md.amountCents),
        };
      }
      const key = obj.subscription || obj.id;
      return provisionOnce(key, null, { event });
    }
    if (event.type === 'checkout.session.async_payment_failed') {
      return { ignored: true, reason: 'payment_not_completed', type: event.type };
    }
    if (event.type === 'invoice.paid' ||
        event.type === 'customer.subscription.deleted' ||
        event.type === 'invoice.payment_failed') {
      if (typeof d.onSubscriptionEvent === 'function') {
        const out = await d.onSubscriptionEvent(event);
        return { handled: true, type: event.type, result: out || null };
      }
      return { ignored: true, reason: 'subscription_event_unwired', type: event.type };
    }
    if (event.type !== 'payment_intent.succeeded') {
      return { ignored: true, reason: 'event_type_not_succeeded', type: event.type };
    }
    const paymentIntentId = obj.id;
    if (!paymentIntentId) {
      const e = new Error('payment_intent.succeeded event has no payment intent id');
      e.code = 'missing_intent';
      throw e;
    }
    const md = obj.metadata || {};
    const gate = () => {
      if (!md.tenantId || !md.amountCents || md.jobs == null || md.steps == null) {
        return {
          ignored: true, reason: 'missing_checkout_metadata',
          paymentIntentId,
          note: 'Provisioning requires Checkout metadata. Route to manual review; never provision.',
        };
      }
      let expectedCents;
      try {
        expectedCents = expectedCentsFor(md);
      } catch {
        return { ignored: true, reason: 'amount_unverifiable', paymentIntentId };
      }
      const receivedCents = obj.amount_received != null
        ? obj.amount_received : obj.amount;
      if (receivedCents == null ||
          Number(receivedCents) !== Number(md.amountCents) ||
          Number(receivedCents) !== expectedCents) {
        return {
          ignored: true, reason: 'amount_mismatch',
          paymentIntentId,
          receivedCents: receivedCents == null ? null : Number(receivedCents),
          expectedCents, expectedAmountCentsInMetadata: Number(md.amountCents),
        };
      }
      return null;
    };
    return provisionOnce(paymentIntentId, gate, { event });
  };
}

module.exports = { createWebhookHandler };
