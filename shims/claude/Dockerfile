# Claude shim image.
# The package.json references the protocol package via file:../../packages/protocol,
# therefore the build context MUST be the monorepo root:
#   docker build -f shims/claude/Dockerfile .
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/claude

COPY packages/protocol /app/packages/protocol
COPY shims/claude/package.json shims/claude/package-lock.json ./
# npm ci uses the lockfile (incl. pinned native CLI platform binaries);
# npm install as fallback in case of lockfile/platform quirks
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY shims/claude/ ./

ENV PORT=8080 \
    WORK_DIR=/work

EXPOSE 8080

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
