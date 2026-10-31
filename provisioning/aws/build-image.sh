#!/bin/sh
# Build the prebuilt APE image. Fails loud, never fakes success.
# Usage: ./build-image.sh [tag]   (default tag: dev)
# Run from the ape-mcp repo root. Requires docker.
set -eu
TAG="${1:-dev}"
if ! command -v docker >/dev/null 2>&1; then
  echo "build-image: docker is not available in this environment" >&2
  exit 2
fi
# Secret-value guard: env NAMES are fine, assigned secret values are not.
if grep -R -E 'APE_TOKENS=[^$<]|password\s*=\s*[^$<]|secret\s*=\s*[^$<]' \
    Dockerfile entrypoint.sh src bin 2>/dev/null | grep -v 'APE_TOKENS is empty'; then
  echo "build-image: refusing: possible secret value in build context" >&2
  exit 1
fi
docker build -f ~/workspace/ape-provisioning/aws/Dockerfile \
  -t "ape-tenant:${TAG}" .
echo "built ape-tenant:${TAG}"
