# PocketAgent

Provider-agnostische Mobile-Agent-Plattform: Steuerung von Coding-Agenten (**Kilo Code, Claude Code, pi, Junie, OpenAI Codex** — und jedem weiteren Harness als Plugin, siehe `ADAPTERS.md`) per Android-App; die Agenten arbeiten isoliert in Docker-Containern auf deinem Server (z. B. Coolify-VPS) direkt auf deinen GitHub-Repos. Wie Claude Remote Sessions / Kilo Cloud Sessions — aber harness- und provider-agnostisch.

```
Android (Kotlin/Compose, WS + FCM)
   ↕ WSS (JSON, Device-Token)
Orchestrator (Node/TS auf deinem Server, docker.sock)
   ├─ Adapter-Registry: lädt shims/*/adapter.json Manifeste (Plugins!)
   ↕ HTTP/SSE pro Session (Random-Token)
Adapter-Shims in Session-Containern (einheitliches Protokoll)
   ├─ kilo-shim      → kilo serve (Kilo CLI, OpenCode-Fork, 75+ Provider via Models.dev)
   ├─ claude-shim    → Claude Agent SDK (Pro/Max-Subscription via setup-token)
   ├─ pi-shim        → pi SDK (ZAI/Kimi/Qwen-Kataloge, Remote-Approvals)
   ├─ junie-shim     → Junie CLI headless (BYOK)
   └─ codex-shim     → codex app-server (JSON-RPC/stdio, OPENAI_API_KEY + Device-Code)
```

## Monorepo

| Pfad | Inhalt |
|---|---|
| `packages/protocol/` | Geteilter Contract: Shim-REST-API, normierter Event-Stream, WS-Nachrichten, Pairing, Adapter-Manifest-Typen (pure TS-Typen) |
| `server/` | Orchestrator: SQLite, Vault (AES-256-GCM), **Adapter-Registry (Manifest-Plugins)**, Docker-Lifecycle, SSE→WS-Weiterleitung, Pairing, FCM, Idle-Reaper, GC |
| `shims/kilo/` | Kilo-CLI-Adapter (Proxy auf `kilo serve`, OpenCode-kompatibler Fork) |
| `shims/claude/` | Claude-Code-Adapter (Agent SDK, `CLAUDE_CODE_OAUTH_TOKEN`) |
| `shims/pi/` | pi-Adapter (SDK-Embedding, Approvals via `tool_call`-Hook) |
| `shims/junie/` | Junie-Adapter (CLI-Spawn pro Prompt, JSON-Output) |
| `shims/codex/` | OpenAI-Codex-Adapter (`codex app-server` als Child-Prozess, JSON-RPC über stdio, Thread/Turn + Approvals) |
| `android/` | Native App (Kotlin, Jetpack Compose, Material3) — Adapterliste kommt dynamisch vom Server; CI baut das APK via GitHub Actions |
| `link/` | **Link-Agent**: läuft in deinem Devcontainer/PC/VPS, verbindet sich per outbound-WebSocket mit dem Orchestrator und stellt deinen Live-Workspace als Session bereit (siehe `HOMEPC.md`) |
| `ADAPTERS.md` | Plugin-Guide: Manifest-Schema + Harness in 5 Schritten hinzufügen |

Jeder Shim implementiert dasselbe Protokoll: `POST /prompt`, `POST /abort`, `POST /resume`, `POST /permissions/:id`, `GET /status`, `GET /diff`, `GET /events` (SSE mit normierten `AgentEvent`s). Nach jedem Turn auto-committet der Shim auf `agent/<session-id>`; im Yolo-Modus wird automatisch gepusht + Draft-PR geöffnet, sonst per Tap in der App.

## Modi

| Modus | Verhalten |
|---|---|
| Yolo | Keine Gates; Auto-Push + Draft-PR pro Turn (Codex: `never` + `danger-full-access`) |
| Auto | Kilo `--auto`, Claude `auto`, pi: nur risky Bash gegated, Junie: ohne Gates (Codex: `never` + `workspace-write` + Netz) |
| AcceptEdits | Edits frei, Bash fragt (kilo/claude/pi; Codex: `on-request`, File-Changes auto-accept, Commands fragen; Junie: Warnbanner, ohne Gates) |
| Ask | Alles Wichtige fragt → Approval-Karte in der App (Codex: `untrusted`, alles fragt; Junie: Warnbanner, ohne Gates) |

## Deployment (Coolify / Docker-Host)

### 1. Orchestrator-Image bauen (aus dem Repo-Root)

```bash
docker build -f server/Dockerfile -t pocketagent/orchestrator:latest .
```

**Shim-Images müssen nicht mehr manuell gebaut werden:** Der Orchestrator
bündelt die Shim-Quellen und baut fehlende Images beim ersten Session-Start
eines Agenten selbst über die Docker-API (die App zeigt währenddessen einen
Hinweis; Erst-Build dauert einige Minuten). Ohne `ADAPTER_IMAGE_TAG` werden
Content-Hash-Tags verwendet — nach jedem Deploy mit geänderten Shim-Quellen
wird automatisch neu gebaut. Wer trotzdem vorbauen will (z. B. um den
Erst-Start zu beschleunigen): `docker compose --profile shims build`.

Wichtig: Build-Kontext ist immer der Repo-Root (`.`), weil die Shims und der Server per `file:`-Dependency `packages/protocol` einbinden.

**Image-Pinning (Supply Chain):** Standardmäßig nutzt der Orchestrator
`<ADAPTER_IMAGE_PREFIX>/<id>-shim:c<hash>` (Content-Hash der gebündelten
Quellen, siehe `.env.example`). Für reproduzierbare Deploys zwei Möglichkeiten:

- global per Env: `ADAPTER_IMAGE_TAG=2026-08-15` (oder ein CI-Build-Tag) pinnen
- pro Adapter per Manifest: `"image": "ghcr.io/owner/kilo-shim@sha256:<digest>"`
  in `shims/<id>/adapter.json` — ein Digest überschreibt Prefix/Tag komplett
  (Registry-Modus, Images werden dann automatisch gepullt).

### 2. Orchestrator starten

```bash
cp .env.example .env    # MASTER_KEY setzen: openssl rand -hex 32
docker compose up -d
```

Der Orchestrator mountet `docker.sock` (startet/stoppt Session-Container), legt SQLite + Vault in `orchestrator-data` ab und lauscht auf `:3000`. In Coolify: als App via Dockerfile/Compose deployen, Domain + TLS davor schalten.

**Alternative Fly.io** (Orchestrator auf Fly, Container auf deinem Docker-Host via `DOCKER_HOST`): Anleitung in `FLY.md` — der Server unterstützt beide Modi ohne Codeänderung.

### 3. Pairing

```bash
docker exec -it pocketagent-orchestrator node dist/pair.js
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
| kilo | Provider-API-Keys oder `kilo`-Secret (Inhalt der Gateway-`auth.json` → `KILO_AUTH_CONTENT`) | OpenCode-kompatibler Fork; 75+ Provider via Models.dev |
| claude | `claude_oauth` = `claude setup-token` (Pro/Max, ~1 Jahr gültig) oder `anthropic` API-Key | Token-Erneuerung auf dem Laptop, dann Secret updaten |
| pi | Provider API-Keys; ZAI/Kimi/Qwen-Subscription-OAuth post-MVP | |
| junie | `junie` API-Key (usage-based) oder BYOK-Keys (openai/anthropic/...) | Headless one-shot; keine Remote-Approvals (App zeigt Banner) |
| codex | `openai` API-Key (`OPENAI_API_KEY`, BYOK) oder ChatGPT-Login via Device-Code (`codex login --device-auth`) | `CODEX_HOME` als beschreibbares Volume (Token-Refresh, Thread-Resume); voller In-App-Browser-OAuth folgt in W3.4 |

Anzeigenamen, Key-Seiten und Einrichtungshinweise stehen im Manifest (`providers`-Feld in `shims/*/adapter.json`) — die App rendert daraus die Provider-Chips und im Zugang-Dialog einen „Key erstellen"-Link, statt eine eigene Tabelle zu pflegen.

**Key prüfen:** Der Dialog hat neben „Speichern" ein „Prüfen", das den Key serverseitig gegen den Anbieter testet (ein billiger Read-Only-Call, 8 s Timeout, Wert wird nie geloggt oder gespeichert). Live-Prüfung gibt es für `openai`, `anthropic`, `groq`, `openrouter`, `moonshot`/`kimi`, `google`, `xai` und `github`; alle übrigen Arten (u. a. `zai`, `claude_oauth`, `junie`, `kilo`) melden neutral „keine Live-Prüfung" und lassen sich trotzdem speichern.

**Neue Harnesses** (Aider, eigener Agent, ...) ergänzt man als Plugin ohne Server-/App-Änderung — Anleitung in `ADAPTERS.md`.

## Lokale Entwicklung

```bash
npm install                 # workspaces
npm run typecheck           # alle TS-Pakete
npm run smoke -w server
npm run smoke -w shims/kilo && npm run smoke -w shims/claude && npm run smoke -w shims/pi && npm run smoke -w shims/junie && npm run smoke -w shims/codex
```

Alle Smokes laufen ohne Docker/Credentials (Fake-Runtimes). Server-Dev: `npm run dev -w server` (DOCKER_ENABLED=0 erlaubt Pairing/Secrets/Repo-Verwaltung ohne Container).

Android: siehe `android/README.md` (lokal + CI; CI-Workflow liegt in `.github/workflows/android.yml`).

## Sicherheit

- Device-Token: nur SHA-256-Hash in der DB; Token im Android Keystore (AES-GCM)
- Provider-Secrets: AES-256-GCM im Vault, MASTER_KEY aus Env; pro Session-Container wird nur das Credential des gewählten Adapters/Providers injiziert
- **Egress-Proxy**: jeder Request wird einer Session zugeordnet — über die Quell-IP des Containers (Docker-Daemon) oder das Per-Session-Shim-Token (`Proxy-Authorization: Bearer/Basic`); ohne beides → 407. Danach entscheidet die Policy der Session: `isolated` kommt **nie** durch (403), `allowlist` nur zu Allowlist-Hosts auf Port 80/443. Nach der DNS-Auflösung werden private, Loopback-, Link-Local- und ULA-Adressen geblockt (SSRF/DNS-Rebinding) und die Verbindung auf genau die geprüften IPs gepinnt — ohne zweite Auflösung, der Reihe nach (IPv4 vor IPv6) bis eine Adresse antwortet, sonst 502 mit Logzeile; hop-by-hop-Header (u. a. `Proxy-Authorization`) gehen nie an den Upstream. Im Remote-Gateway-Modus gelten dieselben Gates: der Orchestrator pusht die Session-Tabelle über den authentifizierten Ingress an den Gateway.
- Session-Container: eigenes Volume, Memory-/CPU-Limit, readonly Rootfs, per-Session Random-Token für die Shim-API
- **Ehrlich über die Grenzen** (Details: `SECURITY.md`):
  - Die Yolo-Deny-Liste (`git push`/`rm -rf` im Agenten-Kontext) ist **advisory und umgehbar** — kein Sicherheitskontrolle. Echter Netzwerk-Enforcement gibt es nur über networkPolicy `allowlist`/`isolated` (interner Docker-Netzwerk + Egress-Proxy).
  - Provider-API-Keys sind **by design im Agenten-Prozess sichtbar** (gleiche uid im Session-Container) — benanntes Restrisiko: ein kompromittierter Agent-Prozess kann den eigenen Provider-Key lesen.
  - Der GitHub-PAT wird **nicht mehr** als Container-Env oder in `.git/config` gesetzt, sondern vor dem Start als nur-lesbare Creds-Datei injiziert (`PA_CREDS_FILE=/run/secrets/pa/creds.json`, uid 1000, mode 0400) — bleibt aber weiterhin für Prozesse mit derselben uid lesbar (benanntes Restrisiko).
  - `docker.sock` im Orchestrator = Root-äquivalent (Single-User akzeptiert); für Multi-Tenant später rootless Runner.
  - Remote-/Fly-Modus: Shim-Traffic läuft **plaintext** über `DOCKER_ADDR` (published Ports), außer du tunnelst (SSH/WireGuard — siehe `FLY.md`); Remote-Sessions mit `networkPolicy 'open'` erfordern explizit `REMOTE_NETWORK_OPEN=1`, `allowlist`/`isolated` gehen nur mit lokalem Socket.

## Migration: bestehende Session-Volumes

Ältere Session-Volumes wurden **root-owned** erstellt; neue Shim-Images laufen als `node` (uid 1000). Alte Sessions lassen sich daher nicht resumen. Entweder die Volumes löschen (das Work wird beim nächsten Session-Start neu geklont):

```bash
docker volume rm pocketagent-sess-*
```

oder einmalig an uid 1000 übergeben:

```bash
for v in $(docker volume ls -q --filter name=pocketagent-sess-); do
  docker run --rm -v "$v:/w" alpine chown -R 1000:1000 /w
done
```

## Status / Verifikation

- Alle 8 TS-Pakete strict-getyped; Fake-Smokes (ohne Docker/Credentials) decken Auth, Event-Normalisierung, Permission-Flow, Auto-Commit, Diff, Abort, Push-Scripte und die Adapter-Registry ab
- **Echte Wire-Formate verifiziert**: kilo 7.4.22 Event-/HTTP-Protokolle (OpenCode-kompatibler Fork) wurden gegen den Runtime-Quellcode verifiziert und die Normalizer entsprechend gebaut (`{id,type,properties}`-Envelopes, `message.part.delta`, `session.error`/`session.status`, `permission.asked/replied`, `time.completed`, `?directory=`-Routing, `/prompt_async`, Diff-`file`-Key, verschachtelte kilo-Permission-Patterns)
- **Real-Check-Skripte** (`npm run smoke:real`): pi (echtes SDK + Gate-Extension), claude (echtes SDK, deterministischer Fehlerweg ohne Credentials) — Anleitung im `RUNBOOK.md`
- Claude-SDK: Plattform-Binaries (`linux-x64`/`linux-arm64`, 0.3.233) sind als `optionalDependencies` gepinnt und im Lockfile verankert
- Offen: ein finaler `npm run typecheck` + Smoke-Durchlauf in einer Shell (die Ausbau-Session hatte keine Command-Rechte) — exakte Schritte in `RUNBOOK.md` Schritt 1–2; Android-Kompilierung via GitHub-Actions beim ersten Push
