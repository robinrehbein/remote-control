# Build from the monorepo root so the protocol workspace is in scope:
#   docker build -f shims/codex/Dockerfile .
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/codex

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY shims/codex/package.json shims/codex/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY shims/codex/tsconfig.json shims/codex/tsconfig.build.json ./
COPY shims/codex/src ./src
COPY shims/codex/scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# OpenAI Codex CLI (binary `codex` on PATH), pinned. The shim drives
# `codex app-server` (JSON-RPC over stdio) and `codex login --device-auth`.
# Bump deliberately: the app-server wire format is version-coupled, so pin here
# and regenerate the event types from the same version when upgrading.
ARG CODEX_VERSION=0.42.0
RUN npm install -g @openai/codex@${CODEX_VERSION} --no-audit --no-fund \
 && codex --version

WORKDIR /app/shims/codex

COPY packages/protocol /app/packages/protocol
COPY shims/codex/package.json shims/codex/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /app/shims/codex/dist ./dist
COPY shims/codex/scripts ./scripts

# Session containers run as uid 1000 (node) with a read-only root fs:
# HOME/XDG_CONFIG_HOME point at writable /tmp locations. CODEX_HOME is a
# dedicated *writable volume* so token refresh (auth.json) and thread state
# survive; --ignore-user-config keeps user config from overriding the mode map.
ENV NODE_ENV=production \
    PORT=8080 \
    WORK_DIR=/work \
    HOME=/tmp \
    XDG_CONFIG_HOME=/tmp/xdg \
    CODEX_HOME=/codex-home

RUN mkdir -p /work /run/secrets/pa /tmp/xdg /codex-home \
 && chown -R node:node /work /run/secrets /tmp/xdg /codex-home

USER node
EXPOSE 8080

CMD ["node", "dist/index.js"]
