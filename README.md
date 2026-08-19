# PocketAgent v2

Fernbedienung für **pi** vom Handy. Eine Android-App steuert Coding-Sessions,
die entweder in Docker-Containern auf deinem Server laufen (Coolify-VPS) oder
per Link-Agent direkt auf deinem Heim-PC/Devcontainer — auf deinen echten
GitHub-Repos, mit Approval-Karten, Diff, Push und Draft-PR.

v2 ist ein bewusster Schnitt: **ein** Agent (pi), **ein** Runner-Image, keine
Adapter-Schicht. Der komplette Multi-Adapter-Stand (Kilo, Claude, Junie, Codex,
Fly-Modus, Gateway) lebt im Tag **`v0.13.0`** weiter — Begründung und
Nicht-Ziele stehen in [`GREENFIELD-PI.md`](GREENFIELD-PI.md).

```
Android (Kotlin/Compose, One UI 9) ─ WSS (JSON, Device-Token) ─┐
                                                              │
                              Orchestrator (Node/TS, docker.sock, SQLite + Vault)
                                                              │
                              ┌───────────────────────────────┴──────────────────┐
                              │ HTTP/SSE pro Session (Random-Token)               │
                              │                                                   │
                    Docker-Session                                     Link-Session
                    runner/-Image je Session                           link/ auf deinem PC,
                    (pi-SDK einkompiliert),                            outbound WS — kein
                    eigenes Netz + Egress-Proxy                        Port, kein Tunnel
```

## Monorepo

| Pfad | Inhalt |
|---|---|
| `packages/protocol/` | Geteilter Contract: Runner-REST-API, normierter Event-Stream, WS-Nachrichten, Pairing, Link-Protokoll, Provider-/Modus-Tabellen (pure TS) |
| `server/` | Orchestrator: SQLite, Vault (AES-256-GCM), Docker-Lifecycle, Runner-Image-Bau, Egress-Proxy, SSE→WS-Weiterleitung, Pairing, FCM, Idle-Reaper, GC |
| `runner/` | Das eine Session-Image: pi-SDK hinter dem REST/SSE-Contract, Auto-Commit auf `agent/<session>`, Push + Draft-PR. **Kein Root-Workspace** (eigenes `package-lock.json`) |
| `link/` | Link-Agent für Heim-PC/Devcontainer: bettet denselben Runner in-process ein und meldet sich per outbound WebSocket beim Orchestrator |
| `android/` | Native App (Kotlin, Jetpack Compose, Material3 in One-UI-9-Anmutung); CI baut das APK |

Der Runner spricht dasselbe Protokoll wie die Shims in v1: `POST /prompt`,
`/abort`, `/resume`, `/permissions/:id`, `GET /status`, `/diff`, `/events`
(SSE mit `seq`-Replay). Nach jedem Turn wird auf `agent/<session-id>`
committet; im Yolo-Modus automatisch gepusht + Draft-PR, sonst per Tap aus der
App.

## Modi

| Modus | Verhalten |
|---|---|
| Yolo | Keine Rückfragen; pusht nach jedem Turn und legt einen Draft-PR an |
| Auto | Änderungen laufen durch; nur riskante Shell-Kommandos werden nachgefragt |
| Edits ok | Datei-Änderungen laufen durch, jedes Shell-Kommando wird nachgefragt |
| Nachfragen | Fragt vor jeder Änderung und jedem Kommando nach |

Provider (pi): `openai`, `anthropic`, `google`, `zai`, `moonshot`, `kimi`.
`moonshot` und `kimi` sind derselbe Account bei platform.moonshot.ai und
teilen sich `KIMI_API_KEY` — hinterlegst du nur eines von beiden, benutzt der
Server es auch für das andere.

## Quickstart: Server (Coolify)

```bash
docker build -f server/Dockerfile -t pocketagent/orchestrator:latest .   # Kontext = Repo-Root!
cp .env.example .env        # MASTER_KEY=$(openssl rand -hex 32)
docker compose up -d
docker exec -it pocketagent-orchestrator node dist/pair.js   # 12-Hex-Pairing-Code, 10 min gültig
```

Das **Runner-Image musst du nicht bauen**: der Orchestrator bündelt die
Quellen (`tsconfig.base.json`, `packages/protocol/`, `runner/`) in seinem
eigenen Image und baut `pocketagent/pi-runner:<RUNNER_IMAGE_TAG>` beim ersten
Session-Start selbst über die Docker-API. Der erste Start dauert dadurch einige
Minuten — die App zeigt den Fortschritt. Vorbauen geht optional mit
`docker compose --profile runner build pi-runner`.

Details, Envs, frisches Volume, Secrets, Troubleshooting: **[`RUNBOOK-PI.md`](RUNBOOK-PI.md)**.

## Quickstart: Link-Agent (Heim-PC / Devcontainer)

```bash
npm install                       # Root-Workspaces (protocol, server, link)
cd runner && npm install && cd .. # runner/ ist eigenständig — dieser Schritt ist Pflicht

npm run link:token -w server -- --name=heim-pc    # auf dem SERVER, gibt PA_TOKEN aus

PA_SERVER=wss://orchestrator.example.com \
PA_TOKEN=<token> \
PA_WORKDIR=/home/robin/code/mein-projekt \
PA_MODE=ask \
OPENAI_API_KEY=sk-... \
npm run start -w link
```

Die Session erscheint automatisch in der App. Provider-Keys kommen aus der
Umgebung dieses Prozesses und bleiben auf deinem Rechner — der Server-Vault
injiziert hier nichts.

## Entwicklung

```bash
npm install && (cd runner && npm install)
npm run typecheck     # protocol, server, link, runner
npm test              # Protocol-Typtests + Link-Tests
npm run smoke:server  # Orchestrator gegen gefälschten Docker-Daemon
npm run smoke:runner
npm run smoke:link
```

`android/`: `cd android && gradle :app:testDebugUnitTest :app:testReleaseUnitTest`.

## Sicherheit

Siehe [`SECURITY.md`](SECURITY.md). Kurzfassung: Sessions laufen ohne
Root-Rechte in eigenen internen Docker-Netzen, ausgehender Verkehr geht
zwangsweise über den Egress-Proxy des Orchestrators (Policy `allowlist` per
Vorgabe), Secrets liegen AES-256-GCM-verschlüsselt unter `MASTER_KEY`, und der
GitHub-PAT erreicht den Container als Datei unter `/run/secrets/pa/`, nie über
die Umgebung.
