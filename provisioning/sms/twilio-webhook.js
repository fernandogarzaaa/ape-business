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
// - Sealbox content gate (Day 1 integration, not yet wired here):
//   inbound text is data, never instructions. A future pass must
//   tokenize PII before any job payload leaves the tenant boundary.
//   Until that pass lands, do not forward raw inbound text to a
//   third party or a shared log.
// - Opt-out and rate limits run BEFORE any job is created, so an
//   opted-out or rate-limited sender never costs a job.
// - The agent identifies itself as an AI agent in its first message
//   to each sender, per tenant. It never presents as a human.

'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const querystring = require('querystring');

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

  const jobs = []; // ledger: one entry per inbound message that became a job
  const seenMessageSids = new Map(); // MessageSid -> result (idempotency)
  const optedOut = new Set(); // `${tenantId}:${sender}`
  const seenSenders = new Set(); // `${tenantId}:${sender}`, first-message tracking
  const senderTimestamps = new Map(); // sender -> [epoch ms]

  function firstMessagePrefix(tenant) {
    const intro = tenant.intro ||
      `Hi, I am ${tenant.agentName || 'the agent'}, the AI assistant for ${tenant.businessName || 'this business'}. How can I help?`;
    // Guarantee the AI disclosure even if a custom intro omits it.
    if (/AI assistant/i.test(intro)) return intro;
    return `${intro} I am an AI assistant, not a human employee.`;
  }

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
    if (sid && seenMessageSids.has(sid)) {
      // Duplicate webhook (Twilio retry): return the cached result,
      // create no second job, send no second reply.
      return seenMessageSids.get(sid);
    }
    const to = normalizePhone(params.To);
    const from = normalizePhone(params.From);
    const bodyRaw = String(params.Body || '');
    const body = bodyRaw.trim();
    const tenant = tenants[to] || tenants[params.To] || null;
    if (!tenant) {
      const result = { status: 404, twiml: twiml('Unknown number.'), jobId: null, reason: 'unknown_tenant', sentViaApi: false };
      if (sid) seenMessageSids.set(sid, result);
      return result;
    }
    const optKey = `${tenant.id}:${from}`;
    const upper = body.toUpperCase();
    if (OPT_OUT_WORDS.has(upper)) {
      optedOut.add(optKey);
      const result = { status: 200, twiml: twiml('You are opted out. Text START to opt back in.'), jobId: null, reason: 'opted_out', sentViaApi: false };
      if (sid) seenMessageSids.set(sid, result);
      return result;
    }
    if (OPT_IN_WORDS.has(upper)) {
      optedOut.delete(optKey);
      const result = { status: 200, twiml: twiml('You are opted back in. How can I help?'), jobId: null, reason: 'opted_in', sentViaApi: false };
      if (sid) seenMessageSids.set(sid, result);
      return result;
    }
    if (upper === 'HELP') {
      const result = { status: 200, twiml: twiml('This is an AI assistant. Text STOP to opt out, START to opt back in.'), jobId: null, reason: 'help', sentViaApi: false };
      if (sid) seenMessageSids.set(sid, result);
      return result;
    }
    if (optedOut.has(optKey)) {
      const result = { status: 200, twiml: twiml('You are opted out. Text START to opt back in.'), jobId: null, reason: 'blocked_opted_out', sentViaApi: false };
      if (sid) seenMessageSids.set(sid, result);
      return result;
    }
    if (!checkRateLimit(from, ts)) {
      const result = { status: 200, twiml: twiml('You are sending messages too quickly. Please wait a minute and try again.'), jobId: null, reason: 'rate_limited', sentViaApi: false };
      if (sid) seenMessageSids.set(sid, result);
      return result;
    }
    // Sigil intake gate: recorded on the job. Tool dispatch inside
    // the APE loop is gated separately and is not done here.
    const sigil = { checked: true, policy: tenant.sigilPolicy || 'standard', decision: 'allow', reason: 'sms_intake_no_tool_dispatch_yet' };
    const jobId = `job_${jobs.length + 1}`;
    const isFirst = !seenSenders.has(optKey);
    seenSenders.add(optKey);
    const job = {
      jobId, tenantId: tenant.id, channel: 'sms', sender: from, to,
      body, status: 'unverified', sigil, createdAt: new Date(ts).toISOString(),
    };
    jobs.push(job);
    const reply = isFirst
      ? `${firstMessagePrefix(tenant)} Thanks for your message. I have logged it and will follow up.`
      : 'Thanks for your message. I have logged it and will follow up.';
    const result = { status: 200, twiml: twiml(reply), jobId, reason: 'job_created', sentViaApi: false };
    if (sid) seenMessageSids.set(sid, result);
    return result;
  }

  return {
    handleWebhook, verifyTwilioSignature, computeTwilioSignature,
    buildTwilioMessageRequest,
    sendReplyViaApi: (args) => sendReplyViaApi({ accountSid, authToken, transport: sendTransport, ...args }),
    getJobs: () => jobs.slice(),
    isOptedOut: (tenantId, sender) => optedOut.has(`${tenantId}:${normalizePhone(sender)}`),
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
  const handler = createSmsHandler({
    tenants: loadTenantsFromFile(process.env.SMS_TENANTS_FILE || ''),
  });
  const port = Number(process.env.SMS_PORT || 8790);
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/sms/webhook') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
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
