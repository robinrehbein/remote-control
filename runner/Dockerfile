# Build from the monorepo root so the protocol workspace is in scope:
#   docker build -f runner/Dockerfile .
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/runner

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY runner/tsconfig.json runner/tsconfig.build.json ./
COPY runner/src ./src
COPY runner/scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/runner

COPY packages/protocol /app/packages/protocol
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /app/runner/dist ./dist
COPY runner/scripts ./scripts

# Session containers run as uid 1000 (node) with a read-only root fs:
# HOME/XDG_CONFIG_HOME point at writable /tmp locations so the pi SDK and its
# child processes inherit writable paths; git creds arrive via /run/secrets/pa.
ENV NODE_ENV=production
ENV PORT=8080
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp/xdg

RUN mkdir -p /work /run/secrets/pa /tmp/xdg \
 && chown -R node:node /work /run/secrets /tmp/xdg

USER node
EXPOSE 8080

CMD ["node", "dist/index.js"]
