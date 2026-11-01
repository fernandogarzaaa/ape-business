// Sealbox content gate, Day 1 integration for APE for Business.
// Design source: provisioning/SECURITY.md section 4.
//
// Rules, enforced here:
// - Before any job payload leaves the tenant boundary, PII in it is
//   replaced with stable, tenant-scoped tokens. The same raw value
//   always maps to the same token inside one tenant. Tokens are
//   only ever resolved together with their tenant id, via
//   detokenize(text, tenantId) — a token string alone names nothing.
// - Token maps persist when a store is supplied (lib/store.js), so
//   a restart can never remap <EMAIL_1> to a different person. The
//   in-memory fallback exists for unit tests and is labeled as such.
// - Audit events carry no raw PII: event, tenant, timestamp, the
//   PER-CALL token count, and SHA-256 of the tokenized text.
//   getAuditLog(tenantId) filters per tenant and returns copies.
//
// Tokenized: emails, phone numbers (US + E.164 international),
// SSNs, payment cards (Luhn-validated), and credential-shaped
// strings (sk_live/sk_test/whsec_, AKIA…, "password: …").
// NOT tokenized: person names and street addresses in free text.
// Guessing names creates false tokens and false misses; a name that
// must be protected must arrive as a structured field. SECURITY.md
// claims exactly this and no more.
'use strict';

const crypto = require('crypto');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const SECRET_RE = /\b(?:sk_live|sk_test|whsec)_[A-Za-z0-9]{8,}\b|\bAKIA[0-9A-Z]{16}\b|\bpassword\s*[:=]\s*\S+/gi;
// Longest-first phone patterns: E.164 international, then US forms.
const PHONE_RE = /(?:\+\d{10,15}\b|\+1\d{10}\b|1\d{10}\b|\b\d{10}\b|(?:\+?1[\s\-.]?)?(?:\(?\d{3}\)?[\s\-.])?\d{3}[\s\-.]\d{4}\b|\+\d{1,3}(?:[\s\-.]\d{2,4}){2,4}\b)/g;
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
}

function createSealboxGate(deps) {
  const store = deps && deps.store ? deps.store : null;
  const stores = new Map(); // fallback only (tests); restart remaps!
  const auditLog = [];

  function memStoreFor(tenantId) {
    if (!stores.has(tenantId)) {
      stores.set(tenantId, { byRaw: new Map(), byToken: new Map(), counters: {} });
    }
    return stores.get(tenantId);
  }

  function tokenFor(tenantId, kind, raw, callTokens) {
    if (callTokens.has(raw)) return callTokens.get(raw);
    let token;
    if (store) {
      token = store.sealboxTokenFor(tenantId, kind, raw);
    } else {
      const s = memStoreFor(tenantId);
      if (s.byRaw.has(raw)) {
        token = s.byRaw.get(raw);
      } else {
        const n = (s.counters[kind] = (s.counters[kind] || 0) + 1);
        token = `<${kind}_${n}>`;
        s.byRaw.set(raw, token);
        s.byToken.set(token, raw);
      }
    }
    callTokens.set(raw, token);
    return token;
  }

  function entriesFor(tenantId) {
    if (store) return store.sealboxEntries(tenantId);
    const s = stores.get(tenantId);
    if (!s) return [];
    return [...s.byToken.entries()].map(([token, raw]) => ({ token, raw }));
  }

  function tokenize(text, tenantId) {
    if (!tenantId || typeof tenantId !== 'string') {
      throw new Error('sealbox tokenize requires a tenantId');
    }
    let tokenized = String(text ?? '');
    // Literal token syntax in inbound text is NOT a reference; mark
    // it :literal so it can never resolve to an earlier value.
    tokenized = tokenized.replace(
      /<(EMAIL|PHONE|SSN|CARD|SECRET)_\d+>/g,
      (m) => m.replace('>', ':literal>'));
    const callTokens = new Map();
    // Order matters: credentials and SSNs first (their digits must
    // not be eaten by the card/phone patterns), cards next (Luhn
    // gate keeps order numbers out), then email, then phones.
    tokenized = tokenized.replace(SECRET_RE, (m) => tokenFor(tenantId, 'SECRET', m, callTokens));
    tokenized = tokenized.replace(SSN_RE, (m) => tokenFor(tenantId, 'SSN', m, callTokens));
    tokenized = tokenized.replace(CARD_CANDIDATE_RE, (m) => {
      const digits = m.replace(/[ -]/g, '');
      return luhnValid(digits) ? tokenFor(tenantId, 'CARD', m, callTokens) : m;
    });
    tokenized = tokenized.replace(EMAIL_RE, (m) => tokenFor(tenantId, 'EMAIL', m, callTokens));
    tokenized = tokenized.replace(PHONE_RE, (m) => tokenFor(tenantId, 'PHONE', m, callTokens));
    const count = callTokens.size;
    let event;
    if (store) {
      event = store.sealboxAudit(tenantId, count, sha256hex(tokenized));
    } else {
      event = {
        event: 'sealbox_tokenize', tenantId,
        timestamp: new Date().toISOString(),
        tokenCount: count, payloadHash: sha256hex(tokenized),
      };
      auditLog.push(event);
    }
    return { tokenized, tokens: count, audit: { ...event } };
  }

  function detokenize(text, tenantId) {
    if (!tenantId) throw new Error('sealbox detokenize requires a tenantId');
    let out = String(text ?? '');
    // Longest token first, so <EMAIL_10> is never half-eaten by
    // a <EMAIL_1> replacement.
    const entries = entriesFor(tenantId)
      .sort((a, b) => b.token.length - a.token.length);
    for (const { token, raw } of entries) {
      out = out.split(token).join(raw);
    }
    return out;
  }

  return {
    tokenize,
    detokenize,
    getAuditLog: (tenantId) => {
      if (store) return store.sealboxAuditLog(tenantId);
      const rows = tenantId
        ? auditLog.filter((e) => e.tenantId === tenantId) : auditLog;
      return rows.map((e) => ({ ...e })); // copies: callers cannot tamper
    },
    tokenCount: (tenantId) => (store
      ? store.sealboxTokenCount(tenantId)
      : (stores.get(tenantId)?.byRaw.size ?? 0)),
  };
}

module.exports = { createSealboxGate, sha256hex, luhnValid };
