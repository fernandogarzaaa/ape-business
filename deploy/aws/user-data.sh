#!/bin/bash
# APE MCP remote endpoint — EC2 user-data (Ubuntu 24.04).
# Self-configuring: derives its public DNS as <dash-ip>.sslip.io from instance
# metadata, so no domain or secrets are baked in. Bearer token is generated
# on-box into /home/ape/ape.env (0600); fetch it over SSH after boot.
# Caddy terminates TLS (automatic Let's Encrypt) and forwards to APE loopback.
set -eux
exec > /var/log/ape-boot.log 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl git openssl

# Node.js 22 (Nodesource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy (official repo, automatic HTTPS)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# App user + checkout (public repo @ default branch)
id ape >/dev/null 2>&1 || useradd -m -s /bin/bash ape
sudo -u ape git clone https://github.com/fernandogarzaaa/ape-business /home/ape/ape-mcp
cd /home/ape/ape-mcp
sudo -u ape npm install --omit=dev --no-audit --no-fund

# Bearer token (generated on-box, never in user-data or images)
TOKEN="$(openssl rand -hex 32)"
printf 'APE_REQUIRE_AUTH=1\nAPE_TOKENS=%s\nAPE_PORT=8787\n' "$TOKEN" > /home/ape/ape.env
chown ape:ape /home/ape/ape.env
chmod 600 /home/ape/ape.env

# systemd unit (loopback only — TLS terminates at Caddy)
cat > /etc/systemd/system/ape.service <<'UNIT'
[Unit]
Description=APE MCP agent runtime
After=network-online.target
Wants=network-online.target
[Service]
User=ape
WorkingDirectory=/home/ape/ape-mcp
EnvironmentFile=/home/ape/ape.env
ExecStart=/usr/bin/node /home/ape/ape-mcp/bin/ape-mcp.js --http 8787
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ape.service

# Public DNS via sslip.io (no DNS action needed) + Caddy reverse proxy.
# IMDSv2 token flow: plain metadata reads return 401 on hardened AMIs.
IMDS_TOKEN="$(curl -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' -s)"
PUBIP="$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)"
DOMAIN="$(echo "$PUBIP" | tr . -).sslip.io"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl enable --now caddy
echo "APE endpoint ready: https://$DOMAIN (health: https://$DOMAIN/discover)"
