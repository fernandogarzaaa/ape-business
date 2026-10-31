// Inbound email intake for APE for Business.
//
// REAL integration code, TEST ONLY in this folder. It reads no real
// mailbox, sends no real email, and holds no real credential. The
// caller supplies parsed messages (from Gmail, SES, or any provider
// webhook); this module decides tenant, spam, opt-out, rate limit,
// Sigil intake, and Sealbox tokenization, and returns one APE job
// per accepted message.
//
// Security mapping (see ../SECURITY.md):
// - Tenant isolation: the To address maps to exactly one tenant's
//   agent email. An unknown To address gets no job and no reply.
// - Inbound text is data, never instructions. The dispatch body
//   is Sealbox-tokenized (provisioning/sealbox.js); raw text stays
//   in the tenant-local ledger only, and the audit log carries no
//   raw PII.
// - Sigil intake gate: recorded on the job. Tool dispatch inside
//   the APE loop is gated separately and is not done here.
// - Spam and opt-out run BEFORE any job is created, so a spam or
//   opted-out sender never costs a job. Spam here is a small
//   header and keyword screen, not a verdict: it blocks obvious
//   junk and marks the rest as unfiltered, never as safe.
// - The agent identifies itself as an AI agent in its first reply
//   to each sender, per tenant. It never presents as a human.
// - Reply content is returned as a draft, never sent by this
//   module. Sending is the provider's job, after the owner's
//   channel is connected for real.
'use strict';

const { createSealboxGate } = require('../sealbox');

const DEFAULT_RATE_LIMIT = 20; // messages per sender per window
const DEFAULT_RATE_WINDOW_MS = 60 * 1000;
const SPAM_KEYWORDS = ['you have won', 'claim your prize', 'wire transfer fee', 'inheritance claim', 'double your money'];

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function isSpam({ from, subject, body, headers }) {
  const hay = `${subject || ''} ${body || ''}`.toLowerCase();
  if (SPAM_KEYWORDS.some((k) => hay.includes(k))) return 'spam_keyword';
  // Header names arrive in any capitalization from different
  // providers. Normalize before lookup, or an explicit spf=fail
  // under "Authentication-Results" is silently ignored.
  const lowered = {};
  for (const [k, v] of Object.entries(headers || {})) lowered[String(k).toLowerCase()] = v;
  const auth = String(lowered['authentication-results'] || '').toLowerCase();
  if (auth.includes('dmarc=fail') || auth.includes('spf=fail')) return 'auth_fail';
  if (!from || !from.includes('@')) return 'bad_sender';
  return null;
}

function createEmailHandler(options) {
  const tenants = options.tenants || {}; // agent email -> tenant object
  const rateLimit = options.rateLimit || DEFAULT_RATE_LIMIT;
  const rateWindowMs = options.rateWindowMs || DEFAULT_RATE_WINDOW_MS;

  const jobs = [];
  const seenMessageIds = new Map();
  const optedOut = new Set();
  const seenSenders = new Set();
  const senderTimestamps = new Map();
  const sealbox = createSealboxGate();

  function checkRateLimit(sender, now) {
    const times = (senderTimestamps.get(sender) || []).filter((t) => now - t < rateWindowMs);
    if (times.length >= rateLimit) {
      senderTimestamps.set(sender, times);
      return false;
    }
    times.push(now);
    senderTimestamps.set(sender, times);
    return true;
  }

  function firstReplyPrefix(tenant) {
    const intro = tenant.intro ||
      `Hi, I am ${tenant.agentName || 'the agent'}, the AI assistant for ${tenant.businessName || 'this business'}.`;
    if (/AI assistant/i.test(intro)) return intro;
    return `${intro} I am an AI assistant, not a human employee.`;
  }

  // message: { to, from, subject, body, messageId, headers, now }
  // Returns { status, jobId, reason, replyDraft }.
  function handleInbound(message) {
    const ts = message.now || Date.now();
    const id = message.messageId || '';
    const to = normalizeEmail(message.to);
    const from = normalizeEmail(message.from);
    const subject = String(message.subject || '');
    const body = String(message.body || '');
    // Recipient first, dedup second, and dedup scoped to the
    // tenant. A global message-id cache let a second tenant's
    // delivery return the first tenant's cached result, and let
    // an unknown recipient bypass the unknown-tenant rejection.
    const tenant = tenants[to] || null;
    if (!tenant) {
      return { status: 404, jobId: null, reason: 'unknown_tenant', replyDraft: null };
    }
    const dedupKey = `${tenant.id}:${id}`;
    if (id && seenMessageIds.has(dedupKey)) return seenMessageIds.get(dedupKey);
    const optKey = `${tenant.id}:${from}`;
    const spam = isSpam({ from, subject, body, headers: message.headers || {} });
    if (spam) {
      const result = { status: 200, jobId: null, reason: 'spam_' + spam, replyDraft: null };
      if (id) seenMessageIds.set(dedupKey, result);
      return result;
    }
    const hay = `${subject} ${body}`.toLowerCase();
    if (hay.includes('unsubscribe') || hay.includes('opt out') || hay.includes('opt-out')) {
      optedOut.add(optKey);
      const result = { status: 200, jobId: null, reason: 'opted_out', replyDraft: 'You are opted out. Reply START to opt back in.' };
      if (id) seenMessageIds.set(dedupKey, result);
      return result;
    }
    if (optedOut.has(optKey)) {
      // Opt-in requires an explicit START command, not a word
      // that merely contains "start" ("Do not restart emails"
      // used to silently clear the opt-out).
      const explicitStart = subject.trim().toUpperCase() === 'START' || body.trim().toUpperCase() === 'START';
      if (explicitStart) {
        optedOut.delete(optKey);
        const result = { status: 200, jobId: null, reason: 'opted_in', replyDraft: 'You are opted back in. How can I help?' };
        if (id) seenMessageIds.set(dedupKey, result);
        return result;
      }
      const result = { status: 200, jobId: null, reason: 'blocked_opted_out', replyDraft: null };
      if (id) seenMessageIds.set(dedupKey, result);
      return result;
    }
    if (!checkRateLimit(from, ts)) {
      const result = { status: 200, jobId: null, reason: 'rate_limited', replyDraft: null };
      if (id) seenMessageIds.set(dedupKey, result);
      return result;
    }
    const sigil = { checked: true, policy: tenant.sigilPolicy || 'standard', decision: 'allow', reason: 'email_intake_no_tool_dispatch_yet' };
    const sealedSubject = sealbox.tokenize(subject, tenant.id);
    const sealedBody = sealbox.tokenize(body, tenant.id);
    const jobId = `job_${jobs.length + 1}`;
    const isFirst = !seenSenders.has(optKey);
    seenSenders.add(optKey);
    const job = {
      jobId, tenantId: tenant.id, channel: 'email', sender: from, to,
      subject, body, subjectForDispatch: sealedSubject.tokenized,
      bodyForDispatch: sealedBody.tokenized, sealbox: sealedBody.audit,
      status: 'unverified', sigil, createdAt: new Date(ts).toISOString(),
    };
    jobs.push(job);
    const replyDraft = isFirst
      ? `${firstReplyPrefix(tenant)} Thanks for your email about "${subject}". I have logged it and will follow up.`
      : `Thanks for your email about "${subject}". I have logged it and will follow up.`;
    const result = { status: 200, jobId, reason: 'job_created', replyDraft };
    if (id) seenMessageIds.set(dedupKey, result);
    return result;
  }

  return {
    handleInbound,
    getJobs: () => jobs.slice(),
    getSealboxAuditLog: () => sealbox.getAuditLog(),
    detokenizeForChannel: (text, tenantId) => sealbox.detokenize(text, tenantId),
    isOptedOut: (tenantId, sender) => optedOut.has(`${tenantId}:${normalizeEmail(sender)}`),
  };
}

module.exports = { createEmailHandler, isSpam };
