# Build from the monorepo root so the file: dependency on packages/protocol
# resolves inside the npm workspace graph (see package.json):
#   docker build -f shims/junie/Dockerfile .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Junie CLI (headless one-shot agent runtime, binary `junie` on PATH)
RUN curl -fsSL https://junie.jetbrains.com/install.sh | bash

WORKDIR /app/shims/junie

COPY packages/protocol /app/packages/protocol
COPY shims/junie/package.json shims/junie/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY shims/junie/tsconfig.json ./
COPY shims/junie/src ./src
COPY shims/junie/scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npx", "tsx", "src/index.ts"]
