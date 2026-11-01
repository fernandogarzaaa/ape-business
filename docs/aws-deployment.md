# AWS deployment (production, single-node)

Live since 2026-09-24. Region `us-east-1`. All resources taggable; reproduce
from `deploy/aws/user-data.sh` (static, no secrets baked in).

## Architecture

```text
Internet → :80/:443 → Caddy (TLS, LE auto-renew) → 127.0.0.1:8787 → ape-mcp
```

## Resources (actual)

| Resource | ID / value |
|---|---|
| EC2 | `i-036c300637d69b335`, t3.small, Ubuntu 24.04 (`ami-0045d7fc2ad003464`), default VPC `vpc-0bb90e6dfc47a52c3` |
| Public IP | Elastic IP `32.197.109.159` (static; DNS no longer tracks instance lifecycle) |
| DNS | `ape.runs-on.dev` → A `32.197.109.159` (free registry; sslip.io retired) |
| Security group | `sg-0465525a14bd1ca75`: 22 from operator IP only, 80/443 open |
| SSH key | `ape-mcp-key` (private key with operator only, ACL-locked) |
| EBS | `vol-03ff1b580911c2df2`, 8 GB gp3, **unencrypted** (default-encryption now ON for future volumes; migrate or accept, see below) |
| IAM instance profile | none (nothing on the box needs AWS APIs — deliberate) |
| Monitoring | detailed monitoring off; CloudTrail `ape-mcp-audit` ON (multi-region, log validation, bucket `ape-mcp-cloudtrail-353452454012`) |
| IMDS | IMDSv2 required (`HttpTokens: required`), hop limit 2 |

## Services on box

- `ape.service` (user `ape`, `Restart=always`, env from `/home/ape/ape.env`
  `0600`): `node bin/ape-mcp.js --http 8787`, loopback only. Branch deployed:
  check with `git log --oneline -1` in `/home/ape/ape-mcp`.
- `caddy.service`: `ape.runs-on.dev → reverse_proxy 127.0.0.1:8787`.
  No Caddyfile hardening beyond defaults yet (see limitations).
- `unattended-upgrades` enabled; NTP synced.

## Environment schema (`/home/ape/ape.env`)

```text
APE_REQUIRE_AUTH=1
APE_TOKENS=<hex>                 # rotated out-of-band, never in git
APE_PORT=8787
APE_ALLOWED_HOSTS=ape.runs-on.dev
# APE_CORS_ORIGIN=...            # set when a browser client exists
# APE_RATE_LIMIT_RPM=240         # defaults; raise only deliberately
```

## Deploy / rollback

```bash
# deploy a branch (from operator machine):
ssh -i ~/.ssh/ape-mcp-key.pem ubuntu@98.86.146.92
cd /home/ape/ape-mcp && sudo -u ape git fetch origin \
  && sudo -u ape git checkout <branch> \
  && sudo -u ape git pull --ff-only origin <branch>
node --check src/http.js && sudo systemctl restart ape
```

Rollback: checkout the previous commit/branch and restart. Nothing migrates
outside SQLite `ALTER TABLE ... ADD COLUMN` (additive, backward compatible).

## Recovery (RPO/RTO honest version)

- RPO: ledger (`/home/ape/ape-mcp/.ape/`) is NOT backed up — runs are
  reproducible from git + objectives, not restorable byte-for-byte. Accept, or
  add an EBS snapshot schedule when the ledger becomes load-bearing.
- RTO: replacement instance from `deploy/aws/user-data.sh` in ~10 minutes
  (EIP reassociation → update the A record once, same procedure). DNS recovery
  is a registry edit, not infrastructure work.
- Secrets: bearer token exists ONLY in `/home/ape/ape.env`. Loss = generate a
  new one (`openssl rand -hex 32`), replace, restart. No backup of secrets
  anywhere (by design).
- TLS: Caddy re-issues automatically on a fresh host.

## Costs (current)

t3.small on-demand us-east-1 (~$15/mo) + 8 GB gp3 (~$0.65/mo) + CloudTrail
S3 pennies. No ALB/NAT/billable extras by design.

## Limitations (explicit)

Single node, no HA; unencrypted root volume (accepted pending migration);
retired sslip.io hostname; single shared bearer (no per-client identity);
no rate-limit tuning yet (defaults); no CloudWatch alarms (see
incident-response for the manual watch list); no Secrets Manager (evaluated
below — env file + 0600 + rotation procedure is the current control).
