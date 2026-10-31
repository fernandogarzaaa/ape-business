// Stripe webhook signature verification. Node only, no dependencies.
//
// Stripe signs:  HMAC-SHA256(webhookSecret, "<timestamp>.<rawBody>")
// Header form:  Stripe-Signature: t=<unixSeconds>,v1=<hex>,v1=<hex>,...
// Rules enforced here, matching Stripe's documented behaviour:
//   - header must be present, with a t= and at least one v1=
//   - |now - timestamp| must be <= toleranceSeconds (default 300)
//   - at least one v1= must match, compared in constant time
//   - anything else is rejected, and the caller must NOT provision
// Secrets are never in this file. The caller passes the secret in as
// process.env.STRIPE_WEBHOOK_SECRET (name only, value from the vault).
// This file never logs a secret, a signature, or a raw body.
'use strict';
const crypto = require('crypto');

const DEFAULT_TOLERANCE_SECONDS = 300;

function parseStripeSignature(header) {
  if (!header || typeof header !== 'string') return null;
  const out = { t: null, v1: [] };
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') out.t = v;
    if (k === 'v1' && v) out.v1.push(v);
  }
  if (!out.t || !out.v1.length) return null;
  return out;
}

function safeEqualHex(a, b) {
  // timingSafeEqual throws on unequal lengths, so compare only on
  // equal-length buffers and treat any length mismatch as unequal.
  let ab;
  let bb;
  try {
    ab = Buffer.from(a, 'hex');
    bb = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (ab.length !== bb.length) return false;
  if (ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Returns { event, timestamp } on success. Throws Error with a
// machine-readable .code on any failure: missing_signature,
// invalid_signature, stale_timestamp, invalid_payload.
function verifyWebhookSignature(rawBody, signatureHeader, secret, opts) {
  const options = opts || {};
  const tolerance = options.toleranceSeconds != null
    ? options.toleranceSeconds : DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = options.nowSeconds != null
    ? options.nowSeconds : Math.floor(Date.now() / 1000);
  if (!secret) {
    const e = new Error('stripe webhook secret is not configured');
    e.code = 'missing_secret';
    throw e;
  }
  const parsed = parseStripeSignature(signatureHeader);
  if (!parsed) {
    const e = new Error('missing or malformed Stripe-Signature header');
    e.code = 'missing_signature';
    throw e;
  }
  const timestamp = Number(parsed.t);
  if (!Number.isFinite(timestamp)) {
    const e = new Error('malformed Stripe-Signature timestamp');
    e.code = 'invalid_signature';
    throw e;
  }
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    const e = new Error('Stripe webhook timestamp outside tolerance');
    e.code = 'stale_timestamp';
    throw e;
  }
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const signedPayload = Buffer.concat([
    Buffer.from(String(timestamp) + '.', 'utf8'), body,
  ]);
  const expected = crypto.createHmac('sha256', secret)
    .update(signedPayload).digest('hex');
  const ok = parsed.v1.some((v) => safeEqualHex(v, expected));
  if (!ok) {
    const e = new Error('Stripe webhook signature does not match');
    e.code = 'invalid_signature';
    throw e;
  }
  let event;
  try {
    event = JSON.parse(body.toString('utf8'));
  } catch {
    const e = new Error('Stripe webhook body is not valid JSON');
    e.code = 'invalid_payload';
    throw e;
  }
  return { event, timestamp };
}

module.exports = {
  verifyWebhookSignature, parseStripeSignature, DEFAULT_TOLERANCE_SECONDS,
};
