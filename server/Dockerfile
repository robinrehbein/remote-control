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

# Build-Kontext des Runner-Images (server/src/runner.ts, docker.ensureRunnerImage).
#
# Coolify baut nur dieses Dockerfile, das Runner-Image muss also ohne manuellen
# Schritt auf den Host kommen: der Server bündelt die Quellen und baut daraus
# beim ersten Session-Start `pocketagent/pi-runner:<RUNNER_IMAGE_TAG>` über die
# Docker-API, falls das Image dort noch nicht liegt.
#
# Das Layout hier MUSS genau dem entsprechen, was runner/Dockerfile aus seinem
# (Repo-Root-)Kontext kopiert - tsconfig.base.json, packages/protocol, runner/.
# node_modules bleiben über die .dockerignore draußen.
COPY tsconfig.base.json /app/build-context/tsconfig.base.json
COPY packages/protocol /app/build-context/packages/protocol
COPY runner /app/build-context/runner

# Zur Buildzeit eingebrannter Vorgabe-Tag. Ein Deploy mit geändertem Runner
# sollte ihn hochzählen (`--build-arg RUNNER_IMAGE_TAG=…` bzw. Coolify-Build-Arg),
# damit ensureRunnerImage kein Image dieses Namens findet und neu baut - das
# Content-Hash-System aus v1 gibt es bewusst nicht mehr.
# Zur Laufzeit schlägt eine gesetzte Env-Variable diesen Wert; `RUNNER_IMAGE`
# gibt ein fertiges Registry-Image komplett vor (dann wird nur gepullt).
ARG RUNNER_IMAGE_TAG=latest
ENV RUNNER_IMAGE_TAG=${RUNNER_IMAGE_TAG}

EXPOSE 3000

ENV DATA_DIR=/data
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
