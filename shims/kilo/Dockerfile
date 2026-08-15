# Build from the monorepo root (protocol package is referenced via file:../../packages/protocol):
#   docker build -f shims/kilo/Dockerfile -t pocketagent/kilo-shim .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# tsconfig extends ../../tsconfig.base.json relative to /app
COPY tsconfig.base.json /tsconfig.base.json
# file:../../packages/protocol resolves to /packages/protocol from /app
COPY packages/protocol /packages/protocol

COPY shims/kilo/package.json shims/kilo/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY shims/kilo/tsconfig.json /app/tsconfig.json
COPY shims/kilo/src /app/src
COPY shims/kilo/scripts /app/scripts

EXPOSE 8080
ENV NODE_ENV=production
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
