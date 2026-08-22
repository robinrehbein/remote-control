# Fly-Sessions: Produktive Agent-Sandbox für PocketAgent v2

## Ziel

Drittes Session-Ziel **Fly.io** (MicroVM je Session) für den Produktiv-Einsatz.
Isolationsziel: **Host weg vom Agent** — Agent-Workloads laufen nicht mehr auf
dem Coolify-VPS. Coolify bleibt Testumgebung, Heim-PC-Link bleibt unverändert.

## Getroffene Entscheidungen (mit Robin, 22.08.2026)

1. **v2 erweitern**, kein Neubau. Fly-Modus von v1 (DOCKER_HOST remote,
   Plaintext-HTTP) bleibt weiter im Tag `v0.13.0` — wird NICHT wiederbelebt.
2. **Dial-Home via Link-Protokoll**: Fly-Machine läuft link-Agent mit
   eingebettetem pi-Runner (`link/src/runner-embed.ts` als Vorlage), verbindet
   sich per outbound WSS. Kein eingehender Port, keine öffentliche Machine-URL.
3. **Egress dreistufig pro Session** wie `NETWORK_POLICY` heute:
   `open` / `allowlist` (begrenzt) / `isolated`. Wie bei Claude Code.
4. **Image via ghcr-Push**: Orchestrator baut das Runner-Image (Tag-Trigger wie
   heute `RUNNER_IMAGE_TAG`) und pusht es einmalig nach ghcr.io. Pro Session
   wird nur eine Machine vom digest-gepinnten Image erzeugt → Sekunden.
5. **Secrets: Vault → Machine-Env** beim Provisioning. Fly-App-Secrets nur für
   statische Infra (ghcr-Pull-Token). Vault bleibt Source of Truth.
6. **Lifecycle: Idle→Stop** (Abrechnung pausiert), **Session-Ende/GC→Destroy**.
   Deckel: `FLY_MAX_MACHINES` (Default 3).
7. **App: Zielwahl im NewSession-Screen** — „Heim-PC / Coolify (Test) /
   Fly (Produktion)", Default Fly; bei Fly zusätzlich Policy-Wahl.

## Architektur

```
Session-Ziel (session.create.target):
  docker  → wie heute (Coolify, Test)
  link    → wie heute (Heim-PC, outbound WS)
  fly     → NEU: Orchestrator erzeugt Fly-Machine über Machines-API
            Machine-Image = <prefix>/fly-runner:<tag> (ghcr, digest-pinned)
            Entrypoint = link-Agent (PA_SERVER, PA_TOKEN=frischer Link-Token)
            Machine-Volume /work (persistiert über Idle-Stop, GC löscht)
```

Eine Fly-Session ist intern eine **Link-Session mit Auto-Provisioning**: neue
Tabelle/Spalte `fly_machine_id`, frischer Link-Token pro Session (nicht
app-weit) → Revocation = Token löschen + Machine destroyen.

## Arbeitspakete

### F1 Protocol (`packages/protocol`)
- `session.create` um `target: 'docker' | 'link' | 'fly'` erweitern
  (Default `docker`, Abwärtskompat: fehlt → docker; `linkId` gesetzt → link).
- `SessionInfo` um `target` + `flyMachineId?` ergänzen; `linked` bleibt als
  Alias (App-Migration später), Server füllt beide.
- Provisioning-Events für den Session-Status (Machine wird erzeugt → bootet →
  verbunden), analog zur Image-Build-Fortschrittskarte.
- Typ-Tests erweitern.

### F2 Server: Fly-Provider (`server/src/fly.ts`, neu)
- Schlanker **Machines-API-HTTP-Client** (fetch, kein flyctl im Image):
  create/stop/start/destroy/list Machines, Status-Polling. Token: Secret
  `FLY_API_TOKEN` im Vault (via App hinterlegbar).
- Einmaliges Ensure der Fly-App (`pocketagent-sessions`) bei erster Session.
- `ensureFlyRunnerImage`: Build wiederverwenden, Push nach ghcr bei Tag-Wechsel
  (Secret `GHCR_PUSH_TOKEN`, write:packages). `FLY_IMAGE`-Env überschreibt
  (Registry-only-Modus, wie `RUNNER_IMAGE` heute).
- `createFlySession`: Machine mit Env `PA_SERVER`, `PA_TOKEN` (frisch),
  Provider-Keys + `GITHUB_PAT` aus Vault, `PA_MODE`, `PA_WORKDIR=/work`,
  Volume `/work`, Policy-abhängige Proxy-Env (siehe F3); Boot-Wait mit Timeout.
- Lifecycle: Idle-Reaper um „Fly-Machine stoppen" erweitern (Status
  `provisioning|running|stopped`), Resume = Machine starten (~5 s Boot),
  GC zerstört Machine + Volume + Link-Token. `FLY_MAX_MACHINES`-Deckel vor
  Provisioning prüfen.
- `sessions.ts`/`ws.ts`: `target` durchreichen, Status-Mapping
  Machine-State → `SessionStatus` (`stopped` = Machine gestoppt/hibernating).
- Ephemeral vs. Volume: **Volume je Machine** (`fly_mounts`), sonst ginge der
  Repo-/Session-State beim Idle-Stop verloren.

### F3 Server: öffentlicher Egress-Proxy-Endpoint
- `egress-proxy.ts` um authentifizierten öffentlichen Pfad erweitern:
  Bearer **Session-Proxy-Token** (Random, pro Fly-Session erzeugt, in DB),
  weiterleiten über Traefik (Port 3000 ist schon da). Gleiche Allowlist-Engine
  wie intern (`NETWORK_ALLOWLIST`).
- Policy-Mapping für Fly-Machines: `open` → keine Proxy-Env;
  `allowlist` → `HTTPS_PROXY=https://orchestrator…/egress/<token>`;
  `isolated` → keine Proxy-Env + kein further egress (Machine kann nur WSS
  nach Hause; Dokumentation: echte Isolation via fehlender Route, Rest ist
  Best-Effort wie heute).

### F4 Fly-Runner-Image (`runner/Dockerfile.fly`, Kontext Repo-Root)
- Node slim + `packages/protocol/` + `runner/` + `link/`, Entrypoint =
  link-Agent. Repo-Clone beim Start nach `/work` (gitops unverändert:
  `agent/<session>`-Branch, Push + Draft-PR).
- Bekanntes Delta dokumentieren: GitHub-PAT auf Fly als Env statt
  `/run/secrets/pa/`-Datei (prozeslesbar wie eh, same-uid-Design).
- docker-compose-Profil `fly-runner` zum lokalen Bauen/Testen.

### F5 Android-App
- NewSession: Zielwahl (Segmented), Fly default; Policy-Auswahl nur bei Fly;
  Heim-PC nur wählbar, wenn Link online.
- Session-Liste/Detail: Ziel-Badge (Link/Docker/Fly), Fly-Provisioning-Karte
  (Status „Machine wird erzeugt / bootet / verbunden").
- `Protocol.kt`: `target` + neue Events; Tests (NewSession-Zielwahl,
  Status-Mapping, Policy-Durchreichung).

### F6 Integration, Runbook, Smoke
- `RUNBOOK-PI.md`: Fly-Abschnitt — `FLY_API_TOKEN`, `GHCR_PUSH_TOKEN`,
  ghcr-Pull-Secret einmalig, erster Image-Push dauert Minuten, danach
  Provisioning in Sekunden; Kosten-Deckel; Troubleshooting (Machine stuck,
  App limit).
- Smoke-Suite: Fake-Machines-API (create/stop/destroy, Deckel, Policy-Env je
  Stufe, Idle→Stop, GC→Destroy); E2E-Checkliste (GREENFIELD-PI.md) um
  Fly-Punkte erweitern: Session auf Fly → Prompt → Approval → Diff → Push/
  Draft-PR; Idle-Stop → Resume ohne Session-Verlust; Destroy bei GC.
- `.env.example` + RUNBOOK: neue Envs `FLY_API_TOKEN`, `FLY_APP_NAME`,
  `FLY_MAX_MACHINES=3`, `FLY_IMAGE` (optional), `GHCR_PUSH_TOKEN`.

## Risiken / bewusste Deltas
- **PAT als Machine-Env** statt Secret-Datei: dokumentiert, prozeslesbar wie
  bei Docker-Sessions (same-uid) — kein neues Risiko, nur kein Datei-Mount.
- **Boot-Kaltstart nach Idle-Stop (~5 s)**: App zeigt „Agent startet…".
- **Allowlist-Policy geht über Orchestrator**: Latenz + Verfügbarkeit des
  Coolify-VPS wird zum Faktor für `allowlist`-Sessions (nicht für `open`).
- **Kosten**: Deckel `FLY_MAX_MACHINES`; Idle-Stop pausiert Abrechnung.
- Machines-API ohne SDK: eigenes kleines Client-Modul mit Tests gegen Fake.

## Validierung
- `npm run typecheck`, `npm test`, `npm run smoke:server` (erweitert),
  `npm run smoke:link`, Android: `:app:testDebugUnitTest :app:testReleaseUnitTest`.
- E2E gemäß erweiterter Checkliste, je einmal WLAN + Mobilfunk.

## Reihenfolge
F1 → F2 ∥ F4 → F3 → F5 → F6. Ein Branch, ein PR; Merge erst wenn Server-Smoke
inkl. Fly-Fake und beide Android-Testvarianten grün sind.

## Out of Scope
- Coolify-Orchestrator härten (sock-Pflicht-Proxy, Rootless) — separater Plan.
- Mehrere Fly-Apps/Orgs, Multi-Tenant, Web-UI.
- v1-Fly-Modus (DOCKER_HOST remote) zurückholen.
