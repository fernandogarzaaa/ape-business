# APE for Business: brainstorm decisions so far (2026-10-31)

Product: one agent is the product. A business adopts its own APE, for a
new or existing business. End clients talk agent to agent. No website is
the product itself.

Surfaces:
- github.io is the front door and onboarding control panel (static).
  Root fernandogarzaaa.github.io is currently a GitHub Pages 404, not
  live. Sigil index already uses the project page pattern, so the APE
  site should start as fernandogarzaaa.github.io/ape-mcp.
- EC2 is the brain: provisioning backend API plus one APE per tenant,
  behind Caddy for TLS, APE on loopback 8787, bearer auth mandatory.
  GitHub Pages cannot run a backend, so the site calls the EC2 API.

Onboarding:
- Business first: name, new or existing, industry, job.
- Connectors second, system of record first (Shopify, Salesforce,
  database), messages second (Gmail, Calendar), team knowledge third
  (Slack, Sheets, GitHub).
- Read-only discovery first, owner verifies the business profile, then
  jobs act on it. Owner corrections become memory.
- Sigil gate on every tool call: allow low and medium under the
  standard policy, block high, critical, unknown, bad signature, revoked.
- A badge proves identity, version, and risk level. It does not prove
  competence.

Connectors:
- Only web search ships in APE today. Shopify, Salesforce, Gmail,
  database, Calendar, Slack, Sheets, GitHub, and custom API are catalog
  templates in the prototype, not shipped connectors yet.
- Auth: OAuth where offered (Gmail, Shopify, Salesforce). Env
  referenced tokens elsewhere. Never a secret in a profile file, never
  a shared key across businesses.

Pricing: cost-plus, per business, per month.
- monthly price = $19 base fee + usage cost * 1.40 (40 percent margin)
- Usage cost = infra share + model tokens + $2 admin.
- Calculator examples, 10 tenants per instance, 10 steps per job:
  100 jobs $40.28, 1,000 jobs $181.40, 5,000 jobs $808.60.
- Rates are editable estimates. Verify EC2, storage, transfer, and
  model rates on AWS and Meta Billing pages before publishing.
- No flat unlimited tier. Model cost grows with every job.

Deployment pipeline (approved 2026-10-31):
- Pay (Stripe Checkout) -> webhook verifies payment -> tenant created
  -> IAM role created -> APE deployed -> health check -> ready.
- Target under 5 minutes, using a prebuilt APE image, not install
  from scratch per tenant.
- IAM: one role per tenant, scoped to its own S3 prefix, secret, and
  log group. No human IAM user per business. API access is a separate
  APE bearer token, returned once.
- Idempotency key is the payment intent id. Duplicate webhooks must
  never duplicate a tenant, role, or charge.
- Provisioning starts only on a verified webhook, never on a client
  side callback. Failure after payment stops, does not mark ready,
  and surfaces a refund or retry choice.

Prototypes built (local, not live, not published):
- ~/workspace/ape-mcp-site/index.html: interactive onboarding wizard.
- ~/workspace/ape-provisioning/server.js: tenant, connect, provision,
  discover, pricing calculator. Tested.
- ~/workspace/ape-provisioning/pipeline.js: checkout, webhook, deploy,
  deployment status. Tested, including duplicate webhook idempotency.
- ~/workspace/ape-provisioning/PRICING.md
- ~/workspace/ape-provisioning/DEPLOYMENT_PIPELINE.md

Still mock, not real:
- OAuth is a mock start, not a provider redirect.
- Tokens in the prototype are plain tenant files, not encrypted.
- Discovery is simulated, not a real Shopify, Gmail, or Salesforce read.
- No real AWS spend, no real IAM role, no Stripe key used.
- Nothing published to GitHub Pages, nothing pushed to ape-mcp repo.

Next brainstorm areas, not yet decided:
- First customers and go-to-market: which niche first, how to get the
  first 10 tenants, referral loop.
- Trust as a moat: Sigil badge marketplace, verified agent directory.
- Multi-agent marketplace and agent to agent discovery at scale.
- Operations: monitoring, incidents, human fallback, SLA, support.
- Legal and data: tenant data isolation, OAuth terms, liability for
  agent actions, PH data rules.
- Roadmap sequencing: prototype to beta to launch, and how the Meta
  hackathon trust-gated demo becomes the onboarding demo.

## Go-to-market decision (2026-10-31, Inan: "can we do all 3?")

Yes, all three beachheads, but as sequenced beta cohorts, not as three
simultaneous launches.

Shared core once: onboarding, pricing, pipeline, IAM, Sigil gate.
Niche layer per beachhead only: connector set, demo tenant, onboarding
copy, and one measurable job.

- Shopify small stores first: store Q and A from real products and
  orders, plus order triage. Cleanest data, standard OAuth, easiest
  to judge in one day.
- Solo consultants and agencies second: easiest to reach through
  Inan's own network and Upwork pipeline, and they double as
  referrers. Hardest to impress, so they are design partners, not
  the first paid proof.
- Home services contractors third: job triage, checklists, end of day
  reports, decision memory. Most painful, messiest data, distribution
  through networks and platforms. Strong second paid beachhead once
  the first two loops are proven.

Beta cap: 10 to 12 tenants total across all three niches, not 10 per
niche. Free for 30 days, capped jobs, in exchange for weekly feedback
and permission to publish an anonymised receipt and case study.
After beta, decide the paid launch focus by comparing, per niche:
retention at day 30, jobs per tenant per week, discovery approval
rate, referrals per tenant, and cost per tenant versus price.
Losing niches stay supported, they just stop being the marketing focus.

## Agent identity (2026-10-31, Inan: copy the YC agent-with-identity idea)

Pattern copied, not a specific company claim: give each tenant agent
its own identity, so customers reach it through channels they already
use, instead of learning a new app or an MCP client.

Onboarding, new Step 5 in ~/workspace/ape-mcp-site/index.html:
- Owner names the agent (what customers call it).
- Owner fills out, or the wizard suggests, an agent email address.
- Owner fills out, or the real service provisions, an agent phone
  number. That number belongs to the agent, not to the owner's
  personal phone, so it can be kept, changed, or disconnected.
- Channels: text (SMS), email, and agent to agent via the agent card
  and MCP endpoint, all selectable.
- First message rule: the agent identifies itself as an AI agent,
  every time. It never presents as a human employee.

How it works in the real version, not yet built:
- Every inbound text or email becomes one APE job: budget cap,
  Sigil gate on every tool call, receipt in the ledger.
- Text needs an SMS gateway number rental per tenant. Email needs
  inbound email handling for a dedicated agent inbox.
- Both add per-tenant cost that is NOT yet in the pricing calculator.
  Update PRICING.md before selling text or email access, and check
  SMS registration rules for the markets sold into.
- Identity in the agent card is now three things together: name,
  contact endpoints (phone and email), and Sigil badge. That triple
  is what another agent, or a customer, verifies before trusting it.
- The wizard in the prototype only types placeholders. It provisions
  no real number and no real inbox. That limit is stated on the page.

## Channel decision (2026-10-31, Inan: both channels from beta day one)

SMS and email both ship in beta, not one then the other.

What that means in practice:
- One unified job model, not two products. A text and an email both
  become one APE job, with the same budget cap, the same Sigil gate,
  and the same ledger receipt. The channel is a field on the job,
  not a separate agent.
- One identity per tenant across both channels. Same agent name,
  same number, same inbox, same first message identifying as an
  AI agent.
- Beta test matrix doubles. Every beta tenant needs a text test and
  an email test before it counts as ready. A tenant that only works
  on one channel is not beta ready.
- Cost and abuse surface doubles too: number rental plus messages,
  plus inbound email handling, plus spam and opt-out handling on
  both. Beta cap of 10 to 12 tenants total is what keeps that
  manageable. Do not raise the beta cap to pay for both channels.

## Launch roadmap (brainstorm draft, 2026-10-31, not yet approved)

Phases are relative, not calendar locked, except Phase 0 which ends
at the Meta submission deadline Nov 5, 2026, 10:00 AM Manila.
Each phase has an exit gate. Do not start the next phase until the
gate is met. Do not add features during beta to chase a single tenant.

Phase 0: Prove trust (now to Nov 5).
- Finish the Meta hackathon trust-gated APE demo: Sigil gate in the
  loop, allow and block cases, 3-minute video, submission text from
  verified claims only.
- Exit gate: demo runs, tests pass, submission sent only on Inan's
  explicit go-ahead, public repo decision made.
- This phase is a marketing asset, not a product launch. Do not sell
  from the demo.

Phase 1: Prototype to real onboarding (about 2 to 3 weeks after demo).
- Real OAuth for Shopify first, then Gmail. Encrypted per-tenant
  vault, replacing plain prototype files.
- Prebuilt APE image, so pay to ready is under 5 minutes, not an
  install from scratch.
- github.io wired to the EC2 provisioning API, instead of generating
  files in the browser.
- Real Stripe test mode with webhook signature verification.
- SMS gateway test number and inbound email test inbox, both channels
  wired to one job model.
- Exit gate: one demo tenant goes pay (test mode) to ready in under
  5 minutes, passes a text test and an email test, and shows a
  receipt in the ledger. If that tenant cannot do both channels,
  Phase 1 is not done.

Phase 2: Private beta (about 4 weeks, 10 to 12 tenants total).
- Cohorts in order: Shopify small stores, then solo consultants and
  agencies, then home services contractors.
- Free for 30 days, capped jobs, weekly feedback call, permission to
  publish an anonymised receipt and case study.
- Track per niche: retention at day 30, jobs per tenant per week,
  discovery approval rate, referrals per tenant, cost per tenant
  versus price.
- Exit gate: at least one niche clears retention and cost. If none
  does, fix the product, do not raise the beta cap and do not launch.

Phase 3: Beta to paid conversion (decision gate, not a launch date).
- Verify AWS and model rates, lock pricing, and confirm the paid
  focus niche from Phase 2 numbers.
- Convert beta tenants at calculator price. No unlimited tier, no
  lifetime deal.
- Publish the support runbook, stop button, ledger export, and
  disconnect and deletion policy before taking real money.
- Exit gate: Inan approves real Stripe, real AWS spend, and the
  published price. All three are his explicit calls.

Phase 4: Public launch.
- github.io live as fernandogarzaaa.github.io/ape-mcp, public demo
  tenant anyone's agent can query, demo video, build in public posts,
  and directory listings.
- Distribution is the referral loop: signed receipts and agent cards
  passed agent to agent, seeded by content and directories, not ads.
- Exit gate: paid tenants outside the beta network, and cost per
  tenant below price for a full month.

Phase 5: Scale, later, explicitly not Phase 1.
- Sigil verification as a service to other agent platforms.
- Verified agent directory and trust-scored marketplace.
- Multi-region, dedicated instances, and enterprise review.
- Any of these before Phase 4 is scope creep. Name it and park it.

## Security decision (2026-10-31, Inan: Sealbox layer on day 1,
integration not a full build)

Correction recorded: Sealbox moves from later phase to Day 1
integration in Phase 1. Reason: the design already exists, and APE
already has the enforcement hooks (ledger, egress allowlist, confirm
gate, budgets, Sigil gate). Day 1 work is wiring the redaction and
tokenization pass between connector read and dispatch, plus the
resolve step at presentation, plus the transmission audit log.
No new recorder, no new runtime, no new agent.
Full design: ~/workspace/ape-provisioning/SECURITY.md.
Site section added to ~/workspace/ape-mcp-site/index.html, with the
honest limit that the gate is not live in the prototype yet.

## Meta submission scope change (2026-10-31, Inan: full product)

Correction to the earlier demo-only framing: Inan wants a full
product submitted to the Meta hackathon, not a demo loop alone.

Full product, hackathon sense, defined here so it stays verifiable:
a coherent product a judge can follow end to end in the video, not
a production multi-tenant SaaS with paying customers. That distinction
matters for what we claim in submission text.

Proposed full v1 for Nov 5, 10:00 AM Manila:
- Onboarding flow that makes an agent: business, connectors,
  budget, deployment, and agent identity (name, email, phone).
- Agent identity channels: text and email contact for the agent,
  plus agent to agent via its agent card.
- Trust gate on every tool call: Sigil badge, signature, revocation,
  allow low and medium, block high, critical, unknown, bad signature,
  revoked, subject to Inan's gate confirmation.
- One demo business, one agent, one trust-gated job, one ledger
  receipt, and one Wonder call inside the agent loop.
- Provisioning pipeline: pay to ready flow, tenant isolation, IAM
  role per tenant, endpoint and bearer token.

Explicitly cut from v1, or labelled prototype, not claimed as live:
- Real Stripe charges, real SMS number rental, real inbound email
  mailbox, and real multi-tenant EC2 scaling. Those are Phase 1
  after the hackathon, unless Inan explicitly funds and approves
  them before Nov 5 and they are tested end to end.
- Salesforce, home services, and consultant beachheads as live
  connectors. Shopify is the first live connector candidate, others
  remain catalog templates in v1.

Submission assets still required: public GitHub repo, 3-minute demo
video link, project description, and the Meta product fields.
Nothing is submitted without Inan's explicit go-ahead, and submission
text may only claim what the v1 build actually does and passes.

## Meta scope decision (2026-10-31, Inan: push for real Stripe,
EC2, and SMS too)

Full product v1 now includes real integrations, not just test mode
and prototypes, subject to the gates below.

Real means, in order:
- Stripe: real account, test mode first, live only after a test
  payment to ready passes end to end. Webhook signature verified,
  never a client side callback.
- EC2: real deploy, one tenant APE behind Caddy, prebuilt image so
  pay to ready stays under 5 minutes. Deploy role scoped, named IAM
  identity, never root. Existing APE deploy/aws/user-data.sh is
  install from scratch and is too slow and variable for a paid
  pipeline, so a prebuilt image is required.
- SMS: real SMS gateway number, real inbound text to APE job, real
  outbound reply. Trial numbers are limited to verified recipients
  until registration completes, so early SMS tests must use verified
  numbers and must be labelled as such in the demo.

Known bottleneck, stated before building: US SMS registration
(10DLC) can take days and may not complete by Nov 5. That does not
kill real SMS, it limits who can receive it in the demo window.

Spending and account gates, all still apply:
- No real charge, no real AWS resource, no real number purchase
  until Inan provides the account and approves the cost in this
  chat. A tap on a brainstorm option is a direction, not a blank
  spend approval for a specific charge.
- Keys go through Secure Vault, never chat, never files, never
  memory.

## Build decision (2026-10-31, Inan: start with all 3)

Real integrations for Stripe, EC2, and SMS, built in parallel.
Working product first, mocks only for showcasing.

Rule that governs the whole build:
- Real code paths must exist and be testable, so that if the entry
  wins, the team can prove the product works on demand.
- Mocks are a showcasing layer only: demo video, onboarding
  simulation, and any flow blocked by an external registration
  (for example US SMS 10DLC). A mock must never be presented as
  a real charge, a real deploy, or a real message.
- No real charge, no real AWS resource, and no real number purchase
  until Inan approves that exact spend in chat. Test mode and
  dry-run code are the default until then.
- No key, token, or secret in chat, in code, in files, or in
  memory. Env names only. Secure Vault for real keys when Inan
  provides them.

Tracks, started 2026-10-31:
1. Stripe: real Checkout and webhook signature verification.
2. EC2: real deploy path with a prebuilt image and per-tenant IAM.
3. SMS: real Twilio webhook in and out, with opt-out and limits.
