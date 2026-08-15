# PocketAgent

Provider-agnostische Mobile-Agent-Plattform: Steuerung von Coding-Agenten (**OpenCode, Kilo Code, Claude Code, pi, Junie** — und jedem weiteren Harness als Plugin, siehe `ADAPTERS.md`) per Android-App; die Agenten arbeiten isoliert in Docker-Containern auf deinem Server (z. B. Coolify-VPS) direkt auf deinen GitHub-Repos. Wie Claude Remote Sessions / Kilo Cloud Sessions — aber harness- und provider-agnostisch.

```
Android (Kotlin/Compose, WS + FCM)
   ↕ WSS (JSON, Device-Token)
Orchestrator (Node/TS auf deinem Server, docker.sock)
   ├─ Adapter-Registry: lädt shims/*/adapter.json Manifeste (Plugins!)
   ↕ HTTP/SSE pro Session (Random-Token)
Adapter-Shims in Session-Containern (einheitliches Protokoll)
   ├─ opencode-shim  → opencode serve (75+ Provider)
   ├─ kilo-shim      → kilo serve (Kilo CLI, OpenCode-Fork)
   ├─ claude-shim    → Claude Agent SDK (Pro/Max-Subscription via setup-token)
   ├─ pi-shim        → pi SDK (ZAI/Kimi/Qwen-Kataloge, Remote-Approvals)
   └─ junie-shim     → Junie CLI headless (BYOK)
```

## Monorepo

| Pfad | Inhalt |
|---|---|
| `packages/protocol/` | Geteilter Contract: Shim-REST-API, normierter Event-Stream, WS-Nachrichten, Pairing, Adapter-Manifest-Typen (pure TS-Typen) |
| `server/` | Orchestrator: SQLite, Vault (AES-256-GCM), **Adapter-Registry (Manifest-Plugins)**, Docker-Lifecycle, SSE→WS-Weiterleitung, Pairing, FCM, Idle-Reaper, GC |
| `shims/opencode/` | OpenCode-Adapter (Proxy auf `opencode serve`) |
| `shims/kilo/` | Kilo-CLI-Adapter (Proxy auf `kilo serve`, OpenCode-kompatibel) |
| `shims/claude/` | Claude-Code-Adapter (Agent SDK, `CLAUDE_CODE_OAUTH_TOKEN`) |
| `shims/pi/` | pi-Adapter (SDK-Embedding, Approvals via `tool_call`-Hook) |
| `shims/junie/` | Junie-Adapter (CLI-Spawn pro Prompt, JSON-Output) |
| `android/` | Native App (Kotlin, Jetpack Compose, Material3) — Adapterliste kommt dynamisch vom Server; CI baut das APK via GitHub Actions |
| `link/` | **Link-Agent**: läuft in deinem Devcontainer/PC/VPS, verbindet sich per outbound-WebSocket mit dem Orchestrator und stellt deinen Live-Workspace als Session bereit (siehe `HOMEPC.md`) |
| `ADAPTERS.md` | Plugin-Guide: Manifest-Schema + Harness in 5 Schritten hinzufügen |

Jeder Shim implementiert dasselbe Protokoll: `POST /prompt`, `POST /abort`, `POST /resume`, `POST /permissions/:id`, `GET /status`, `GET /diff`, `GET /events` (SSE mit normierten `AgentEvent`s). Nach jedem Turn auto-committet der Shim auf `agent/<session-id>`; im Yolo-Modus wird automatisch gepusht + Draft-PR geöffnet, sonst per Tap in der App.

## Modi

| Modus | Verhalten |
|---|---|
| Yolo | Keine Gates; Auto-Push + Draft-PR pro Turn |
| Auto | OpenCode `--auto`, Claude `auto`, pi: nur risky Bash gegated, Junie: ohne Gates |
| AcceptEdits | Edits frei, Bash fragt (opencode/claude/pi; Junie: Warnbanner, ohne Gates) |
| Ask | Alles Wichtige fragt → Approval-Karte in der App (Junie: Warnbanner, ohne Gates) |

## Deployment (Coolify / Docker-Host)

### 1. Images bauen (auf dem Server, aus dem Repo-Root)

```bash
docker build -f server/Dockerfile        -t pocketagent/orchestrator:latest .
docker build -f shims/opencode/Dockerfile -t pocketagent/opencode-shim:latest .
docker build -f shims/kilo/Dockerfile     -t pocketagent/kilo-shim:latest .
docker build -f shims/claude/Dockerfile   -t pocketagent/claude-shim:latest .
docker build -f shims/pi/Dockerfile       -t pocketagent/pi-shim:latest .
docker build -f shims/junie/Dockerfile    -t pocketagent/junie-shim:latest .
```

Wichtig: Build-Kontext ist immer der Repo-Root (`.`), weil die Shims und der Server per `file:`-Dependency `packages/protocol` einbinden.

### 2. Orchestrator starten

```bash
cp .env.example .env    # MASTER_KEY setzen: openssl rand -hex 32
docker compose up -d
```

Der Orchestrator mountet `docker.sock` (startet/stoppt Session-Container), legt SQLite + Vault in `orchestrator-data` ab und lauscht auf `:3000`. In Coolify: als App via Dockerfile/Compose deployen, Domain + TLS davor schalten.

**Alternative Fly.io** (Orchestrator auf Fly, Container auf deinem Docker-Host via `DOCKER_HOST`): Anleitung in `FLY.md` — der Server unterstützt beide Modi ohne Codeänderung.

### 3. Pairing

```bash
docker exec -it pocketagent-orchestrator npx tsx src/pair.ts
# → Code 8 Zeichen, 10 min gültig
```

App installieren (APK aus GitHub Actions Artifact), Server-URL + Code + Gerätename eingeben → Device-Token wird im Keystore verschlüsselt gespeichert. Provider-Keys landen danach NIE auf dem Handy, nur im Server-Vault (Einstellungen → Secrets: `github` PAT mit repo-Scope, `openai`, `zai`, `moonshot`, `anthropic`, `claude_oauth` (setup-token), `junie`).

### Keys vom Laptop hinterlegen

Statt Provider-Keys aufs Handy zu tippen, gehen sie direkt vom Laptop in den Server-Vault: `POST /api/secrets` (Auth: `Authorization: Bearer <PAIRING_ADMIN_TOKEN>`, gleicher Token wie bei `/api/pairing/create` — in `.env` setzen) landet auf demselben Vault-Codepfad wie das `secret.set` der App. Das CLI-Paket `cli/` (`pocketagent-secret`, Node-Builtins only, kein `npm install -g` nötig) macht daraus einen einzeiler:

```bash
export POCKETAGENT_URL=https://orch.example.com
export POCKETAGENT_ADMIN_TOKEN=...   # = PAIRING_ADMIN_TOKEN aus .env

node cli/src/index.ts claude                    # führt `claude setup-token` aus, speichert als claude_oauth
echo sk-... | node cli/src/index.ts openai       # Wert per stdin (pipe)
cat kilo-auth.json | node cli/src/index.ts kilo  # Datei-Inhalt per stdin (Gateway auth.json)
```

Ohne Wert-Argument und ohne Pipe fragt die CLI interaktiv (Eingabe versteckt). `http://` wird nur zu `localhost` akzeptiert, sonst `https://` oder explizit `--insecure-http`.

### 4. Auth-Quellen je Adapter

| Adapter | Secret | Hinweis |
|---|---|---|
| opencode | je Provider API-Key (`zai`, `openai`, `moonshot`, ...) | 75+ Provider via Models.dev |
| kilo | Provider-API-Keys oder `kilo`-Secret (Inhalt der Gateway-`auth.json` → `KILO_AUTH_CONTENT`) | OpenCode-kompatibler Fork mit eigenem Serve-Mode |
| claude | `claude_oauth` = `claude setup-token` (Pro/Max, ~1 Jahr gültig) oder `anthropic` API-Key | Token-Erneuerung auf dem Laptop, dann Secret updaten |
| pi | Provider API-Keys; ZAI/Kimi/Qwen-Subscription-OAuth post-MVP | |
| junie | `junie` API-Key (usage-based) oder BYOK-Keys (openai/anthropic/...) | Headless one-shot; keine Remote-Approvals (App zeigt Banner) |

**Neue Harnesses** (Codex CLI, Aider, eigener Agent, ...) ergänzt man als Plugin ohne Server-/App-Änderung — Anleitung in `ADAPTERS.md`.

## Lokale Entwicklung

```bash
npm install                 # workspaces
npm run typecheck           # alle TS-Pakete
npm run smoke -w server
npm run smoke -w shims/opencode && npm run smoke -w shims/claude && npm run smoke -w shims/pi && npm run smoke -w shims/junie
```

Alle Smokes laufen ohne Docker/Credentials (Fake-Runtimes). Server-Dev: `npm run dev -w server` (DOCKER_ENABLED=0 erlaubt Pairing/Secrets/Repo-Verwaltung ohne Container).

Android: siehe `android/README.md` (lokal + CI; CI-Workflow liegt in `.github/workflows/android.yml`).

## Sicherheit

- Device-Token: nur SHA-256-Hash in der DB; Token im Android Keystore (AES-GCM)
- Provider-Secrets: AES-256-GCM im Vault, MASTER_KEY aus Env; pro Session-Container wird nur das Credential des gewählten Adapters/Providers injiziert
- Session-Container: eigenes Volume, Memory-Limit, per-Session Random-Token für die Shim-API; Yolo-Deny-Liste blockt `git push`/`rm -rf` im Agenten-Kontext (Push läuft nur über den Shim)
- Bekannte Grenze (Single-User akzeptiert): `docker.sock` im Orchestrator = Root-äquivalent; für Multi-Tenant später rootless Runner (siehe Plan). Auf Shared-Hosts (z. B. Coolify mit weiteren Apps) Blast-Radius beachten → RUNBOOK-Sektion Coolify sowie geplante Alternativen (Socket-Proxy, Remote-Runner)

## Status / Verifikation

- Alle 7 TS-Pakete strict-getyped; Fake-Smokes (ohne Docker/Credentials) decken Auth, Event-Normalisierung, Permission-Flow, Auto-Commit, Diff, Abort, Push-Scripte und die Adapter-Registry ab
- **Echte Wire-Formate verifiziert**: opencode 1.18.18 und kilo 7.4.22 Event-/HTTP-Protokolle wurden gegen den Runtime-Quellcode verifiziert und die Normalizer entsprechend gebaut (`{id,type,properties}`-Envelopes, `message.part.delta`, `session.error`/`session.status`, `permission.asked/replied`, `time.completed`, `?directory=`-Routing, `/prompt_async`, Diff-`file`-Key, verschachtelte kilo-Permission-Patterns)
- **Real-Check-Skripte** (`npm run smoke:real`): opencode (echtes `opencode serve`), pi (echtes SDK + Gate-Extension), claude (echtes SDK, deterministischer Fehlerweg ohne Credentials) — Anleitung im `RUNBOOK.md`
- Claude-SDK: Plattform-Binaries (`linux-x64`/`linux-arm64`, 0.3.233) sind als `optionalDependencies` gepinnt und im Lockfile verankert
- Offen: ein finaler `npm run typecheck` + Smoke-Durchlauf in einer Shell (die Ausbau-Session hatte keine Command-Rechte) — exakte Schritte in `RUNBOOK.md` Schritt 1–2; Android-Kompilierung via GitHub-Actions beim ersten Push
