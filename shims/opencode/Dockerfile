# Build from the monorepo root (protocol package is referenced via file:../../packages/protocol):
#   docker build -f shims/opencode/Dockerfile -t pocketagent/shim-opencode .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# tsconfig extends ../../tsconfig.base.json relative to /app
COPY tsconfig.base.json /tsconfig.base.json
# file:../../packages/protocol resolves to /packages/protocol from /app
COPY packages/protocol /packages/protocol

COPY shims/opencode/package.json shims/opencode/package-lock.json /app/
RUN npm ci --no-audit --no-fund

COPY shims/opencode/tsconfig.json /app/tsconfig.json
COPY shims/opencode/src /app/src
COPY shims/opencode/scripts /app/scripts

EXPOSE 8080
ENV NODE_ENV=production
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
