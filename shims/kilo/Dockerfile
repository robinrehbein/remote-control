# Build from the monorepo root so the protocol workspace is in scope:
#   docker build -f shims/kilo/Dockerfile -t pocketagent/kilo-shim:latest .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/kilo

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY shims/kilo/package.json shims/kilo/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY shims/kilo/tsconfig.json ./
COPY shims/kilo/src ./src
COPY shims/kilo/scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npx", "tsx", "src/index.ts"]
