# Kontext ist IMMER das Repo-Root, damit der Protokoll-Workspace im Zugriff ist:
#   docker build -f runner/Dockerfile -t pocketagent/pi-runner:latest .
#
# Im Betrieb baut das niemand von Hand: der Orchestrator buendelt genau dieses
# Layout unter /app/build-context (server/Dockerfile) und schickt es beim ersten
# Session-Start ueber die Docker-API an den Daemon (ensureRunnerImage). Jede
# COPY-Quelle hier muss deshalb in diesem Buendel liegen - tsconfig.base.json,
# packages/protocol/, runner/ -; der Server-Smoke liest dieses Dockerfile und
# prueft genau das, weil Docker in der CI nicht zur Verfuegung steht.
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/runner

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/protocol /app/packages/protocol
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY runner/tsconfig.json runner/tsconfig.build.json ./
COPY runner/src ./src
COPY runner/scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/runner

COPY packages/protocol /app/packages/protocol
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /app/runner/dist ./dist

# scripts/ liegt bewusst NEBEN dist/: `npm run build` ist tsc mit include:["src"]
# und emittiert nur TypeScript - push.js ist fertiges JavaScript und wandert
# unveraendert mit. Der Orchestrator startet fuer den Tap-Push einen
# Wegwerf-Container mit `node /app/runner/scripts/push.js`
# (server/src/runner.ts: RUNNER_PUSH_SCRIPT); wer diese Zeile aendert, muss
# dort mit - der Server-Smoke prueft beide Seiten gegeneinander.
COPY runner/scripts ./scripts

# Session containers run as uid 1000 (node) with a read-only root fs:
# HOME/XDG_CONFIG_HOME point at writable /tmp locations so the pi SDK and its
# child processes inherit writable paths; git creds arrive via /run/secrets/pa.
ENV NODE_ENV=production
ENV PORT=8080
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp/xdg

RUN mkdir -p /work /run/secrets/pa /tmp/xdg \
 && chown -R node:node /work /run/secrets /tmp/xdg

USER node
EXPOSE 8080

CMD ["node", "dist/index.js"]
