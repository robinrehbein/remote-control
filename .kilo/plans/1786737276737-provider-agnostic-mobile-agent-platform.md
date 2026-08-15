# Provider-agnostische Mobile Agent-Plattform ("PocketAgent")

Claude-Remote-Sessions / Kilo-Cloud-Sessions-Äquivalent: native Android-App steuert Coding-Agenten (OpenCode/Kilo, pi, Claude Code, Junie) auf eigenem Coolify-VPS; Agenten arbeiten isoliert in Docker-Containern auf GitHub-Repos. Personal-Tool jetzt, kommerziell später möglich.

## Entscheidungen (vom User bestätigt)

| Thema | Entscheidung |
|---|---|
| Scope | Single-User-MVP, `tenant_id` im Datenmodell ab Tag 1, kein Billing/Onboarding |
| Runtimes | **Harness-agnostische Plugin-Architektur**: Adapter = Manifest (`shims/*/adapter.json`) statt Code; Server-Registry + `adapter.list` an die App. Mitgeliefert: OpenCode, **Kilo Code** (`kilo serve`, OpenCode-Fork), Claude Code (Pro/Max via setup-token), pi (ZAI/Kimi/Qwen), Junie (BYOK/API-Key). Neue Harnesses als Drop-in (siehe ADAPTERS.md) |
| Sequenz | OpenCode **zuerst end-to-end**, dann Claude-Adapter, dann pi-Adapter – vor App-Polish |
| Infra | Coolify-VPS, Orchestrator-Container mit `docker.sock`, Container+Volume pro Session |
| Lifecycle | `creating→running→idle→stopped`, Idle-Stop nach ~15 Min, Resume über Volume + Runtime-Session (`--resume`/Session-ID), GC nach konfigurierbaren Tagen |
| Git | GitHub via fine-grained PAT. Branch `agent/<session-id>`, Auto-Commit pro Turn (lokal). **Yolo = Auto-Push + Draft-PR**; andere Modi: Push/PR nur per Tap in der App |
| Modi | Yolo / Auto / AcceptEdits / Ask (Mapping-Tabelle unten) |
| App | Native Kotlin + Jetpack Compose, FCM (High-Priority) für `permission.request`, `turn.completed`, `error` |
| Netz | Öffentlicher Endpoint hinter Coolify (TLS) + Device-Token; Pairing via QR/Code |
| Secrets | AES/libsodium-verschlüsselt in DB, Master-Key aus Coolify-Env, Injection nur des gewählten Provider-Creds pro Container. Phone hält NIE Provider-Keys. MVP: API-Keys + Claude setup-token; pi-OAuth-Subscription-Flows (ZAI/Kimi-Pläne) post-MVP |

## Architektur

```
Android (Kotlin/Compose, WS-Client + FCM)
   ↕ WSS (JSON, Device-Token)
Orchestrator (TypeScript/Node, Coolify-Container)
  ├─ Docker-API (dockerode): Session-Container-Lifecycle, Volumes, GC
  ├─ SQLite (Drizzle): tenants, devices, repos, sessions, events, secrets
  ├─ Vault (libsodium sealed box, MASTER_KEY aus Env)
  ├─ GitHub (PAT): clone, auto-commit, push, Draft-PR
  └─ FCM-Sender
   ↕ HTTP pro Session-Container (per-Session Random-Token)
Adapter-Shim im Container (einheitliches Protokoll, siehe unten)
   ├─ opencode-shim  → Proxy auf `opencode serve` (port intern)
   ├─ claude-shim    → Claude Agent SDK (TS), stream-json, setup-token
   ├─ pi-shim        → pi SDK (`createAgentSession`), RPC/SDK-Embedding
   └─ junie-shim     → Junie CLI headless (one-shot `junie --output-format json` pro Prompt, Prozess-Spawn)
```

Monorepo: `server/`, `shims/{opencode,claude,pi,junie}/` (je Dockerfile, gepinnt), `android/`, `packages/protocol/` (geteilte TS-Typen + JSON-Schema des Event-Streams).

## Einheitliches Shim-Protokoll (Version v1, eigenes API)

- `POST /prompt` `{text, mode?, provider?, model?}`
- `GET /events` (SSE): normierte Events: `message.delta`, `tool.call`, `tool.result`, `permission.request{id,kind,payload}`, `permission.resolved`, `turn.completed{summary}`, `error`, `status{provider,model,mode,sessionRef}`
- `POST /permissions/:id` `{response: once|always|reject}`
- `POST /abort`, `GET /diff` (gesamte Session), `GET /status`, `POST /resume{sessionRef}`
- Shim committet nach jedem Turn automatisch auf `agent/<session-id>`; Yolo: Shim pushed + Draft-PR (PAT injected), sonst Orchestrator auf App-Tap.

### Modus-Mapping

| App-Modus | OpenCode | Claude Code | pi | Junie |
|---|---|---|---|---|
| Yolo | `permission: {"*":"allow"}` | `--permission-mode bypassPermissions` | Auto-Approve-Config (Spike) | Headless-Run ohne Gates (non-interactive fragt nie) |
| Auto | `--auto` (ask→auto, deny bleibt) | `--permission-mode auto` | Spike | wie Yolo |
| AcceptEdits | `{edit:"allow", bash:"ask"}` | `--permission-mode acceptEdits` | Spike | wie Yolo + Warning-Event (Granularität nicht verfügbar) |
| Ask | `{"*":"ask"}` | `--permission-mode default` | Spike | wie Yolo + Warning-Event: App zeigt Banner "Junie: keine Remote-Approvals" |

## Datenmodell (SQLite, alles mit `tenant_id`)

`tenants`, `devices(id, token_hash, enrolled_at)`, `secrets(id, kind[openai|zai|moonshot|github|claude_oauth|...], ciphertext, nonce)`, `repos(id, pat_secret_ref, owner/name, default_branch)`, `sessions(id, repo_id, adapter, provider, model, mode, status, branch, container_ref, volume_ref, created_at, last_active_at)`, `session_events(id, session_id, type, payload, ts)`.

## Android-App (Compose)

Screens: Pairing (QR), Session-Liste (Status, Adapter/Model-Badges), Session-Chat (Event-Timeline: Text, Tool-Karten, Diff-Viewer), Approval-Bottom-Sheet (Command/Diff-Vorschau, once/always/reject), Neue Session (Repo-, Adapter-, Provider-, Model-, Modus-Wähler), Settings (Secrets erfassen, Idle-Timeout, Server-Status). WS-Client mit Reconnect/Backoff, FCM-Service → Deep-Link auf Session + Approval. Device-Token im Android Keystore.

## Build-Reihenfolge (Implementierung)

1. Monorepo + `packages/protocol` (Event-Schema, Shim-API-Typen)
2. `opencode-shim` (Proxy + Event-Normalisierung + Auto-Commit + Mode-Mapping) + Image
3. Orchestrator-Kern: DB, Vault, Docker-Lifecycle (create/start/stop/GC), WS-API, GitHub clone/commit, FCM-Stub, Pairing
4. Android-App Kern: Pairing, Session-Liste, Chat, Approvals, FCM → **Meilenstein: komplette Vertikale mit OpenCode**
5. `claude-shim` (Agent SDK, setup-token, Modus-Mapping)
6. `pi-shim` (SDK-Embedding; Spike: Remote-Approval-Flow, sonst Modus-Mapping reduzieren)
7. `junie-shim` (CLI-Spawn pro Prompt, JSON-Output-Normalisierung, BYOK-Env-Mapping, Approval-Degradation)
8. Yolo Auto-Push + Draft-PR, Diff-Viewer-Polish, Resume/Idle-Stop/GC-Härtung
9. Härtung: Rate-Limit, Audit-Log, Vault-Backup, Adapter-Image-Update-Pinning, `mem_limit` pro Container (max. 2–3 parallele Sessions je VPS-RAM)

## Validation

- E2E-Skript: Pairing → Session auf Demo-Repo → Prompt → Bash-Approval im Ask-Modus → Diff prüfen → Tap-Push → PR existiert
- Modus-Matrix pro Adapter (4 Modi × 4 Adapter)
- Container-Kill mitten im Turn → Resume → Diff/Session intakt (Auto-Commit-Netz)
- FCM-Push bei `permission.request` mit App im Hintergrund
- Secret-Audit: kein Provider-Key im App-Storage; Container-Env enthält nur Cred des gewählten Providers; `auth.json` 0600

## Risiken / Offene Punkte

- **Finale Verifikation ausständig**: Letzte Welle (echte Wire-Format-Fixes opencode/kilo, claude-Busy-Fix + Plattform-Binary-Pinning, pi/claude/opencode smoke:real-Skripte) entstand in einer Session ohne Shell-Rechte — manuell reviewed, aber ohne tsc/smoke-Durchlauf. RUNBOOK.md Schritt 1–2 nachziehen.
- **OpenCode-API-Stabilität**: Permission-Respond-Route teils deprecated → SSE-Event-Bus nutzen; Version pinnen (erfolgt: 1.18.18; Wire-Format gegen Source verifiziert)
- **Kilo**: Gateway-Modelle brauchen `kilo`-Secret (auth.json-Inhalt → KILO_AUTH_CONTENT); Wire-Format gegen kilo 7.4.22 Source verifiziert (nested permission patterns, `?directory=`-Routing, `/prompt_async`)
- **Junie-Headless**: one-shot pro Prompt → Turn-Granularität, keine Permission-Callbacks → Ask/AcceptEdits degradieren auf Yolo mit App-Banner; JSON-Output-Format defensiv geparsed
- **pi Remote-Approvals**: Spike positiv – `pi.on("tool_call")` Extension-Hook kann blocken → implementiert; Real-SDK-Boot gegen 0.84.2 verifiziert
- **Claude-Subscription**: programmatische Nutzung läuft über Subscription-Limits (Stand Juni 2026); Token-Ablauf ~1 Jahr → Renewal-Erinnerung in App. Plattform-Binaries als optionalDependencies gepinnt (0.3.233)
- **Docker-Socket = Root-äquivalent**: akzeptabel für Single-User eigenem Server; für kommerzielle Variante auf rootless/VM-isolierte Runner migrieren (out of scope)
- Codex-Adapter (`codex exec --json`) als später sechster Adapter vorgemerkt; kommerzielle Variante: GitHub App statt PAT, Multi-Tenant-Isolation, Billing-Hooks – out of scope
