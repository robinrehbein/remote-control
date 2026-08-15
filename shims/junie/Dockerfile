# Build from the monorepo root so the file: dependency on packages/protocol
# resolves inside the npm workspace graph (see package.json):
#   docker build -f shims/junie/Dockerfile .
FROM node:22-bookworm-slim AS builder

# git + ca-certificates, plus curl/unzip which the junie install script needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# Junie CLI (headless one-shot agent runtime, binary `junie` on PATH).
# Installed once with HOME=/opt/junie so the shim + versioned binaries live
# outside any user's home and stay readable for the non-root runtime user
# (HOME is /tmp there); the runtime stage symlinks it into /usr/local/bin.
RUN mkdir -p /opt/junie \
 && curl -fsSL https://junie.jetbrains.com/install.sh | env HOME=/opt/junie bash \
 && chmod -R a+rX /opt/junie

WORKDIR /app/shims/junie

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY shims/junie/package.json shims/junie/package-lock.json ./

RUN npm ci --no-audit --no-fund

COPY shims/junie/tsconfig.json shims/junie/tsconfig.build.json ./
COPY shims/junie/src ./src
COPY shims/junie/scripts ./scripts

RUN npm run build

FROM node:22-bookworm-slim

# Same packages as before: git for gitops, ca-certificates for https,
# curl/unzip for the junie CLI shim (channel one-shot installs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/shims/junie

COPY packages/protocol /app/packages/protocol
COPY shims/junie/package.json shims/junie/package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /app/shims/junie/dist ./dist
COPY shims/junie/scripts ./scripts

# junie CLI from the builder; readable by every user and on PATH via
# /usr/local/bin. JUNIE_DATA pins the shim's version store to the image copy
# so it is found even though HOME is /tmp for the runtime user.
COPY --from=builder /opt/junie /opt/junie
RUN ln -s /opt/junie/.local/bin/junie /usr/local/bin/junie

ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp \
    XDG_CONFIG_HOME=/tmp/xdg \
    JUNIE_DATA=/opt/junie/.local/share/junie

# /work holds the session checkout; /run/secrets/pa receives the creds.json
# mount (uid-1000-readable); /tmp dirs are writable scratch for USER node.
RUN mkdir -p /work /run/secrets/pa /tmp/xdg \
 && chown -R node:node /work /run/secrets /tmp/xdg

USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
