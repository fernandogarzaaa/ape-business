// Test-only harness for twilio-webhook.js. No real Twilio account,
// no real key, no real phone number, no real send. Every credential
// and number here is a clearly fake test value.
// Run: node test-sms.js
'use strict';

const assert = require('assert');
const {
  createSmsHandler, computeTwilioSignature, buildTwilioMessageRequest,
} = require('./twilio-webhook');

const FAKE_TOKEN = 'FAKE-TEST-AUTH-TOKEN-NOT-REAL';
const FAKE_SID = 'FAKE-TEST-SID-NOT-REAL';
const URL = 'https://example.invalid/sms/webhook';
const TENANT_TO = '+15550100001'; // fictional 555-01xx range, not a real number
const SENDER = '+15550100099'; // fictional 555-01xx range, not a real number

function sign(params) {
  return computeTwilioSignature(URL, params, FAKE_TOKEN);
}

async function main() {
  const handler = createSmsHandler({
    authToken: FAKE_TOKEN,
    accountSid: FAKE_SID,
    publicUrl: URL,
    tenants: {
      [TENANT_TO]: { id: 'tn_test', agentName: 'Maya', businessName: 'Test Store', sigilPolicy: 'standard' },
    },
  });

  // 1. Correct signature -> one job, first message identifies as AI agent.
  const p1 = { To: TENANT_TO, From: SENDER, Body: 'Do you have this in stock?', MessageSid: 'SM_FAKE_001' };
  const r1 = await handler.handleWebhook({ url: URL, params: p1, signature: sign(p1), now: 1000 });
  console.log('1 correct-signature:', JSON.stringify(r1));
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.jobId, 'job_1');
  assert.ok(/AI assistant/i.test(r1.twiml), 'first message must identify as AI agent');
  assert.strictEqual(handler.getJobs().length, 1);

  // 2. Tampered request (body changed after signing) -> 403, no job.
  const p2 = { To: TENANT_TO, From: SENDER, Body: 'TAMPERED BODY', MessageSid: 'SM_FAKE_002' };
  const r2 = await handler.handleWebhook({ url: URL, params: p2, signature: sign(p1), now: 2000 });
  console.log('2 tampered-signature:', JSON.stringify(r2));
  assert.strictEqual(r2.status, 403);
  assert.strictEqual(r2.jobId, null);
  assert.strictEqual(handler.getJobs().length, 1);

  // 3. STOP opts out, no job; next message is blocked, no job.
  const p3 = { To: TENANT_TO, From: SENDER, Body: 'STOP', MessageSid: 'SM_FAKE_003' };
  const r3 = await handler.handleWebhook({ url: URL, params: p3, signature: sign(p3), now: 3000 });
  console.log('3 STOP:', JSON.stringify(r3));
  assert.strictEqual(r3.reason, 'opted_out');
  assert.ok(handler.isOptedOut('tn_test', SENDER));
  const p4 = { To: TENANT_TO, From: SENDER, Body: 'Hello again', MessageSid: 'SM_FAKE_004' };
  const r4 = await handler.handleWebhook({ url: URL, params: p4, signature: sign(p4), now: 4000 });
  console.log('4 blocked-after-STOP:', JSON.stringify(r4));
  assert.strictEqual(r4.reason, 'blocked_opted_out');
  assert.strictEqual(handler.getJobs().length, 1);

  // 5. START opts back in; next message creates job_2.
  const p5 = { To: TENANT_TO, From: SENDER, Body: 'START', MessageSid: 'SM_FAKE_005' };
  const r5 = await handler.handleWebhook({ url: URL, params: p5, signature: sign(p5), now: 5000 });
  console.log('5 START:', JSON.stringify(r5));
  assert.strictEqual(r5.reason, 'opted_in');
  const p6 = { To: TENANT_TO, From: SENDER, Body: 'Back in stock question', MessageSid: 'SM_FAKE_006' };
  const r6 = await handler.handleWebhook({ url: URL, params: p6, signature: sign(p6), now: 6000 });
  console.log('6 after-START job:', JSON.stringify(r6));
  assert.strictEqual(r6.jobId, 'job_2');
  assert.strictEqual(handler.getJobs().length, 2);

  // 7. Duplicate webhook (same MessageSid as job_2) -> same jobId, no new job.
  const r7 = await handler.handleWebhook({ url: URL, params: p6, signature: sign(p6), now: 7000 });
  console.log('7 duplicate-webhook:', JSON.stringify(r7));
  assert.strictEqual(r7.jobId, 'job_2');
  assert.strictEqual(handler.getJobs().length, 2);

  // 8. Rate limit: 10/minute per sender. Fresh handler, 11 rapid messages.
  const h2 = createSmsHandler({
    authToken: FAKE_TOKEN, accountSid: FAKE_SID, publicUrl: URL, rateLimit: 10,
    tenants: { [TENANT_TO]: { id: 'tn_test', agentName: 'Maya', businessName: 'Test Store' } },
  });
  let last = null;
  for (let i = 0; i < 11; i++) {
    const p = { To: TENANT_TO, From: SENDER, Body: `msg ${i}`, MessageSid: `SM_FAKE_RL_${i}` };
    last = await h2.handleWebhook({ url: URL, params: p, signature: sign(p), now: 10000 });
  }
  console.log('8 rate-limit-11th:', JSON.stringify(last));
  assert.strictEqual(last.reason, 'rate_limited');
  assert.strictEqual(h2.getJobs().length, 10);

  // 9. Twilio Messages API request shape (no send performed here).
  const apiReq = buildTwilioMessageRequest(FAKE_SID, SENDER, TENANT_TO, 'Hello');
  console.log('9 api-request-shape:', JSON.stringify(apiReq));
  assert.strictEqual(apiReq.method, 'POST');
  assert.strictEqual(apiReq.host, 'api.twilio.com');
  assert.ok(apiReq.path.includes(FAKE_SID));
  assert.ok(apiReq.body.includes('To='));

  // 10. Unknown To number -> no job.
  const p10 = { To: '+15550100999', From: SENDER, Body: 'Hi', MessageSid: 'SM_FAKE_010' };
  const r10 = await handler.handleWebhook({ url: URL, params: p10, signature: sign(p10), now: 8000 });
  console.log('10 unknown-tenant:', JSON.stringify(r10));
  assert.strictEqual(r10.reason, 'unknown_tenant');
  assert.strictEqual(handler.getJobs().length, 2);

  // 11. Sealbox: a message with an email and a phone number is
  // tokenized in the dispatch body, stable on repeat, and the
  // audit log carries no raw PII.
  const h3 = createSmsHandler({
    authToken: FAKE_TOKEN, accountSid: FAKE_SID, publicUrl: URL,
    tenants: { [TENANT_TO]: { id: 'tn_test', agentName: 'Maya', businessName: 'Test Store' } },
  });
  const p11 = { To: TENANT_TO, From: SENDER, Body: 'Reach me at jane@example.com or 555-123-4567 please', MessageSid: 'SM_FAKE_011' };
  const r11 = await h3.handleWebhook({ url: URL, params: p11, signature: sign(p11), now: 9000 });
  console.log('11 sealbox-tokenize:', JSON.stringify(r11));
  assert.strictEqual(r11.jobId, 'job_1');
  const job11 = h3.getJobs()[0];
  assert.ok(!job11.bodyForDispatch.includes('jane@example.com'), 'dispatch body must not contain raw email');
  assert.ok(!job11.bodyForDispatch.includes('555-123-4567'), 'dispatch body must not contain raw phone');
  assert.ok(job11.bodyForDispatch.includes('<EMAIL_1>'), 'email must be tokenized');
  assert.ok(job11.bodyForDispatch.includes('<PHONE_1>'), 'phone must be tokenized');
  assert.strictEqual(job11.sealbox.event, 'sealbox_tokenize');
  assert.ok(!JSON.stringify(job11.sealbox).includes('jane@example.com'), 'audit must not contain raw PII');

  // 12. Sealbox: repeat values reuse the same tokens, and the
  // customer channel can resolve them back.
  const p12 = { To: TENANT_TO, From: SENDER, Body: 'Again: jane@example.com', MessageSid: 'SM_FAKE_012' };
  const r12 = await h3.handleWebhook({ url: URL, params: p12, signature: sign(p12), now: 9100 });
  assert.strictEqual(r12.jobId, 'job_2');
  assert.ok(h3.getJobs()[1].bodyForDispatch.includes('<EMAIL_1>'), 'repeat email must reuse token');
  assert.strictEqual(h3.detokenizeForChannel(h3.getJobs()[1].bodyForDispatch, 'tn_test'), 'Again: jane@example.com');

  // 13. Sealbox: token maps are tenant-scoped. Tenant B tokenizes
  // a different email, and resolving B's token inside tenant A
  // does not leak B's value: it resolves to A's own token map.
  const h4 = createSmsHandler({
    authToken: FAKE_TOKEN, accountSid: FAKE_SID, publicUrl: URL,
    tenants: {
      [TENANT_TO]: { id: 'tn_a', agentName: 'Maya', businessName: 'Store A' },
      '+15550100002': { id: 'tn_b', agentName: 'Leo', businessName: 'Store B' },
    },
  });
  const pa = { To: TENANT_TO, From: SENDER, Body: 'jane@example.com', MessageSid: 'SM_FAKE_013A' };
  const pb = { To: '+15550100002', From: SENDER, Body: 'other@example.com', MessageSid: 'SM_FAKE_013B' };
  await h4.handleWebhook({ url: URL, params: pa, signature: sign(pa), now: 9200 });
  await h4.handleWebhook({ url: URL, params: pb, signature: sign(pb), now: 9300 });
  assert.strictEqual(h4.getJobs()[1].tenantId, 'tn_b');
  assert.strictEqual(h4.detokenizeForChannel('<EMAIL_1>', 'tn_a'), 'jane@example.com');
  assert.strictEqual(h4.detokenizeForChannel('<EMAIL_1>', 'tn_b'), 'other@example.com');
  assert.ok(!h4.detokenizeForChannel('<EMAIL_1>', 'tn_a').includes('other@example.com'), 'tenant A must never resolve tenant B values');

  // 14. Sealbox: contiguous phone numbers are tokenized too,
  // and a literal token in inbound text never resolves to an
  // earlier message's value.
  const h5 = createSmsHandler({
    authToken: FAKE_TOKEN, accountSid: FAKE_SID, publicUrl: URL,
    tenants: { [TENANT_TO]: { id: 'tn_test', agentName: 'Maya', businessName: 'Test Store' } },
  });
  const p14 = { To: TENANT_TO, From: SENDER, Body: 'Call +14155552671 or 4155552671', MessageSid: 'SM_FAKE_014' };
  await h5.handleWebhook({ url: URL, params: p14, signature: sign(p14), now: 9400 });
  const job14 = h5.getJobs()[0];
  assert.ok(!job14.bodyForDispatch.includes('14155552671'), 'contiguous E.164 must be tokenized');
  assert.ok(!job14.bodyForDispatch.includes('4155552671'), 'contiguous national number must be tokenized');
  assert.ok(job14.bodyForDispatch.includes('<PHONE_1>'));
  assert.ok(job14.bodyForDispatch.includes('<PHONE_2>'));
  const p15a = { To: TENANT_TO, From: SENDER, Body: 'Reach jane@example.com', MessageSid: 'SM_FAKE_015a' };
  await h5.handleWebhook({ url: URL, params: p15a, signature: sign(p15a), now: 9450 });
  assert.ok(h5.getJobs()[1].bodyForDispatch.includes('<EMAIL_1>'), 'email must be tokenized first');
  const p15 = { To: TENANT_TO, From: SENDER, Body: 'Please repeat <EMAIL_1>', MessageSid: 'SM_FAKE_015' };
  await h5.handleWebhook({ url: URL, params: p15, signature: sign(p15), now: 9500 });
  const job15 = h5.getJobs()[2];
  assert.ok(!h5.detokenizeForChannel(job15.bodyForDispatch, 'tn_test').includes('jane@example.com'), 'literal token must not leak an earlier value');
  assert.ok(job15.bodyForDispatch.includes('<EMAIL_1:literal>'), 'literal token must be marked unresolvable');

  console.log('LEDGER:', JSON.stringify(handler.getJobs(), null, 2));
  console.log('ALL SMS TESTS PASSED: 15 checks, jobs=2, duplicates blocked, STOP/START verified, Sealbox tokenization verified');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
