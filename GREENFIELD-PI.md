# Greenfield-Plan: PocketAgent v2 — pi-only Remote Control

Beschlossen (19.08.2026, Robin):

- **Golden Path**: Eine Remote-Control-App für **pi** — Sessions laufen auf dem Server
  (Docker-Container, Coolify) oder auf dem Heim-PC (Link-Agent, outbound WS). Sonst nichts.
- **Echtes Greenfield im Repo**: neue, minimale Struktur; bewährte Bausteine werden gezielt
  kopiert. Der komplette Multi-Adapter-Stand lebt im Tag **`v0.13.0`** und kann später
  wieder angebaut werden.
- **App**: Samsung-One-UI-9-Anmutung „wie jetzt" (Material3-Basis, Pill-Buttons, GroupCards,
  ruhige Statuszeilen — die bestehende Designsprache wird übernommen, nicht neu erfunden).
- **Definition of Done**: die 7-Punkte-Benutzungs-Checkliste (unten), **zweimal in Folge
  komplett grün**, einmal über WLAN, einmal über Mobilfunk. Kein Feature vorher.
- **Umsetzung**: Subagenten — **Opus 5** für protokoll-/nebenläufigkeits-/sicherheitskritische
  Pakete, **Sonnet 5** für gut abgegrenzte. Jedes Paket testet selbst und committet im
  eigenen Worktree; Integration zentral.

## Nicht-Ziele (bewusst raus, leben im Tag v0.13.0)

Kilo-/Claude-/Junie-/Codex-Adapter, Adapter-Registry + Manifest-Plugins, Content-Hash-
Image-Builds, Codex-OAuth (Loopback + Device-Code), Fly-Modus (`DOCKER_HOST` remote),
Gateway/Remote-Runner mit Netzwerk-Policies über zweite Maschine, Multi-Tenant, Web-UI.

## Architektur v2

```
app/ (Android, One UI 9, WSS + FCM)
   ↕ WSS (JSON, Device-Token)                      — Protokoll wie v1, eingedampft
server/ (Orchestrator, Node/TS, pi-only)
   ├─ Docker-Session:  runner/-Image pro Session (pi-SDK embedded)
   └─ Link-Session:    link/ auf dem Heim-PC, outbound WS
```

Die drei strukturellen Vereinfachungen gegenüber v1:

1. **Keine Adapter-Schicht.** pi ist einkompiliert. `adapters.ts`, Manifest-Lader,
   `image-build.ts` (Content-Hash-Builds) entfallen; es gibt **ein** Runner-Image
   (`pocketagent/pi-runner`), gebaut beim Deploy (docker-compose/Coolify), nicht zur Laufzeit.
2. **Shim-Generik entfällt.** Der Runner spricht dasselbe bewährte REST/SSE-Protokoll
   (`POST /prompt`, `/abort`, `/resume`, `/permissions/:id`, `GET /status`, `/diff`,
   `/events` mit `seq`-Replay), aber ohne „welcher Adapter bin ich"-Weichen.
3. **Protokoll minus Multi-Adapter.** `adapter.list`, `AuthFlow`, `session.update{adapter}`,
   Codex-Nachrichten (`auth.*`) entfallen. AgentEvents, Pairing, Link-Protokoll, seq-Dedup
   bleiben unverändert — sie sind der getestete Kern.

## Verzeichnisstruktur

Top-Level-Pfade bleiben stabil (`server/`, `link/`, `android/`, `packages/protocol/`),
damit Coolify-Build (`server/Dockerfile`, Kontext Repo-Root) und die GitHub-Workflows
(`android.yml`, `android-release.yml`, `server.yml`) ohne Infrastruktur-Umbau weiterlaufen.
Neu kommt `runner/`. Greenfield heißt: **die Inhalte** sind neu zusammengesetzt, nicht die
Ordnernamen. `shims/`, `cli/`, `.kilo/` und die Multi-Adapter-Dokumente werden entfernt.

## Übernahme-Landkarte (kopieren → trimmen | neu | weglassen)

### packages/protocol (→ G1.1)
- **Kopieren/Trimmen**: AgentEvent-Typen + seq, WS-Message-Typen, Pairing-Typen,
  Link-Protokoll, SequencedSseBroadcaster, Egress-/Proxy-Helper (aus #57).
- **Weglassen**: AdapterManifest-Typen, AuthFlow, adapter.list-Messages.

### server/ (→ G1.2)
- **Kopieren/Trimmen**: `pairing.ts` (inkl. Lockout/Rate-Limit), `db.ts` (Schema minus
  Adapter-Spalten; `session_events` + Index bleiben), Vault (AES-256-GCM), `ws.ts`
  (minus `adapter.list`/`auth.*`), `sessions.ts` (stark vereinfacht: ein Image, kein
  Adapterwechsel/`reprovisionAdapter`), `docker.ts` (getrimmt), `egress-proxy.ts`
  (bleibt komplett — Netzwerk-Policies sind Kern-Sicherheit), `shim-client.ts`,
  `link-token.ts`, `admin.ts`, `pair.ts`, Idle-Reaper/GC, FCM.
- **Weglassen**: `adapters.ts`, `image-build.ts`, `codex-auth.ts`, `gateway.ts`.
- **Neu**: schlanke `runner.ts`-Konfiguration (ein Image-Name, Env-Zusammenbau aus
  providerEnv-Tabelle von pi — openai/zai/moonshot+kimi/anthropic/google).

### runner/ (→ G1.3, aus shims/pi)
- **Kopieren**: `pi.ts` (SDK-Embedding, tool_call-Approval-Hook), `events.ts`,
  `gitops.ts` (Auto-Commit `agent/<session>`, Push + Draft-PR), `proxy.ts`
  (Egress-Zwang, #57), Dockerfile, Smoke-Test.
- **Trimmen**: adapter.json entfällt; providerEnv/Modi-Mapping wandert als Konstante
  in Runner + Server (eine Quelle, `protocol/` exportiert sie).

### link/ (→ G1.4)
- **Kopieren/Trimmen**: WS-Reconnect, Heartbeat, Event-Queue-Obergrenze, `link-status`.
  `PA_ADAPTER` entfällt — der Link-Agent startet immer den pi-Runner-Code in-process
  auf `PA_WORKDIR`.

### android/ (→ G1.5)
- **Kopieren (bewährt + getestet)**: `data/` fast vollständig — `Protocol.kt` (minus
  AdapterDescriptor/AuthFlow/Codex), `WsClient`, `PairingApi` (inkl. Fehlerdiagnose +
  Retry), `TokenStore`, `ConnectivityWatcher`, `AppRepository` (getrimmt), `CrashLog`/
  `CrashReport`, `UpdateChecker`/`UpdateInstaller`, FCM-Service. `ui/components/Markdown`,
  `ui/screens/Timeline` (Reduktion + Dedup), Theme.
- **Neu zusammengesetzt (One UI 9, aus bestehenden Bausteinen)**: Pairing, SessionList,
  Session (Timeline/Composer/Approval-Karten/Stop), Diff, NewSession (nur Repo/Branch/
  Modus/Provider + Modellkatalog von pi via `session.models`), Settings (Secrets nur
  pi-Provider, Diagnose, App-Update, Gerät).
- **Weglassen**: `CodexOAuth.kt` + zugehörige UI, Adapter-Auswahl, `authFlows`-Rendering.
- **Tests wandern mit**: Timeline/Merge, Markdown, PairingDecode/Failure, WsClient,
  Backoff, AwaitConnected, CrashReport, UpdateChecker, NotificationGrouping,
  TimelineRenderTest (testDebug, Fixture ohne Adapter-Spezifika).
- Version: **0.20.0** (`versionCode` 20) — deutlicher Sprung als Greenfield-Marke;
  gleiche `applicationId` + Signing, damit das Update über den In-App-Updater läuft.

## Arbeitspakete

| Paket | Inhalt | Modell | Abhängig von |
|---|---|---|---|
| **G0 Schnitt** (Orchestrierung, kein Agent) | Tag `v0.13.0` existiert (Release-Fix #61); diesen Plan als `GREENFIELD-PI.md` committen; Alt-Code entfernen (`shims/`, `cli/`, Codex/Fly/Gateway-Dateien + -Doku); Skeleton für `runner/`; README auf v2-Zielbild kürzen | — | #61 gemergt |
| **G1.1 Protocol** | `packages/protocol` eingedampft neu; Contract-Kommentar je Message; providerEnv/Modi-Tabelle als geteilte Konstante; Typ-Tests | **Opus 5** | G0 |
| **G1.2 Server** | Orchestrator pi-only nach Landkarte; Smoke-Suite neu geschnitten (Pairing, WS, Session-Lifecycle mit Docker-Fake, Egress) | **Opus 5** | G1.1 |
| **G1.3 Runner** | pi-Runner nach Landkarte; Dockerfile; Smoke (Protokoll-Roundtrip ohne echten Provider-Key) | **Sonnet 5** | G1.1 |
| **G1.4 Link** | Link-Agent getrimmt; Reconnect-/Queue-Verhalten testbar | **Sonnet 5** | G1.1, G1.3 (Runner-Einbettung) |
| **G1.5 App** | Android nach Landkarte; alle mitwandernden Tests grün; TimelineRenderTest angepasst | **Opus 5** | G1.1 |
| **G2.1 Integration** | docker-compose minimal; `server.yml`-CI angepasst; echter Durchstich Server↔Runner im Smoke; `RUNBOOK-PI.md` (Deploy Coolify, Pairing, Link-Setup, Troubleshooting aus v1 übernommen) | **Opus 5** | G1.2–G1.5 |
| **G2.2 Checkliste** | Release 0.20.0 bauen; Robin spielt die 7-Punkte-Checkliste durch; Funde → Fix-Pakete (Sonnet), bis 2× in Folge grün | Sonnet 5 je Fund | G2.1 |

Reihenfolge: G0 → G1.1 → (G1.2 ∥ G1.3 ∥ G1.5) → G1.4 → G2.1 → G2.2.
Ein Branch, ein PR (`claude/coding-agents-remote-control-e8fnk2`); gemergt wird erst,
wenn Server-Smoke + beide Android-Testvarianten grün sind.

## Definition of Done — die Checkliste

Jede Zeile dreimal hintereinander fehlerfrei, einmal über WLAN, einmal über Mobilfunk;
das Ganze zweimal in Folge:

1. Koppeln (frischer Code) → Session-Liste lädt
2. Session erstellen (pi) → erster Prompt → Antwort kommt an
3. Approval-Karte beantworten (Ask-Modus)
4. Diff ansehen → Push → Draft-PR entsteht
5. App killen, wieder öffnen → Verlauf vollständig, Reconnect ohne Doppel-Events
6. Netzwechsel mitten im Turn → App fängt sich selbst
7. Handy weglegen → Push-Notification bei Approval/Turn-Ende kommt an

## Risiken & Leitplanken

- **pi-SDK ohne echte Keys nur begrenzt testbar** → Smoke prüft Protokoll-Roundtrip und
  Prozess-Lifecycle; der echte Provider-Durchstich ist Teil der Checkliste (G2.2).
- **Coolify-Deploy darf nicht brechen** → `server/Dockerfile`-Pfad + Port 3000 + Env-Namen
  (`MASTER_KEY`, `PAIRING_ADMIN_TOKEN`, …) bleiben identisch; DB-Datei ist neu
  (frisches Volume oder Migration bewusst NICHT nötig: neue Kopplung ist akzeptiert,
  Secrets müssen einmalig neu hinterlegt werden — steht im RUNBOOK-PI).
- **Robolectric**: Testnamen ASCII-only (POSIX-Locale-Falle), Rendering-Tests nur testDebug.
- **Keine stillen Erweiterungen**: Jedes Paket hält sich an die Landkarte; wer etwas
  zusätzlich braucht, meldet es zurück statt es „mitzunehmen".
