// Twilio SMS webhook for APE for Business.
//
// REAL integration code, TEST ONLY in this folder. It purchases no
// number, sends no real message, and reads no real credential.
// Secrets are env NAMES only, never values:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (read at runtime, never logged)
// Optional env: SMS_PUBLIC_URL (the exact public URL Twilio calls,
// used for signature verification), SMS_PORT (default 8790).
//
// Trial-number limit, stated plainly: Twilio trial numbers are
// limited to verified recipients until US SMS registration
// (10DLC) completes. Early tests must therefore use verified
// numbers. Do not promise open SMS to anyone until registration
// is complete.
//
// Security mapping (see ../SECURITY.md):
// - Tenant isolation: the To number maps to exactly one tenant.
//   An unknown To number gets no job and no reply content.
// - Sigil gate: intake records a Sigil decision. Tool dispatch
//   inside the APE loop is still gated separately; this handler
//   never dispatches a tool itself.
// - Sealbox content gate (Day 1 integration, wired here):
//   inbound text is data, never instructions. Before a job payload
//   leaves the tenant boundary, provisioning/sealbox.js tokenizes
//   emails and phone numbers into tenant-scoped tokens. The job
//   keeps the raw text in the tenant-local ledger only; the
//   dispatch body is the tokenized text, and the audit log
//   carries no raw PII.
// - Opt-out and rate limits run BEFORE any job is created, so an
//   opted-out or rate-limited sender never costs a job.
// - The agent identifies itself as an AI agent in its first message
//   to each sender, per tenant. It never presents as a human.

'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const querystring = require('querystring');
const { createSealboxGate } = require('../sealbox');

const OPT_OUT_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const OPT_IN_WORDS = new Set(['START', 'YES', 'UNSTOP']);
const DEFAULT_RATE_LIMIT = 10; // messages per sender per window
const DEFAULT_RATE_WINDOW_MS = 60 * 1000;

function normalizePhone(v) {
  return String(v || '').replace(/[\s\-()]/g, '');
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function twiml(message) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' +
    escapeXml(message) + '</Message></Response>';
}

// Twilio request validation, per Twilio docs: sort POST parameters
// by name, append each value to the URL, HMAC-SHA1 with the auth
// token, base64 encode, compare in constant time.
function computeTwilioSignature(url, params, authToken) {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

function verifyTwilioSignature(url, params, signature, authToken) {
  if (!signature || !authToken) return false;
  const expected = computeTwilioSignature(url, params, authToken);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Shape of a Twilio Messages API request. Returns the request
// without sending it, so tests can prove the shape without a real
// send. sendReply() below performs the HTTPS POST with this shape.
function buildTwilioMessageRequest(accountSid, to, from, body) {
  return {
    method: 'POST',
    host: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Authorization is Basic base64(accountSid:authToken), built
      // by the caller from env values at runtime, never stored here.
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:<TWILIO_AUTH_TOKEN_FROM_ENV>`).toString('base64'),
    },
    body: querystring.stringify({ To: to, From: from, Body: body }),
  };
}

function sendReplyViaApi({ accountSid, authToken, to, from, body, transport }) {
  const req = buildTwilioMessageRequest(accountSid, to, from, body);
  req.headers.Authorization = 'Basic ' +
    Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  if (transport) return transport(req);
  return new Promise((resolve, reject) => {
    const r = https.request(
      { method: 'POST', host: req.host, path: req.path, headers: req.headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
    r.on('error', reject);
    r.write(req.body);
    r.end();
  });
}

function createSmsHandler(options) {
  const tenants = options.tenants || {}; // To number -> tenant object
  const authToken = options.authToken || process.env.TWILIO_AUTH_TOKEN || '';
  const accountSid = options.accountSid || process.env.TWILIO_ACCOUNT_SID || '';
  const publicUrl = options.publicUrl || process.env.SMS_PUBLIC_URL || '';
  const rateLimit = options.rateLimit || DEFAULT_RATE_LIMIT;
  const rateWindowMs = options.rateWindowMs || DEFAULT_RATE_WINDOW_MS;
  const sendTransport = options.sendTransport || null; // injected in tests
  // Production passes the SQLite store: dedup, opt-outs, jobs, and
  // Sealbox maps then survive restarts. Tests omit it (in-memory).
  const store = options.store || null;

  const jobs = []; // in-memory ledger fallback (tests only)
  const seenMessageSids = new Map(); // `${tenantId}:${sid}` -> result
  const optedOut = new Set(); // `${tenantId}:${sender}`
  const seenSenders = new Set(); // `${tenantId}:${sender}`
  const senderTimestamps = new Map(); // `${tenantId}:${sender}` -> [epoch ms]
  const sealbox = createSealboxGate(store ? { store } : undefined);

  function dedupGet(tenantId, sid) {
    if (!sid) return null;
    if (store) return store.getDedup(tenantId, 'sms', sid);
    return seenMessageSids.get(`${tenantId}:${sid}`) || null;
  }
  function dedupPut(tenantId, sid, result) {
    if (!sid) return;
    // Transient outcomes are never cached: a rate-limited delivery
    // must be retryable after the window, not frozen forever.
    if (result.reason === 'rate_limited') return;
    if (store) store.putDedup(tenantId, 'sms', sid, result);
    else seenMessageSids.set(`${tenantId}:${sid}`, result);
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

  function firstMessagePrefix(tenant) {
    const intro = tenant.intro ||
      `Hi, I am ${tenant.agentName || 'the agent'}, the AI assistant for ${tenant.businessName || 'this business'}. How can I help?`;
    // Guarantee the AI disclosure even if a custom intro omits it.
    if (/AI assistant/i.test(intro)) return intro;
    return `${intro} I am an AI assistant, not a human employee.`;
  }

  // Tenant-scoped: one tenant's flood must never throttle another
  // tenant's customers (the old sender-only key did exactly that).
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

  // CTIA keyword matching: first word, punctuation-insensitive, so
  // "Stop." and "STOP PLEASE" opt out instead of creating jobs.
  function keywordOf(body) {
    const first = String(body || '').trim().toUpperCase()
      .replace(/[.!?,;]+$/, '').split(/\s+/)[0] || '';
    return first.replace(/[.!?,;]+$/, '');
  }

  // Core handler. params are the parsed Twilio POST fields.
  // Returns { status, twiml, jobId, reason, sentViaApi }.
  // No real send happens here: the reply is TwiML, which Twilio
  // itself delivers. Async follow-ups use sendReplyViaApi().
  async function handleWebhook({ url, params, signature, now }) {
    const ts = now || Date.now();
    const requestUrl = url || publicUrl;
    if (!verifyTwilioSignature(requestUrl, params, signature, authToken)) {
      return { status: 403, twiml: twiml('Signature verification failed.'), jobId: null, reason: 'bad_signature', sentViaApi: false };
    }
    const sid = params.MessageSid || '';
    const to = normalizePhone(params.To);
    const from = normalizePhone(params.From);
    const bodyRaw = String(params.Body || '');
    const body = bodyRaw.trim();
    // Tenant FIRST, dedup second: a global SID cache returned tenant
    // A's result to tenant B and silently ate B's job (probed).
    const tenant = tenants[to] || tenants[params.To] || null;
    if (!tenant) {
      return { status: 404, twiml: twiml('Unknown number.'), jobId: null, reason: 'unknown_tenant', sentViaApi: false };
    }
    const cached = dedupGet(tenant.id, sid);
    if (cached) return cached; // Twilio retry: no second job/reply
    const keyword = keywordOf(body);
    if (OPT_OUT_WORDS.has(keyword)) {
      setOut(tenant.id, from, true);
      const result = { status: 200, twiml: twiml('You are opted out. Text START to opt back in.'), jobId: null, reason: 'opted_out', sentViaApi: false };
      dedupPut(tenant.id, sid, result);
      return result;
    }
    if (OPT_IN_WORDS.has(keyword)) {
      setOut(tenant.id, from, false);
      const result = { status: 200, twiml: twiml('You are opted back in. How can I help?'), jobId: null, reason: 'opted_in', sentViaApi: false };
      dedupPut(tenant.id, sid, result);
      return result;
    }
    if (keyword === 'HELP') {
      const result = { status: 200, twiml: twiml('This is an AI assistant. Text STOP to opt out, START to opt back in.'), jobId: null, reason: 'help', sentViaApi: false };
      dedupPut(tenant.id, sid, result);
      return result;
    }
    if (isOut(tenant.id, from)) {
      const result = { status: 200, twiml: twiml('You are opted out. Text START to opt back in.'), jobId: null, reason: 'blocked_opted_out', sentViaApi: false };
      dedupPut(tenant.id, sid, result);
      return result;
    }
    if (!checkRateLimit(tenant.id, from, ts)) {
      // Not dedup-cached: redelivery after the window must succeed.
      return { status: 200, twiml: twiml('You are sending messages too quickly. Please wait a minute and try again.'), jobId: null, reason: 'rate_limited', sentViaApi: false };
    }
    // Intake record only. This handler dispatches no tool; the Sigil
    // gate runs inside the APE loop before any tool call. The record
    // says exactly that instead of claiming a gate check ran here.
    const sigil = { checked: false, policy: tenant.sigilPolicy || 'standard', decision: 'not_applicable', reason: 'intake_only_no_tool_dispatch' };
    // Monthly quota from the tenant record (provisioning limit,
    // enforced here at job creation, not just stored).
    if (store && tenant.maxJobsPerMonth) {
      const monthStart = new Date(ts);
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      if (store.countJobsSince(tenant.id, monthStart.toISOString()) >= tenant.maxJobsPerMonth) {
        return { status: 200, twiml: twiml('This business has reached its monthly message limit. Please try again next month.'), jobId: null, reason: 'quota_exceeded', sentViaApi: false };
      }
    }
    const sealed = sealbox.tokenize(body, tenant.id);
    const jobId = store
      ? 'job_' + crypto.randomUUID().slice(0, 8)
      : `job_${jobs.length + 1}`;
    const isFirst = store
      ? store.markSenderSeen(tenant.id, from)
      : !seenSenders.has(`${tenant.id}:${from}`);
    if (!store) seenSenders.add(`${tenant.id}:${from}`);
    const job = {
      jobId, tenantId: tenant.id, channel: 'sms', sender: from, to,
      body, bodyForDispatch: sealed.tokenized, sealbox: sealed.audit,
      status: 'unverified', sigil, createdAt: new Date(ts).toISOString(),
    };
    if (store) store.addJob(job); else jobs.push(job);
    const reply = isFirst
      ? `${firstMessagePrefix(tenant)} Thanks for your message. I have logged it and will follow up.`
      : 'Thanks for your message. I have logged it and will follow up.';
    const result = { status: 200, twiml: twiml(reply), jobId, reason: 'job_created', sentViaApi: false };
    dedupPut(tenant.id, sid, result);
    return result;
  }

  return {
    handleWebhook, verifyTwilioSignature, computeTwilioSignature,
    buildTwilioMessageRequest,
    sendReplyViaApi: (args) => sendReplyViaApi({ accountSid, authToken, transport: sendTransport, ...args }),
    // Copies, never live references: a caller mutating a returned
    // job must not rewrite the ledger or another tenant's cache.
    getJobs: () => (store
      ? store.listJobs()
      : jobs.map((j) => JSON.parse(JSON.stringify(j)))),
    getSealboxAuditLog: (tenantId) => sealbox.getAuditLog(tenantId),
    detokenizeForChannel: (text, tenantId) => sealbox.detokenize(text, tenantId),
    isOptedOut: (tenantId, sender) => isOut(tenantId, normalizePhone(sender)),
  };
}

function loadTenantsFromFile(path) {
  if (!path) return {};
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  // File shape: { "<To number>": { id, agentName, businessName, intro, sigilPolicy } }
  return raw;
}

function startServer() {
  const { createStore } = require('../lib/store');
  if (!process.env.SMS_PUBLIC_URL) {
    console.error('WARNING: SMS_PUBLIC_URL unset — signed URL falls back to Host header, which breaks validation behind proxies. Set it before live use.');
  }
  const handler = createSmsHandler({
    tenants: loadTenantsFromFile(process.env.SMS_TENANTS_FILE || ''),
    store: createStore(),
  });
  const port = Number(process.env.SMS_PORT || 8790);
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/sms/webhook') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 65536) req.destroy(); // 64KB cap (was unbounded)
    });
    req.on('end', async () => {
      const params = querystring.parse(raw);
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host || 'localhost';
      const url = process.env.SMS_PUBLIC_URL || `${proto}://${host}/sms/webhook`;
      const result = await handler.handleWebhook({
        url, params, signature: req.headers['x-twilio-signature'] || '',
      });
      res.writeHead(result.status, { 'Content-Type': 'text/xml' });
      res.end(result.twiml);
    });
  });
  server.listen(port, () => {
    console.log(`SMS webhook listening on port ${port}, path /sms/webhook (no real send until TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set in env)`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  createSmsHandler, verifyTwilioSignature, computeTwilioSignature,
  buildTwilioMessageRequest, sendReplyViaApi, twiml, startServer,
};
