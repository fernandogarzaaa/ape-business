# Threat model: public APE agent-execution service

Scope: the AWS deployment in `docs/aws-deployment.md` (single EC2, Caddy,
systemd APE, bearer `/mcp`). Out of scope: vendored-engine internals (own
audits), operator workstation compromise beyond credential theft.

## Assets

AWS root/admin credentials · MCP bearer token · SSH key · TLS identity ·
agent ledger (objectives, tool summaries) · host model credentials (if ever
configured on-box) · compute/budget (LLM spend, CPU) · source checkout.

## Actors

Internet scanner · malicious MCP client (valid bearer, hostile intent) ·
compromised/buggy client · prompt-injection content (web/docs/issues) ·
malicious dependency · compromised AWS identity · operator error.

## Threats → mitigations

| Threat | Mitigation (implemented) | Residual / next |
|---|---|---|
| Credential theft (bearer) | 0600 env file, never logged/printed/committed; rotation without rebuild | Single static bearer; migrate to OAuth/OIDC per-client creds (§12 future) |
| Credential theft (AWS) | Admin IAM user + MFA (operator); root keys retired (operator) | Excess direct policies on user need pruning |
| SSRF (connectors → metadata/internal) | Egress allowlist + per-hop IP safety net (loopback/link-local/RFC1918/multicast blocked, alternate spellings normalized, redirect hops checked); IMDSv2 token-required | DNS-rebinding TOCTOU (documented; egress proxy is the full fix) |
| DNS rebinding (browser → server) | Host allowlist (403) + exact-origin CORS + Caddy edge | Requires APE_ALLOWED_HOSTS set (deployed); loopback debugging must list explicitly |
| Session hijacking | 128-bit random IDs, 30-min idle expiry, DELETE invalidation, single-node memory | No binding of session to principal/token — stolen bearer == stolen sessions (shared-token design) |
| Privilege escalation (tools) | Single bearer = full tool access by design today; destructive ops need confirm/policy; agent loops deny by default | Per-tool authorization not implemented — tool matrix below is the design basis |
| Tool abuse / runaway spend | Per-run budgets, global concurrency + daily caps, spend caps, delegation slices, rate limit (240/min/IP), systemd Restart | No CloudWatch anomaly alarms yet |
| Prompt injection → infrastructure | Tool output + recalled memory framed untrusted; connectors can't reach metadata; confirm gates on destructive ops | Adversarial test suite is a follow-up |
| DoS (payload/CPU) | 4 MB body cap, connector timeouts, provider wall-time abort, budget halts | No WAF/ALB (explicit non-goal); rate limit is coarse |
| Cost abuse (LLM amplifier) | Same as runaway spend + receipts per run | No billing alerts yet |
| Supply chain (npm/Caddy/binary) | Pinned vendors, license gate, checksummed ADAM fetch, lockfiles | Caddy apt + NodeSource scripts trust upstream; Dependabot not enabled |
| Host compromise | SSH scoped to operator IP; unattended-upgrades; no instance role (nothing to steal for AWS) | No IDS/FIM; EBS unencrypted (theft of volume = ledger read) |

## Tool capability matrix (§19 design basis)

- READ: `ape_status`, `ape_recall`, `ape_genome`, `ape_report`, `ape_task_get`,
  `ape_agent_profiles`, `ape_agent_status`, `ape_agent_analyze`,
  `ape_agent_family`, `ape_connector_list`
- EXECUTE + EXPENSIVE: `ape_agent_run`, `ape_agent_resume`, `ape_task_start`,
  `ape_validate_experience`, `ape_mcp_eval`, `ape_audit_claim`,
  `ape_orchestrate`
- NETWORK: `ape_connector_call` (plus model-provider egress)
- MUTATE: `ape_agent_deprecate`, `ape_evolve` (propose), non-readonly
  connector ops
- DESTRUCTIVE (confirm-gated): `ape_evolve` accept/apply, destructive
  connector ops

Enforcement today is the single bearer boundary, not per-tool auth. Any future
scoped credential maps onto this matrix.
