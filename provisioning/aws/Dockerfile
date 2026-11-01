# syntax=docker/dockerfile:1
# APE tenant image: prebuilt, no install-from-scratch at deploy time.
# Build context is the ape-mcp repo root. No secret values are copied.
# APE binds loopback 8787; Caddy (sidecar in the task definition)
# proxies to it. Bearer token arrives via Secrets Manager, never here.
FROM node:22-bookworm-slim
RUN groupadd -r ape && useradd -r -g ape -m -d /home/ape ape
WORKDIR /home/ape/ape-mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY bin ./bin
RUN chown -R ape:ape /home/ape/ape-mcp
USER ape
ENV APE_PORT=8787 APE_HOST=127.0.0.1 APE_REQUIRE_AUTH=1
EXPOSE 8787
COPY --from=apeaws --chown=ape:ape entrypoint.sh /home/ape/entrypoint.sh
ENTRYPOINT ["/bin/sh", "/home/ape/entrypoint.sh"]
