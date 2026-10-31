# SMS integration for APE for Business (test only)

## What this is

Node, no dependencies. A Twilio webhook handler that turns an
inbound text into one APE job, per tenant, with a budget, a Sigil
intake record, and a ledger receipt.

Files:
- `twilio-webhook.js`: handler + optional HTTP server.
- `test-sms.js`: local test harness, fake credentials and fictional
  numbers only.
- `tenants.example.json`: tenant file shape, fictional numbers only.

## Run the test

```sh
node test-sms.js
```

Expected final line: `ALL SMS TESTS PASSED: 10 checks, jobs=2,
duplicates blocked, STOP/START verified`. Exit code 0.

## Run the server (local, no real send)

```sh
SMS_PORT=8790 SMS_TENANTS_FILE=./tenants.json node twilio-webhook.js
```

Webhook path: `POST /sms/webhook`, form-encoded Twilio fields.
Set `SMS_PUBLIC_URL` to the exact public URL Twilio calls, or the
server reconstructs it from host headers. Signature verification
fails closed without a matching `X-Twilio-Signature`.

Secrets, env names only, never values in code or files:
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.

## Behaviour, in order

1. Verify `X-Twilio-Signature` (HMAC-SHA1, sorted params, base64).
   Tampered or unsigned requests get 403 and no job.
2. Duplicate `MessageSid` returns the cached result. No second job,
   no second reply.
3. Map `To` to exactly one tenant. Unknown numbers get no job.
4. Opt-out words (`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`,
   `END`, `QUIT`) opt a sender out, no job. `START` / `YES` /
   `UNSTOP` opt back in. `HELP` returns help text, no job.
   Opted-out senders are blocked before any job is created.
5. Rate limit: 10 messages per sender per 60 seconds by default.
   Over-limit senders get a slow-down reply, no job.
6. Create one job: `{ jobId, tenantId, channel: "sms", sender,
   to, body, status: "unverified", sigil }`. The Sigil record here
   is an intake record only. Tool dispatch inside the APE loop is
   still gated separately.
7. Reply synchronously via TwiML. The agent identifies itself as an
   AI agent in its first message to each sender per tenant, using
   the tenant intro when provided. Async follow-ups use the Twilio
   Messages API shape (`POST /2010-04-01/Accounts/{SID}/
   Messages.json`, Basic auth from env at runtime) via
   `sendReplyViaApi()`; the test proves that shape without sending.

## Trial-number limit (read before demoing)

Twilio trial numbers are limited to verified recipients until US SMS
registration (10DLC) completes. Early tests must use verified
numbers. Do not promise open SMS to anyone until registration is
complete. This limit is also stated in code comments.

## What is real versus what still needs Inan

Real and tested here: signature verification, tenant mapping,
opt-out/in, rate limiting, duplicate idempotency, first-message AI
disclosure, job ledger shape, and the Messages API request shape.

Still needs Inan, and was NOT done here: a Twilio account, a number
purchase (with his explicit cost approval), US SMS registration,
`SMS_PUBLIC_URL` wiring behind Caddy/TLS, and a live end-to-end
test to a verified number. No number was purchased, no real message
was sent, no real key was used, nothing was published or contacted
outside this machine.

## Open risks

- In-memory state: jobs, opt-outs, rate limits, and MessageSid
  dedup do not survive a restart. Production needs a per-tenant
  persistent store (same vault/ledger as the tenant, not a shared file).
- Sealbox content gate is not yet wired into this handler. Inbound
  text is treated as data, never instructions, but raw text must not
  be forwarded to a third party or a shared log until the
  tokenization pass lands (see ../SECURITY.md section 4).
- First-message disclosure depends on in-memory sender tracking;
  after a restart a returning sender would get the intro again.
  That is safe (disclosure repeats) but noisy.
- Twilio signature verification requires the exact public URL.
  A proxy that rewrites host or path will break verification until
  `SMS_PUBLIC_URL` is set to the Twilio-facing URL.
