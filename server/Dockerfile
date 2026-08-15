FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/protocol /packages/protocol
COPY server/package.json server/package-lock.json* /app/

RUN npm ci --omit=dev || npm install --omit=dev

COPY server/tsconfig.json /app/tsconfig.json
COPY server/src /app/src

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

CMD ["npx", "tsx", "src/index.ts"]
