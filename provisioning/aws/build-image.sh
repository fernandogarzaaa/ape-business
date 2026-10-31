#!/bin/sh
# Build the prebuilt APE image. Fails loud, never fakes success.
# Usage: ./build-image.sh [tag]   (default tag: dev)
#        ./build-image.sh --check   Validate Dockerfile and context only, no build.
# Run from anywhere. Requires docker for a real build, not for --check.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--check" ]; then
  if [ ! -f "$SCRIPT_DIR/Dockerfile" ]; then
    echo "build-image: Dockerfile missing in $SCRIPT_DIR" >&2
    exit 1
  fi
  echo "build-image: check ok, Dockerfile present, no build attempted"
  exit 0
fi
TAG="${1:-dev}"
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
  -t "ape-tenant:${TAG}" "$SCRIPT_DIR"
echo "built ape-tenant:${TAG}"
