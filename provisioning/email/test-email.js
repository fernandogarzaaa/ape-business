// Test-only harness for email-intake.js. No real mailbox, no real
// address, no real send. Every address here is a clearly fake test
// value. Run: node test-email.js
'use strict';

const assert = require('assert');
const { createEmailHandler } = require('./email-intake');

const AGENT = 'maya@teststore.invalid';
const SENDER = 'jane@example.invalid';

function main() {
  const handler = createEmailHandler({
    tenants: { [AGENT]: { id: 'tn_test', agentName: 'Maya', businessName: 'Test Store', sigilPolicy: 'standard' } },
  });

  // 1. Normal email -> one job, first reply identifies as AI agent.
  const r1 = handler.handleInbound({ to: AGENT, from: SENDER, subject: 'Stock question', body: 'Do you have this in stock?', messageId: 'EM_FAKE_001', now: 1000 });
  console.log('1 normal:', JSON.stringify(r1));
  assert.strictEqual(r1.jobId, 'job_1');
  assert.ok(/AI assistant/i.test(r1.replyDraft));
  assert.strictEqual(handler.getJobs().length, 1);

  // 2. Duplicate message id -> same job, no new job.
  const r2 = handler.handleInbound({ to: AGENT, from: SENDER, subject: 'Stock question', body: 'Do you have this in stock?', messageId: 'EM_FAKE_001', now: 2000 });
  assert.strictEqual(r2.jobId, 'job_1');
  assert.strictEqual(handler.getJobs().length, 1);

  // 3. Spam keyword -> no job.
  const r3 = handler.handleInbound({ to: AGENT, from: SENDER, subject: 'You have won', body: 'claim your prize now', messageId: 'EM_FAKE_003', now: 3000 });
  console.log('3 spam:', JSON.stringify(r3));
  assert.strictEqual(r3.reason, 'spam_spam_keyword');
  assert.strictEqual(handler.getJobs().length, 1);

  // 4. Auth fail header -> no job.
  const r4 = handler.handleInbound({ to: AGENT, from: SENDER, subject: 'Hi', body: 'Hi', messageId: 'EM_FAKE_004', now: 4000, headers: { 'authentication-results': 'spf=fail' } });
  assert.strictEqual(r4.reason, 'spam_auth_fail');
  assert.strictEqual(handler.getJobs().length, 1);

  // 5. Unsubscribe -> opted out, no job; next message blocked.
  const r5 = handler.handleInbound({ to: AGENT, from: SENDER, subject: 'Please unsubscribe me', body: 'Stop mailing me', messageId: 'EM_FAKE_005', now: 5000 });
  assert.strictEqual(r5.reason, 'opted_out');
  assert.ok(handler.isOptedOut('tn_test', SENDER));
  const r6 = handler.handleInbound({ to: AGENT, from: SENDER, subject: 'Again', body: 'Hello', messageId: 'EM_FAKE_006', now: 6000 });
  assert.strictEqual(r6.reason, 'blocked_opted_out');
  assert.strictEqual(handler.getJobs().length, 1);

  // 6. START opts back in; next message creates job_2 with Sealbox
  // tokens in the dispatch body, never raw PII.
  const r7 = handler.handleInbound({ to: AGENT, from: SENDER, subject: 'START', body: 'START', messageId: 'EM_FAKE_007', now: 7000 });
  assert.strictEqual(r7.reason, 'opted_in');
  const r8 = handler.handleInbound({ to: AGENT, from: SENDER, subject: 'Order help', body: 'Reach me at jane@example.com or 555-123-4567', messageId: 'EM_FAKE_008', now: 8000 });
  console.log('8 sealbox:', JSON.stringify(r8));
  assert.strictEqual(r8.jobId, 'job_2');
  const job8 = handler.getJobs()[1];
  assert.ok(!job8.bodyForDispatch.includes('jane@example.com'));
  assert.ok(!job8.bodyForDispatch.includes('555-123-4567'));
  assert.ok(job8.bodyForDispatch.includes('<EMAIL_1>'));
  assert.ok(job8.bodyForDispatch.includes('<PHONE_1>'));
  assert.ok(!JSON.stringify(job8.sealbox).includes('jane@example.com'));
  assert.strictEqual(handler.detokenizeForChannel(job8.bodyForDispatch, 'tn_test'), 'Reach me at jane@example.com or 555-123-4567');

  // 7. Unknown agent address -> no job.
  const r9 = handler.handleInbound({ to: 'nobody@teststore.invalid', from: SENDER, subject: 'Hi', body: 'Hi', messageId: 'EM_FAKE_009', now: 9000 });
  assert.strictEqual(r9.reason, 'unknown_tenant');
  assert.strictEqual(handler.getJobs().length, 2);

  // 8. Rate limit: 20/minute per sender, 21 rapid messages.
  const h2 = createEmailHandler({
    rateLimit: 20,
    tenants: { [AGENT]: { id: 'tn_test', agentName: 'Maya', businessName: 'Test Store' } },
  });
  let last = null;
  for (let i = 0; i < 21; i++) {
    last = h2.handleInbound({ to: AGENT, from: SENDER, subject: `msg ${i}`, body: 'hi', messageId: `EM_FAKE_RL_${i}`, now: 10000 });
  }
  assert.strictEqual(last.reason, 'rate_limited');
  assert.strictEqual(h2.getJobs().length, 20);

  console.log('ALL EMAIL TESTS PASSED: 8 checks, jobs=2, spam and opt-out verified, Sealbox tokenization verified');
}

main();
