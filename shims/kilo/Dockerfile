# Build from the monorepo root so the protocol workspace is in scope:
#   docker build -f shims/kilo/Dockerfile -t pocketagent/kilo-shim:latest .
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/kilo

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY shims/kilo/package.json shims/kilo/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY shims/kilo/tsconfig.json shims/kilo/tsconfig.build.json ./
COPY shims/kilo/src ./src
COPY shims/kilo/scripts ./scripts
RUN npx tsc -p tsconfig.build.json

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/kilo

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY shims/kilo/package.json shims/kilo/package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev

COPY --from=builder /app/shims/kilo/dist ./dist
COPY --from=builder /app/shims/kilo/scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp/xdg

# /work is the session checkout, /run/secrets/pa receives the orchestrator's
# creds.json bind mount (uid-1000-readable); all owned by the runtime user.
RUN mkdir -p /work /run/secrets/pa /tmp/xdg \
 && chown -R node:node /work /run/secrets /tmp/xdg

USER node
EXPOSE 8080

CMD ["node", "dist/index.js"]
