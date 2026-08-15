# Build from the monorepo root so the protocol workspace is in scope:
#   docker build -f shims/opencode/Dockerfile -t pocketagent/opencode-shim:latest .
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/opencode

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY shims/opencode/package.json shims/opencode/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY shims/opencode/tsconfig.json shims/opencode/tsconfig.build.json ./
COPY shims/opencode/src ./src
COPY shims/opencode/scripts ./scripts
RUN npx tsc -p tsconfig.build.json

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/opencode

# same monorepo layout as the builder so the file: workspace dep resolves
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY shims/opencode/package.json shims/opencode/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder --chown=node:node /app/shims/opencode/dist ./dist
# the orchestrator invokes /app/shims/opencode/scripts/push.js verbatim
COPY --from=builder --chown=node:node /app/shims/opencode/scripts ./scripts

ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp \
    XDG_CONFIG_HOME=/tmp/xdg

# /work: named volume with the cloned repo; /run/secrets/pa: creds file mount;
# /tmp/xdg: XDG config (rootfs is read-only, /tmp is tmpfs)
RUN mkdir -p /work /run/secrets/pa /tmp/xdg \
 && chown -R node:node /work /run/secrets /tmp/xdg /app/shims/opencode

USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
