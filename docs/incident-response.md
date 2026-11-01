# Incident response (minimal, for this deployment)

Contacts: operator (account root break-glass + `fernandogarzadev` admin).
Evidence sources: CloudTrail `ape-mcp-audit` (control plane), on-box
`journalctl -u ape`, `journalctl -u caddy`, `/home/ape/ape-mcp/.ape/`
(run ledger), Caddy access logs.

## Credential compromise (bearer)

```bash
# 1. revoke: replace with fresh value (old dies on restart)
ssh -i ~/.ssh/ape-mcp-key.pem ubuntu@98.86.146.92
TOK=$(openssl rand -hex 32)
printf 'APE_REQUIRE_AUTH=1\nAPE_TOKENS=%s\nAPE_PORT=8787\nAPE_ALLOWED_HOSTS=98-86-146-92.sslip.io\n' "$TOK" | sudo tee /home/ape/ape.env >/dev/null
sudo chown ape:ape /home/ape/ape.env && sudo chmod 600 /home/ape/ape.env
# 2. rotate: restart
sudo systemctl restart ape
# 3. verify: old token → 401, new token → 200 on POST /mcp initialize
# 4. audit: grep ledger for runs during the exposure window; record dates
```

Never print the new token. Update every registered MCP client with the fresh
value (they will 401 until you do — that is the revocation working).

## Credential compromise (AWS)

1. Sign in as root (MFA), open the compromised identity.
2. Deactivate (not delete, for forensics) keys/sessions; force sign-out.
3. Review CloudTrail `ape-mcp-audit` for actions in the window.
4. Issue replacement credentials; rotate dependents (CLI profiles).
5. Delete the compromised material only after review.

## Suspected host compromise

1. Do NOT reboot first (destroys memory state): snapshot the EBS volume,
   capture `journalctl`, ledger, and `ss` output.
2. Revoke the bearer (above) and remove SSH ingress (`aws ec2 revoke-security-group-ingress`).
3. Replace the host: fresh instance from `deploy/aws/user-data.sh`, new token,
   update DNS/clients. Terminate the old instance only after evidence capture.

## APE abuse (runaway spend / tool misuse)

1. `sudo systemctl stop ape` (halts all workers; ledger preserved).
2. Identify principal (only bearer identity exists today), tool, and egress
   from the ledger + trace.
3. Revoke/rotate the bearer, tighten `APE_RATE_LIMIT_RPM` / budgets, restart.

## Manual watch list (no CloudWatch alarms yet)

Daily until alarms exist: `systemctl is-active ape caddy`, repeated 401/429
bursts in Caddy logs, `ape` CPU/memory via `systemd-cgtop`, EBS usage via
`df -h`, CloudTrail for unexpected control-plane calls.
