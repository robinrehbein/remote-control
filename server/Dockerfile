# ---- builder: compile TypeScript to dist/ --------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# workspace dep for `file:../packages/protocol` (referenced as /packages/protocol from /app)
COPY packages/protocol /packages/protocol
COPY server/package.json server/package-lock.json /app/

# ALL deps incl. dev (typescript) - fail hard when out of sync with the lockfile
RUN npm ci

# tsconfig.json extends ../tsconfig.base.json
COPY tsconfig.base.json /tsconfig.base.json
COPY server/tsconfig.json server/tsconfig.build.json /app/
COPY server/src /app/src

RUN npx tsc -p tsconfig.build.json

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# workspace dep trick again: runtime installs only prod deps (no fallback, fail hard)
COPY packages/protocol /packages/protocol
COPY server/package.json server/package-lock.json /app/

RUN npm ci --omit=dev

COPY --from=builder /app/dist /app/dist

# Adapter plugin manifests (shims/*/adapter.json -> /app/adapters/<id>.json)
COPY shims /tmp/shims-manifests
RUN mkdir -p /app/adapters \
  && cd /tmp/shims-manifests \
  && for d in */; do \
       if [ -f "${d}adapter.json" ]; then cp "${d}adapter.json" "/app/adapters/${d%/}.json"; fi; \
     done \
  && rm -rf /tmp/shims-manifests

EXPOSE 3000

ENV DATA_DIR=/data
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
