# APE for Business: Security Design

Status: design document, 2026-10-31. It describes the security layers
for the hosted APE platform. It does not claim a layer is live until
that layer is marked Live below. Prototype files in this folder are
local mocks, not a live service.

## Correction to the earlier plan

Sealbox is a Day 1 integration, not a later phase and not a full
build from scratch. The design already exists in ~/workspace/sealbox
(README and docs/DESIGN.md, design phase, implementation in progress,
no public repo). APE already has the hooks it needs: a ledger, an
egress allowlist, a destructive confirm gate, budgets, and a Sigil
gate. Day 1 work is wiring the Sealbox content gate into those hooks,
not inventing a new product.

## Security layers, in order

### 1. Tenant isolation (Live pattern, to be enforced per tenant)

- One APE process per tenant, one ledger per tenant, one vault secret
  per tenant, one storage prefix per tenant, one IAM role per tenant.
- No shared memory across tenants. No shared keys across tenants.
- A tenant agent never learns from another tenant's data, and
  disconnecting a system revokes that system's access and stops
  future reads.
- Source pattern: APE profiles, budgets, and ledgers; pipeline IAM
  role per tenant in DEPLOYMENT_PIPELINE.md.

### 2. Tool trust: Sigil (Live in the Meta demo, to be enforced in production)

- Before every tool call, the tool server badge is checked: Ed25519
  signature, keyId matching the public key, server and version pinned,
  revocation checked.
- Policy in the standard profile: allow low and medium, block high,
  critical, unknown, bad signature, and revoked.
- A revocation stops the next tool call. It does not wait for a task
  to finish.
- A badge proves identity, version, and risk level. It does not prove
  competence. Outcome history in the ledger sits beside the badge.
- Source: sigil-index (145 badges at last check), and the Sigil gate
  in ~/workspace/ape-mcp-sigil-demo/src/agent/sigil-gate.js.

### 3. Egress control (Live pattern in APE)

- Every connector declares an egress allowlist. Requests to a host
  outside it are refused at request time.
- Connectors are declarative YAML only: base URL, auth token env name
  (name only, never the value), and the allowlist.
- Destructive operations need an explicit confirm gate. An agent
  calling one without confirm does not run it.
- Source: ~/workspace/ape-mcp/docs/connectors.md, and the bundled web
  connector, which is read-only.

### 4. Content gate: Sealbox, Day 1 integration

This is the layer that stops a destination-allowed leak. A network
gate can allow a host and still let one sensitive row through. The
content gate checks what crosses, not just where it goes.

Integration points in an APE job, in order:

1. Connector read. Data arrives inside the tenant boundary.
2. Sealbox pass. Before that data leaves the tenant boundary, it
   passes a local redaction and tokenization pass, built from the
   Sealbox design:
   - Names, emails, phone numbers, client identifiers, and anything
     matching a credential pattern in pasted text are replaced with
     stable, tenant-scoped tokens (for example, a customer name
     becomes a customer ID that only this tenant can resolve).
   - The token map lives only in that tenant's vault. It is never
     written to a profile file, a log, or a ledger entry.
   - Schema-fixed events are used for anything that crosses to a
     third party, an analytics store, or an audit export: fixed
     fields, no free text drift.
3. Model and tool dispatch. The model and external tools see tokens
   and schema-fixed events, not raw PII, unless the job is internal
   to that tenant and the owner has approved that channel.
4. Presentation. When a reply goes back to the authorized owner or
   customer channel, the tenant's own APE resolves tokens back to
   names, inside the tenant boundary, for that reply only.
5. Audit. Every crossing is logged in the tenant ledger with a
   timestamp, event count, destination, and a hash of the payload,
   following the GHOST-Chimera HMAC chained audit pattern. The log
   proves what crossed, without holding the raw data itself.

What this integration reuses, and what it does not invent:

- Reuses: the Sealbox event schema, the redaction pattern list, the
  destination versus content separation, and reference-by-ID secrets.
- Reuses: APE's ledger, budgets, and confirm gate as the enforcement
  points.
- New, but small: the token map store in the tenant vault, the
  redaction pass wired between connector read and dispatch, and the
  resolve step at presentation time.
- Not a full build: no new recorder, no new cloud runtime, no new
  agent. The APE job is the runtime. The Sealbox pass is a gate
  inside it.

What Sealbox does not mitigate, stated plainly:

- A compromised tenant machine or a compromised owner account is not
  fixed by a content gate. Disk encryption and account policy are
  the owner's responsibility.
- Tokenized data still goes to a model provider for inference. The
  gate limits what the provider can identify, it does not make the
  provider see nothing.
- Prompt injection through event text is handled separately: event
  text is data, never instructions, and summarization prompts are
  fixed templates, not concatenated with event content.

### 5. Secrets (Live pattern, to be enforced per tenant)

- One credential per system, per tenant. OAuth where the service
  offers it (Gmail, Shopify, Salesforce). Env referenced tokens
  elsewhere.
- Secret values never appear in a profile file, a connector file, a
  log, or a generated bundle. Only env names appear there.
- In production, one Secrets Manager secret per tenant, scoped by
  that tenant's IAM role, plus one S3 prefix and one log group.
- No human IAM user per business. API access is a separate APE
  bearer token, returned once, revocable on disconnect.
- Source: pipeline IAM design in DEPLOYMENT_PIPELINE.md, and the
  APE connector auth rule.

### 6. Auth and transport

- APE_REQUIRE_AUTH=1, bearer tokens, Caddy TLS, APE bound to
  loopback only on its host. No public endpoint without auth.
- Provisioning starts only on a verified payment webhook, never on
  a client side callback. A failed deploy after payment stops, does
  not mark ready, and surfaces a refund or retry choice.

### 7. Audit (Pattern from GHOST-Chimera, to be enforced per tenant)

- Every job has a run ID and an outcome status: success, unverified,
  exhausted, failed, or cancelled. A job that cannot fully check
  itself ends as unverified, and is treated as a draft.
- Every tool call carries a Sigil decision and an audit entry: tool,
  server, version, badge type, risk score and level, keyId,
  signature validity, revocation status, decision, reason, and
  timestamp.
- The owner can export the ledger for their tenant. Exported audit
  data passes the Sealbox pass: tokens, not raw PII, unless the
  owner explicitly exports their own resolved records.

### 8. Human gates

- Spend above a cap, commitments to third parties, and destructive
  actions always need a human, no matter how trusted the agent is.
- Writes and money moves need explicit confirmation, every time,
  until the owner raises the cap in writing.
- The owner stop button stops a tenant task. It does not queue a
  polite shutdown that finishes the current spend first.

### 9. Text and email identity: channel abuse

- The agent identifies itself as an AI agent in its first message,
  on every channel, every time. It never presents as a human employee.
- Rate limits per tenant and per sender. Spam filtering and opt-out
  handling on both SMS and email, before a message becomes a job.
- Phone numbers and inboxes are provisioned per tenant, not the
  owner's personal number or inbox, so disconnecting the agent does
  not touch the owner's own contact details.
- Inbound message content passes the Sealbox pass before it is
  stored in a shared log or sent to a third party.

### 10. Disconnect, retention, and deletion

- Disconnecting a system revokes its token and stops future reads.
  It does not delete the tenant's past ledger, which is audit history.
- On churn, the owner chooses: export the ledger, then delete
  tenant data, including the token map, which makes tokenized
  records unresolvable. What is kept for audit, and for how long,
  must be stated in plain words before the owner pays. That
  retention paragraph is still to be written, and is a Phase 1 gate,
  not an afterthought.

## Maturity table: what is real, what is integration, what is still to build

| Layer | Status on 2026-10-31 |
| --- | --- |
| Sigil gate in the demo loop | Built and tested in the demo copy |
| Sigil index, 145 badges | Live index, updated daily |
| APE egress allowlist, confirm gate, budgets, ledger | Shipped patterns in APE |
| Tenant IAM role per tenant | Designed in the pipeline, not yet provisioned for real |
| Encrypted per-tenant vault | Planned for Phase 1, prototype files are plain |
| Sealbox content gate | Wired into SMS intake (provisioning/sealbox.js, 13 SMS checks pass): emails and phones tokenized per tenant, audit log carries no raw PII, token map in memory per handler. Production vault store still to do, so do not yet claim PII never leaves a business |
| SMS gateway number rental, inbound email handling | Not provisioned, prototype placeholders only |
| Retention and deletion paragraph | To be written, Phase 1 gate |
| Public security page | This document first, site section second, neither published yet |

## Claims we may and may not make

May make, once Phase 1 is done: your agent is isolated per tenant,
every tool call is Sigil gated, egress is allowlisted, secrets are
per tenant and never in profile files, and every job is logged with
a receipt you can export.

May not make today: PII never leaves your business, Sealbox is
shipped, or a badge proves an agent is good at its job. Those three
claims would be false or unproven on the evidence above, and they
must not appear in sales text, on the site, or in a submission
until the Day 1 integration is wired and tested.
