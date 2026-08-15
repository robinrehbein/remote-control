# Claude shim image: multi-stage — builder compiles TS to dist/, runtime
# runs the compiled server as the non-root `node` user (uid 1000).
# The package.json references the protocol package via file:../../packages/protocol,
# therefore the build context MUST be the monorepo root:
#   docker build -f shims/claude/Dockerfile -t pa-claude .
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/claude

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
# Identical lockfile COPY (and package.json set) in both stages so npm ci
# resolves the pinned optional platform binaries (bundled CLI) identically.
COPY shims/claude/package.json shims/claude/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY shims/claude/tsconfig.json shims/claude/tsconfig.build.json ./
COPY shims/claude/src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/claude

COPY packages/protocol /app/packages/protocol
COPY shims/claude/package.json shims/claude/package-lock.json ./
# Fresh npm ci in the runtime stage so node_modules (incl. the bundled CLI
# binary the SDK spawns) gets npm-installed permissions; tsx is dev-only now.
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /app/shims/claude/dist ./dist
COPY shims/claude/scripts ./scripts

ENV NODE_ENV=production \
    PORT=8080 \
    WORK_DIR=/work \
    HOME=/tmp \
    XDG_CONFIG_HOME=/tmp/xdg

# /run/secrets/pa receives the orchestrator creds file (uid-1000 readable).
RUN mkdir -p /work /run/secrets/pa /tmp/xdg \
  && chown -R node:node /work /run/secrets /tmp/xdg

USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
