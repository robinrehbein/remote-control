# Build from the monorepo root so the protocol workspace is in scope:
#   docker build -f shims/opencode/Dockerfile -t pocketagent/opencode-shim:latest .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/opencode

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY shims/opencode/package.json shims/opencode/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY shims/opencode/tsconfig.json ./
COPY shims/opencode/src ./src
COPY shims/opencode/scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npx", "tsx", "src/index.ts"]
