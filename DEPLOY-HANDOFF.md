# DEPLOY-HANDOFF: PocketAgent auf Coolify deployen

> Diese Datei ist eine vollständige Übergabe an einen ausführenden Agenten. Sie ist
> self-contained: Alles, was für den Coolify-Deploy nötig ist, steht hier oder ist
> referenziert. Am Ende steht, was zu tun ist, was NICHT zu tun ist und in welcher
> Form zurückberichtet werden soll.

## 1. Mission

PocketAgent (Repo: `https://github.com/robinrehbein/remote-control`, Branch `main`,
Stand: Commit `8010503` oder neuer) soll auf dem bestehenden **Coolify-Server** des
Users so deployt werden, dass die Android-App produktiv koppelbar ist und echte
Agent-Sessions auf GitHub-Repos laufen.

Erfolgskriterium: Pairing mit der App klappt, eine echte Session (Adapter `opencode`)
beantwortet einen Prompt, Approval-Karte erscheint in der App, Diff ist abrufbar.

## 2. Was PocketAgent ist (30 Sekunden)

Provider- und harness-agnostische Mobile-Agent-Plattform — wie Claude Remote
Sessions / Kilo Cloud Sessions, aber selbst gehostet und mit freier Runtime-Wahl:

```
Android-App (Kotlin/Compose; APK: GitHub Release v0.1.0)
   ↕ WSS /ws (JSON, Device-Token) + REST /api/pairing/confirm
ORCHESTRATOR (Node/TS, fastify, SQLite, AES-GCM-Vault, FCM)
   ├─ Adapter-Registry: lädt shims/*/adapter.json Manifeste (Plugin-System)
   ↕ HTTP/SSE pro Session (per-Session Random-Token), Docker-API (docker.sock)
SESSION-CONTAINER (ein Docker-Container + Volume pro Session)
   └─ Adapter-Shim (einheitliches HTTP-Protokoll) um: opencode | kilo | claude | pi | junie
```

Zusätzlicher Modus (nicht Teil dieses Deploys): **Link-Agent** (`link/`) verbindet
einen Devcontainer/PC per outbound-WS als Session — Doku `HOMEPC.md`.

## 3. Repo-Landkarte (nur Relevantes)

| Pfad | Bedeutung |
|---|---|
| `docker-compose.yml` | Orchestrator-Service + 5 Shim-Build-Targets (Profil `shims`) |
| `server/Dockerfile` | Orchestrator-Image; kopiert Adapter-Manifeste nach `/app/adapters/` |
| `shims/<id>/Dockerfile` | je ein Adapter-Image. **Build-Kontext ist IMMER der Repo-Root** (`file:../../packages/protocol`-Dependency!) |
| `.env.example` | Env-Vorlage (MASTER_KEY etc.) |
| `README.md` | Architektur + Deployment-Kurzform |
| `RUNBOOK.md` | Verifikation + Inbetriebnahme (Schritt 4–5 = dieser Deploy) |
| `ADAPTERS.md` | Adapter-Plugin-System (nur lesen, nichts ändern) |
| `FLY.md`, `HOMEPC.md` | alternative Deployments (Fly.io, Devcontainer) — hier irrelevant |

## 4. Bereits verifiziert (nicht wiederholen, nur wissen)

- Alle 8 TS-Pakete `tsc` clean; Fake-Smokes 6/6 grün; Real-Runtime-Checks 3/3
  (echtes `opencode serve` 1.18.18, echtes pi-SDK 0.84.2, echtes Claude-SDK 0.3.233)
- Link-Integrationssmoke grün (Device→Orchestrator→Link→echtes opencode, Prompt beantwortet)
- Android: `assembleDebug` + Unit-Tests lokal grün, GitHub-Actions-CI grün,
  APK im Release v0.1.0
- Offen/ungetestet: die Docker-Image-Builds selbst (kein Docker in der Sandbox) und
  der komplette Coolify-Weg — **das ist genau deine Aufgabe.**

## 5. Deploy-Plan (Coolify)

### Schritt 0 — Repo auf den Server bringen

Auf dem Coolify-Host (SSH-Terminal):

```bash
git clone https://github.com/robinrehbein/remote-control /data/coolify/applications/pocketagent  # Pfad ggf. anpassen
cd /data/coolify/applications/pocketagent
```

Falls der Host nur via Coolify-UI kann: Repo dort klonen und das Terminal der App nutzen.

### Schritt 1 — Images bauen (auf dem Host, einmalig)

```bash
cp .env.example .env
# MASTER_KEY eintragen:
sed -i "s|^MASTER_KEY=.*|MASTER_KEY=$(openssl rand -hex 32)|" .env

docker compose build orchestrator             # Orchestrator-Image (Pflicht)
# Optional: docker compose --profile shims build  # Shims vorbauen (beschleunigt Erst-Start)
```

Die 5 Shim-Images sind seit dem Selfbuild OPTIONAL vorzubauen: Fehlende Images
baut der Orchestrator beim ersten Session-Start eines Agenten selbst aus den im
Orchestrator-Image gebündelten Quellen (Content-Hash-Tags, `ADAPTER_IMAGE_TAG`
dafür NICHT setzen). Wichtig: Build-Kontext ist der Repo-Root (steht so in den
Compose-Build-Definitionen).

Erwartete Build-Fallen (falls sie zuschlagen, beheben und im Report dokumentieren):
- `npm ci`-Fehler in `shims/claude` → Dockerfile hat bereits `npm ci || npm install`-Fallback
- `shims/junie` installiert die Junie-CLI via install.sh — braucht Netzzugang im Build
- Alle shims brauchen `git` im Image (ist in den Dockerfiles)

### Schritt 2 — Orchestrator in Coolify anlegen

Variante 2a (empfohlen, da Compose schon existiert): Coolify → **New Resource →
Docker Compose Empty** mit dem geklonten Repo bzw. Paste von `docker-compose.yml`
(wichtig: Build-Context muss das Repo-Root sein, nicht `server/`). Nur der
Default-Profile wird gestartet — die `shims`-Profile-Services laufen bewusst nicht.

Variante 2b: Coolify **Dockerfile**-App mit `server/Dockerfile` und Root-Context.

Pflicht-Konfiguration in Coolify:
1. **Volume-Mount:** `/var/run/docker.sock:/var/run/docker.sock` (steht in der
   Compose; bei Dockerfile-Apps manuell setzen). Ohne Socket kann der Orchestrator
   keine Session-Container erzeugen (`docker=false` im Health-Endpoint).
2. **Persistente Volume** für `/data` (SQLite + Vault!) — Compose definiert
   `orchestrator-data`; bei Coolify-Apps auf dessen Persistent-Storage-Mapping achten.
3. **Env:** `MASTER_KEY` (aus Schritt 1; NICHT ephemeral lassen — sonst sind nach
   Restart alle Secrets weg!), optional `SESSION_MEM_LIMIT`, `IDLE_STOP_SEC`,
   `GC_DAYS`, `FCM_SERVICE_ACCOUNT_JSON`.
4. **Domain + TLS** auf Port 3000 (Coolify/Traefik übernimmt LE). WS (`/ws`) und
   SSE laufen über den Traefik-Proxy problemlos; keine Special-Config nötig.
5. Health-Check-Path für Coolify: `/api/health`.

### Schritt 3 — Netzwerk-Check

Der Orchestrator legt beim Start das Docker-Netzwerk `pocketagent` an und startet
Session-Container darin (Alias = Session-ID). Das passiert automatisch; nur
verifizieren:

```bash
docker network ls | grep pocketagent     # nach erster Session
docker ps --filter label=pocketagent.session
```

Falls Coolify den Orchestrator in ein isoliertes Netzwerk sperrt (socket-proxy-
Setup o.ä.): der Orchestrator spricht den Daemon über den Socket, nicht über
Netzwerke — ein Constraint besteht nur, wenn Coolify den Socket-Mount verweigert.
Dann Coolify-Doku "docker sock" (mounts sind erlaubt, wenn der Server "localhost
docker" als Ziel hat).

### Schritt 4 — Pairing-Code erzeugen

```bash
# Container-Namen finden (Coolify prefixt):
docker ps --format '{{.Names}}' | grep -i pocketagent
docker exec -it <orchestrator-container> npx tsx src/pair.ts
# → 8-Zeichen-Code, 10 Minuten gültig
```

Der User koppelt in der App (APK aus dem GitHub-Release v0.1.0): Server-URL =
Coolify-Domain, Code, Gerätename.

### Schritt 5 — Secrets in der App befüllen (User-interaktion)

In App → Settings → Secrets, mindestens:
- `github` = fine-grained PAT (Contents: R/W, Pull requests: R/W, auf Ziel-Repos begrenzt)
- Pro gewünschtem Adapter: `zai`/`openai`/`moonshot`/… (API-Key), `claude_oauth`
  (Output von `claude setup-token`), `junie`, `kilo` (Inhalt der Kilo-Gateway-auth.json)

Dann Repo hinzufügen (z. B. ein unkritisches Test-Repo).

## 6. Verifikation nach Deploy (Pflichtprogramm)

1. `curl https://<domain>/api/health` → `{"ok":true,...,"docker":true}` — **docker
   muss `true` sein**, sonst Socket-Mount kaputt.
2. App koppeln (Schritt 4), `server.stats` in Settings zeigt laufende Container-Zahl.
3. **E2E-Session**: Neue Session → Repo, Adapter `opencode`, Provider mit vorhandenem
   Key, Mode `ask` → Prompt senden → Approval-Karte bestätigen → Antwort-Text kommt →
   `turn.completed` mit Commit-SHA → Diff öffnen → (Non-Yolo) Push-Button → Draft-PR
   auf GitHub existiert.
4. Container-Kill-Test: `docker kill <session-container>` → in App „Resume" →
   Zustand (Volume + Session-Ref) ist wieder da.
5. Erwartungsbilder für Fehler: fehlender Provider-Key → sauberes `turn.failed`/
   Error-Event in der App, kein Crash des Orchestrators.

## 7. Known Issues & Grenzen (nicht "reparieren", sondern so lassen)

- **Junie**: keine Remote-Approvals (one-shot CLI) → App zeigt Warnbanner;
  ask/acceptEdits verhalten sich dort wie yolo. By design.
- **Tap-Push** (Non-Yolo) läuft über one-shot-Container mit dem Adapter-Image und
  `pushScriptFor()` aus dem Manifest — funktioniert nur, wenn die Shim-Images auf
  demselben Daemon liegen wie der Orchestrator (hier der Fall).
- **docker.sock = Root-äquivalent**: akzeptiert (Single-User). Keine "Härtung" per
  socket-proxy einbauen, die die Session-Container-Erzeugung bricht.
- FCM ohne `FCM_SERVICE_ACCOUNT_JSON` = Dry-Run (nur Logs). Optional, nicht blockierend.
- Kilo-Gateway-Modelle brauchen das `kilo`-Secret; Provider-Keys laufen direkt.
- Der Orchestrator intentionallysingle-user (tenant "default"). Nicht multi-tenant machen.

## 8. Was der ausführende Agent NICHT tun soll

- Keine Änderungen an `packages/protocol`, Server-Logik oder Shims zur "Verbesserung"
  während des Deploys — nur Build-/Config-Fixes, und diese im Report begründen.
- Kein Force-Push, keine Releases/Tags anfassen. Build-Fixes als normaler Commit auf
  einem Branch + PR oder direkt `main` wenn der User es so will.
- Keine Secrets (PAT, MASTER_KEY, Provider-Keys) in Logs, Commits oder dem Report
  ausweisen — nur Präfixe (`kgh2…`).
- `git push` nur mit `-c http.sslVerify=false` falls die Sandbox/der Host einen
  TLS-MITM-Proxy hat (Repository liegt auf github.com/robinrehbein/remote-control).

## 9. Report-Format zurück an den User

1. Deploy-Weg (2a/2b) + Coolify-Domain
2. Image-Builds: 6/6 gebaut? Abweichungen/Fixes (Datei + Grund, je 1 Zeile)
3. Health-Check-Output (`docker:true`?)
4. Pairing durchgeführt? (Code NICHT reporten, nur "ja")
5. E2E-Session: Adapter, Prompt-Ergebnis, Approval-Durchlauf, Diff, PR-URL
6. Offene Punkte / Empfehlungen

## 10. Quick Reference

| Endpoint | Zweck |
|---|---|
| `GET /api/health` | Health (+ docker-Status) |
| `POST /api/pairing/confirm` | App-Pairing |
| `GET /ws` | App-/Link-WebSocket (erstes Frame: `hello` bzw. `agent.hello`) |

| Env (Orchestrator) | Default | Bedeutung |
|---|---|---|
| `MASTER_KEY` | — (PFLICHT) | AES-GCM-Vault-Master |
| `DATA_DIR` | ./data | SQLite+Vault (Container: /data) |
| `SESSION_MEM_LIMIT` | 2g | RAM-Limit pro Session-Container |
| `IDLE_STOP_SEC` | 900 | Idle → Container-Stop |
| `GC_DAYS` | 14 | Sessions+Volumes löschen nach X Tagen |
| `ADAPTER_IMAGE_PREFIX` | pocketagent | Image-Namensschema |
| `NETWORK_NAME` | pocketagent | Docker-Netz der Session-Container |
| `FCM_SERVICE_ACCOUNT_JSON` | — | optional, Push-Notifications |

Log-Tail: `docker logs -f <orchestrator-container>` — Pairing-CLI: `npx tsx src/pair.ts`
im Container. Link-Token-CLI (falls User später Devcontainer anbinden will):
`npx tsx src/link-token.ts -- --name devcontainer`.
