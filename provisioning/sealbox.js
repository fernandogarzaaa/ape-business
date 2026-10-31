// Sealbox content gate, Day 1 integration for APE for Business.
//
// Design source: provisioning/SECURITY.md section 4 and the Sealbox
// design at ~/workspace/sealbox (local design only, not a shipped
// product). This module is the wiring, not a claim that Sealbox
// itself is shipped.
//
// Rules, enforced here:
// - Before any job payload leaves the tenant boundary (to a model,
//   a tool, or a shared log), PII in it is replaced with stable,
//   tenant-scoped tokens. The same raw value always maps to the
//   same token inside one tenant, and never to the same token
//   in another tenant.
// - The token map lives only in this tenant's store. In this
//   prototype the store is in memory per handler, exactly like
//   the SMS handler's job state. Production must replace it
//   with the tenant vault file or Secrets Manager secret named
//   in SECURITY.md, and must never log the map.
// - Tokens are resolved back only when presenting to the
//   authorized owner or customer channel, via detokenize().
// - Every tokenization emits a schema-fixed audit event that
//   carries no raw PII: event name, tenant id, timestamp,
//   token count, and the SHA-256 hash of the tokenized text.
//
// What is tokenized today: email addresses and phone numbers.
// Names are not guessed from free text, because guessing names
// creates false tokens and false misses. A name that must be
// protected should arrive as a structured field, not be inferred
// from a sentence. That limit is stated, not hidden.
'use strict';

const crypto = require('crypto');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone numbers, in longest-first order so a contiguous number is
// not half-matched by the formatted pattern:
// - E.164 with plus: +14155552671
// - 11 contiguous digits starting with 1: 14155552671
// - 10 contiguous digits: 4155552671
// - Formatted: 415-555-2671, (415) 555-2671, +1 415-555-2671
// A 10-digit run that is not a phone (an order number, for
// example) is tokenized too. The gate is conservative on purpose:
// a missed phone leaks PII, a tokenized order number only looks
// odd in the dispatch body and resolves back on the channel.
const PHONE_RE = /(?:\+1\d{10}\b|1\d{10}\b|\b\d{10}\b|(?:\+?1[\s\-.]?)?(?:\(?\d{3}\)?[\s\-.])?\d{3}[\s\-.]\d{4}\b)/g;

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function createSealboxGate() {
  // tenantId -> Map(rawValue -> token), and token -> rawValue.
  const stores = new Map();
  const auditLog = [];

  function storeFor(tenantId) {
    if (!stores.has(tenantId)) stores.set(tenantId, { byRaw: new Map(), byToken: new Map(), emailCount: 0, phoneCount: 0 });
    return stores.get(tenantId);
  }

  function tokenFor(store, kind, raw) {
    if (store.byRaw.has(raw)) return store.byRaw.get(raw);
    const n = kind === 'EMAIL' ? ++store.emailCount : ++store.phoneCount;
    const token = `<${kind}_${n}>`;
    store.byRaw.set(raw, token);
    store.byToken.set(token, raw);
    return token;
  }

  function tokenize(text, tenantId) {
    const store = storeFor(tenantId);
    let tokenized = String(text ?? '');
    // Literal token syntax in inbound text is NOT a reference.
    // Without this, a message saying "<EMAIL_1>" would detokenize
    // to a value from an earlier message in the same tenant.
    // Marking it :literal keeps it visible but unresolvable.
    tokenized = tokenized.replace(/<(EMAIL|PHONE)_\d+>/g, (m) => m.replace('>', ':literal>'));
    tokenized = tokenized.replace(EMAIL_RE, (m) => tokenFor(store, 'EMAIL', m));
    tokenized = tokenized.replace(PHONE_RE, (m) => tokenFor(store, 'PHONE', m));
    const event = {
      event: 'sealbox_tokenize',
      tenantId,
      timestamp: new Date().toISOString(),
      tokenCount: store.byRaw.size,
      payloadHash: sha256hex(tokenized),
    };
    auditLog.push(event);
    return { tokenized, tokens: store.byRaw.size, audit: event };
  }

  function detokenize(text, tenantId) {
    const store = storeFor(tenantId);
    let out = String(text ?? '');
    for (const [token, raw] of store.byToken.entries()) {
      out = out.split(token).join(raw);
    }
    return out;
  }

  return {
    tokenize,
    detokenize,
    getAuditLog: () => auditLog.slice(),
    tokenCount: (tenantId) => (stores.get(tenantId)?.byRaw.size ?? 0),
  };
}

module.exports = { createSealboxGate, sha256hex };
