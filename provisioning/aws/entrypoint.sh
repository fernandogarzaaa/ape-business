#!/bin/sh
# APE tenant entrypoint. Loopback only. Fail loud without auth.
set -eu
if [ "${APE_REQUIRE_AUTH:-}" != "1" ]; then
  echo "refusing to start: APE_REQUIRE_AUTH must be 1" >&2
  exit 1
fi
if [ -z "${APE_TOKENS:-}" ]; then
  echo "refusing to start: APE_TOKENS is empty (inject from Secrets Manager)" >&2
  exit 1
fi
exec node /home/ape/ape-mcp/bin/ape-mcp.js --http 8787
