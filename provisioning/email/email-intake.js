// Inbound email intake for APE for Business.
//
// REAL integration code, TEST ONLY in this folder. It reads no real
// mailbox, sends no real email, and holds no real credential. The
// caller supplies parsed messages; production callers must pass
// provider-verified mail (see email/webhook-server.js, which checks
// the provider secret and requires DMARC-aligned results). This
// module decides tenant, spam, opt-out, rate limit, and Sealbox
// tokenization, and returns one APE job per accepted message. The
// reply is a draft built from TOKENIZED text: raw PII never enters
// a draft that a model or log might quote back.
//
// Opt-out is intent-based, never substring-based: a List-Unsubscribe
// header, an exact command, or "unsubscribe me" opts out. "Do not
// unsubscribe me" and "What is your unsubscribe policy?" do not
// (both were probed false positives in the old substring code).
'use strict';

const crypto = require('crypto');
const { createSealboxGate } = require('../sealbox');

const DEFAULT_RATE_LIMIT = 20; // messages per sender per window
const DEFAULT_RATE_WINDOW_MS = 60 * 1000;
const SPAM_KEYWORDS = ['you have won', 'claim your prize', 'wire transfer fee', 'inheritance claim', 'double your money'];

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function headerMap(headers) {
  const lowered = {};
  for (const [k, v] of Object.entries(headers || {})) {
    lowered[String(k).toLowerCase()] = v;
  }
  return lowered;
}

// Parse real Authentication-Results values ("mx; spf=pass smtp.mailfrom=…;
// dkim=fail; dmarc=pass") instead of substring hunting, which both
// missed "spf = fail" spacing variants and fired on comments.
function parseAuthResults(headers) {
  const auth = String(headerMap(headers)['authentication-results'] || '').toLowerCase();
  const out = {};
  const re = /\b(spf|dkim|dmarc)\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b/g;
  let m;
  while ((m = re.exec(auth)) !== null) out[m[1]] = m[2];
  return out;
}

function isSpam({ from, subject, body, headers }) {
  const hay = `${subject || ''} ${body || ''}`.toLowerCase();
  if (SPAM_KEYWORDS.some((k) => hay.includes(k))) return 'spam_keyword';
  const auth = parseAuthResults(headers);
  // DMARC failure is the spoof signal. SPF failure screens too (kept
  // from the verified harness). DKIM failure ALONE is only a signal:
  // mailing lists break DKIM routinely, so it never blocks by itself.
  if (auth.dmarc === 'fail' || auth.spf === 'fail') return 'auth_fail';
  if (!from || !from.includes('@')) return 'bad_sender';
  return null;
}

function authUnverified(headers) {
  const auth = parseAuthResults(headers);
  return auth.dmarc !== 'pass'; // no aligned DMARC pass = unverified
}

function isOptOut(message, headers) {
  const h = headerMap(headers);
  if (h['list-unsubscribe']) return true;
  const subject = String(message.subject || '').trim().toLowerCase();
  const body = String(message.body || '').trim().toLowerCase();
  const text = subject + ' ' + body;
  if (/\b(do not|don't|dont|never|not)\b[^.!?]*\bunsubscribe\b/.test(text)) return false;
  if (/\bunsubscribe\b[^.!?]*\b(policy|preferences center)\b/.test(text) && text.includes('?')) return false;
  if (subject === 'unsubscribe' || body === 'unsubscribe' ||
      subject === 'opt out' || body === 'opt out') return true;
  if (/\b(please\s+)?unsubscribe\s+me\b/.test(text)) return true;
  return false;
}

function createEmailHandler(options) {
  const tenants = options.tenants || {}; // agent email -> tenant object
  const rateLimit = options.rateLimit || DEFAULT_RATE_LIMIT;
  const rateWindowMs = options.rateWindowMs || DEFAULT_RATE_WINDOW_MS;
  const requireVerified = Boolean(options.requireVerified);
  const store = options.store || null;

  const jobs = [];
  const seenMessageIds = new Map();
  const optedOut = new Set();
  const seenSenders = new Set();
  const senderTimestamps = new Map();
  const sealbox = createSealboxGate(store ? { store } : undefined);

  function dedupGet(tenantId, id) {
    if (!id) return null;
    if (store) return store.getDedup(tenantId, 'email', id);
    return seenMessageIds.get(`${tenantId}:${id}`) || null;
  }
  function dedupPut(tenantId, id, result) {
    if (!id || result.reason === 'rate_limited') return;
    if (store) store.putDedup(tenantId, 'email', id, result);
    else seenMessageIds.set(`${tenantId}:${id}`, result);
  }
  function isOut(tenantId, sender) {
    return store ? store.isOptedOut(tenantId, sender)
      : optedOut.has(`${tenantId}:${sender}`);
  }
  function setOut(tenantId, sender, out) {
    if (store) { if (out) store.optOut(tenantId, sender); else store.optIn(tenantId, sender); }
    else if (out) optedOut.add(`${tenantId}:${sender}`);
    else optedOut.delete(`${tenantId}:${sender}`);
  }
  function checkRateLimit(tenantId, sender, now) {
    const key = `${tenantId}:${sender}`;
    const times = (senderTimestamps.get(key) || []).filter((t) => now - t < rateWindowMs);
    if (times.length >= rateLimit) {
      senderTimestamps.set(key, times);
      return false;
    }
    times.push(now);
    senderTimestamps.set(key, times);
    return true;
  }

  function firstReplyPrefix(tenant) {
    const intro = tenant.intro ||
      `Hi, I am ${tenant.agentName || 'the agent'}, the AI assistant for ${tenant.businessName || 'this business'}.`;
    if (/AI assistant/i.test(intro)) return intro;
    return `${intro} I am an AI assistant, not a human employee.`;
  }

  // message: { to, from, subject, body, messageId, headers, now }
  function handleInbound(message) {
    const ts = message.now || Date.now();
    const to = normalizeEmail(message.to);
    const from = normalizeEmail(message.from);
    const subject = String(message.subject || '');
    const body = String(message.body || '');
    // No Message-ID: synthesize one from content so redeliveries of
    // the same mail dedup instead of double-creating jobs.
    const id = message.messageId ||
      'synth_' + crypto.createHash('sha256')
        .update([from, to, subject, body].join('\n'), 'utf8').digest('hex').slice(0, 24);
    const tenant = tenants[to] || null;
    if (!tenant) {
      return { status: 404, jobId: null, reason: 'unknown_tenant', replyDraft: null };
    }
    const cached = dedupGet(tenant.id, id);
    if (cached) return cached;
    const headers = message.headers || {};
    // Opt-out BEFORE spam: an unsubscribe carrying a spam keyword
    // must still unsubscribe the sender (old order lost it forever).
    if (isOptOut(message, headers)) {
      setOut(tenant.id, from, true);
      const result = { status: 200, jobId: null, reason: 'opted_out', replyDraft: 'You are opted out. Reply START to opt back in.' };
      dedupPut(tenant.id, id, result);
      return result;
    }
    if (isOut(tenant.id, from)) {
      const explicitStart = subject.trim().toUpperCase() === 'START' || body.trim().toUpperCase() === 'START';
      if (explicitStart) {
        setOut(tenant.id, from, false);
        const result = { status: 200, jobId: null, reason: 'opted_in', replyDraft: 'You are opted back in. How can I help?' };
        dedupPut(tenant.id, id, result);
        return result;
      }
      const result = { status: 200, jobId: null, reason: 'blocked_opted_out', replyDraft: null };
      dedupPut(tenant.id, id, result);
      return result;
    }
    const spam = isSpam({ from, subject, body, headers });
    if (spam) {
      const result = { status: 200, jobId: null, reason: 'spam_' + spam, replyDraft: null };
      dedupPut(tenant.id, id, result);
      return result;
    }
    if (requireVerified && authUnverified(headers)) {
      const result = { status: 200, jobId: null, reason: 'spam_auth_unverified', replyDraft: null };
      dedupPut(tenant.id, id, result);
      return result;
    }
    if (!checkRateLimit(tenant.id, from, ts)) {
      return { status: 200, jobId: null, reason: 'rate_limited', replyDraft: null };
    }
    // Intake record only — no tool is dispatched here; the Sigil
    // gate runs in the APE loop. The record says so.
    const sigil = { checked: false, policy: tenant.sigilPolicy || 'standard', decision: 'not_applicable', reason: 'intake_only_no_tool_dispatch' };
    const sealedSubject = sealbox.tokenize(subject, tenant.id);
    const sealedBody = sealbox.tokenize(body, tenant.id);
    const jobId = store
      ? 'job_' + crypto.randomUUID().slice(0, 8)
      : `job_${jobs.length + 1}`;
    const isFirst = store
      ? store.markSenderSeen(tenant.id, from)
      : !seenSenders.has(`${tenant.id}:${from}`);
    if (!store) seenSenders.add(`${tenant.id}:${from}`);
    const job = {
      jobId, tenantId: tenant.id, channel: 'email', sender: from, to,
      subject, body, subjectForDispatch: sealedSubject.tokenized,
      bodyForDispatch: sealedBody.tokenized,
      sealbox: { subject: sealedSubject.audit, body: sealedBody.audit },
      status: 'unverified', sigil, createdAt: new Date(ts).toISOString(),
    };
    if (store) store.addJob(job); else jobs.push(job);
    // Draft quotes the TOKENIZED subject: the old draft interpolated
    // the raw subject and leaked PII the dispatch body had removed.
    const replyDraft = isFirst
      ? `${firstReplyPrefix(tenant)} Thanks for your email about "${sealedSubject.tokenized}". I have logged it and will follow up.`
      : `Thanks for your email about "${sealedSubject.tokenized}". I have logged it and will follow up.`;
    const result = { status: 200, jobId, reason: 'job_created', replyDraft };
    dedupPut(tenant.id, id, result);
    return result;
  }

  return {
    handleInbound,
    getJobs: () => (store
      ? store.listJobs()
      : jobs.map((j) => JSON.parse(JSON.stringify(j)))),
    getSealboxAuditLog: (tenantId) => sealbox.getAuditLog(tenantId),
    detokenizeForChannel: (text, tenantId) => sealbox.detokenize(text, tenantId),
    isOptedOut: (tenantId, sender) => isOut(tenantId, normalizeEmail(sender)),
  };
}

module.exports = { createEmailHandler, isSpam, parseAuthResults, isOptOut };
