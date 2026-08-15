# Build from the monorepo root so the protocol workspace is in scope:
#   docker build -f shims/pi/Dockerfile .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/pi

COPY packages/protocol /app/packages/protocol
COPY shims/pi/package.json shims/pi/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY shims/pi/tsconfig.json ./
COPY shims/pi/src ./src
COPY shims/pi/scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npx", "tsx", "src/index.ts"]
