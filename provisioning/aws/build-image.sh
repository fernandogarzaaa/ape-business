#!/bin/sh
# Build the prebuilt APE image. Fails loud, never fakes success.
# Usage: APE_MCP_ROOT=/path/to/ape-mcp ./build-image.sh [tag]
#        ./build-image.sh --check   Validate every COPY source, no build.
#
# The Dockerfile's build context is the ape-mcp repo root (it COPYs
# package.json, src/, bin/ from there) — the old script built with
# THIS directory as context, so `docker build` failed with
# "package.json not found" on any machine while --check (existence
# of the Dockerfile only) and CI stayed green. The entrypoint comes
# from this directory via a named build context (apeaws).
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APE_MCP_ROOT="${APE_MCP_ROOT:-}"

check_sources() {
  missing=0
  for src in package.json src bin; do
    if [ -z "$APE_MCP_ROOT" ] || [ ! -e "$APE_MCP_ROOT/$src" ]; then
      echo "build-image: COPY source missing: \$APE_MCP_ROOT/$src (set APE_MCP_ROOT to the ape-mcp checkout)" >&2
      missing=1
    fi
  done
  [ -f "$SCRIPT_DIR/entrypoint.sh" ] || { echo "build-image: entrypoint.sh missing in $SCRIPT_DIR" >&2; missing=1; }
  [ -f "$SCRIPT_DIR/Dockerfile" ] || { echo "build-image: Dockerfile missing" >&2; missing=1; }
  return $missing
}

if [ "${1:-}" = "--check" ]; then
  check_sources
  echo "build-image: check ok, every COPY source present, no build attempted"
  exit 0
fi
TAG="${1:-dev}"
check_sources
if ! command -v docker >/dev/null 2>&1; then
  echo "build-image: docker is not available in this environment" >&2
  exit 2
fi
# Secret-value guard: env NAMES are fine, assigned secret values are not.
if grep -R -E 'APE_TOKENS=[^$<]|password\s*=\s*[^$<]|secret\s*=\s*[^$<]' \
    "$SCRIPT_DIR/Dockerfile" "$SCRIPT_DIR/entrypoint.sh" 2>/dev/null | grep -v 'APE_TOKENS is empty'; then
  echo "build-image: refusing: possible secret value in build context" >&2
  exit 1
fi
docker build -f "$SCRIPT_DIR/Dockerfile" \
  --build-context "apeaws=$SCRIPT_DIR" \
  -t "ape-tenant:${TAG}" "$APE_MCP_ROOT"
echo "built ape-tenant:${TAG}"
