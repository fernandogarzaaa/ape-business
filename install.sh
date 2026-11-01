#!/usr/bin/env bash
set -euo pipefail
# APE one-liner: curl -fsSL https://raw.githubusercontent.com/fernandogarzaaa/ape-mcp/main/install.sh | bash
DST="${HOME}/.ape/src"
mkdir -p "$(dirname "$DST")"
if [ -d "$DST/.git" ]; then git -C "$DST" pull --ff-only; else git clone https://github.com/fernandogarzaaa/ape-mcp "$DST"; fi
cd "$DST"
node --version
npm install --omit=dev
node bin/ape-mcp.js doctor
echo "APE installed at $DST — run: node $DST/bin/ape-mcp.js"
