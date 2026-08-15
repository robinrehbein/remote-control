# PocketAgent Runbook: Verifikation & Inbetriebnahme

Dieser Ordner wurde in einer Umgebung ohne Shell-Zugriff finalisiert (`bash: deny *`).
Der letzte Durchlauf von `tsc`/`npm run smoke` muss deshalb EINMAL in einer Shell
mit Rechten nachgezogen werden — Schritt 1–3 unten reichen dafür und dauern < 5 min.
Alle Befehle vom Monorepo-Root ausführen.

## 1. Statische Verifikation (Pflicht, einmalig)

```bash
npm install --no-audit --no-fund
npm run typecheck          # erwartete Ausgabe: kein Fehler, Exit 0
npm run smoke:server       # erwartete letzte Zeile: SMOKE OK
npm run smoke:shims        # erwartete Ausgabe: 5x SMOKE OK (opencode, kilo, claude, pi, junie)
```

Falls `typecheck` an einer Stelle fehlschlägt: Die letzten Änderungen (Event-Normalizer
für echte opencode/kilo-Wire-Formate, claude-Busy-Fix, real-check-Skripte) wurden ohne
Compiler-Durchlauf geschrieben und manuell reviewed — kleine Tippfehler sind unwahrscheinlich,
aber nicht ausgeschlossen. Fixen und committen.

## 2. Echte-Runtime-Checks (ohne API-Keys, ~5 min)

```bash
npm run smoke:real
```

- `shims/opencode`: bootet echtes `opencode serve` (1.18.18) + Shim dagegen.
  Erwartung: `REAL CHECK OK`. Ohne API-Key muss der Prompt-Turn als sauberes
  `turn.failed`/`error`-Event enden (kein Crash, Shim überlebt). Druckt am Ende
  5 echte `/event`-Bus-Frames zur Kontrolle.
- `shims/pi`: bootet echtes pi-SDK (0.84.2) inkl. Permission-Gate-Extension.
  Erwartung: `REAL CHECK OK`; ohne Key kommt `No API key found …` als `turn.failed`.
- `shims/claude`: echtes Agent-SDK (0.3.233). WICHTIG: zuerst einmal
  `cd shims/claude && npm install --workspaces=false` laufen lassen, damit die
  gepinnten Plattform-Binaries (`…-linux-x64`/`…-linux-arm64`, optionalDependencies)
  gezogen werden. Erwartung: `REAL CHECK OK` mit Fehlerklassifizierung
  `auth` (mit Credentials-Pfad) — `missing-binary` heißt: Binaries fehlen noch.

## 3. Android-App

Option A (empfohlen): Repo auf GitHub pushen → `.github/workflows/android.yml`
baut APK + Unit-Tests und hängt sie als Artifact `pocketagent-debug-apk` an.
Der Code wurde statisch vollständig durchgesehen (Imports, Material3-Signaturen,
Ressourcen); falls der CI meckert, sind es einzelne API-Signaturen — iterativ fixen.

Option B (lokal): JDK 17 (`apt install openjdk-17-jdk-headless`), Android
cmdline-tools + `platforms;android-35` + `build-tools;34.0.0`, Gradle 8.11, dann
`cd android && gradle :app:assembleDebug :app:testDebugUnitTest`.

## 4. Deployment (Coolify / beliebiger Docker-Host)

```bash
# Images (Build-Kontext ist IMMER der Repo-Root!)
docker build -f server/Dockerfile         -t pocketagent/orchestrator:latest .
docker build -f shims/opencode/Dockerfile -t pocketagent/opencode-shim:latest .
docker build -f shims/kilo/Dockerfile     -t pocketagent/kilo-shim:latest .
docker build -f shims/claude/Dockerfile   -t pocketagent/claude-shim:latest .
docker build -f shims/pi/Dockerfile       -t pocketagent/pi-shim:latest .
docker build -f shims/junie/Dockerfile    -t pocketagent/junie-shim:latest .

cp .env.example .env   # MASTER_KEY=$(openssl rand -hex 32)
docker compose up -d
docker exec -it pocketagent-orchestrator npx tsx src/pair.ts   # Pairing-Code (10 min gültig)
```

## 4a. Pairing-Härtung & Revocation (aktuell)

- Pairing-Codes sind jetzt **12 Hex-Zeichen** (`randomBytes(6)`), TTL weiterhin 10 Minuten.
  Der `pair`-Befehl (`npm run pair -w server` bzw. `npx tsx src/pair.ts`) ist **unverändert**.
- **Lockout**: pro Code werden fehlgeschlagene Confirm-Versuche gezählt (`attempts`-Spalte,
  per Migration hinzugefügt); nach **5 Fehlversuchen** ist der Code dauerhaft ungültig —
  auch wenn er noch nicht abgelaufen ist. Ungültige/unbekannte Codes verbrauchen keine Attempts.
- **Rate-Limit** auf allen `/api/pairing/*`-Routes: **10 req/min pro IP** und **60 req/min global**
  (Sliding Window, in-memory). Verstoß → HTTP 429 `{"ok":false,"error":"rate limited"}`.
  Beim Betrieb hinter einem Reverse-Proxy zählen alle Clients als eine IP, sofern `trustProxy`
  nicht konfiguriert ist — das globale Limit greift trotzdem.
- Auth-Failures (Pairing-Confirm, WS-Unauthorized 4001, Verbindungsversuche widerufener
  Devices) werden als `console.warn`-Audit-Zeilen geloggt: `{"ts":...,"ev":"auth.fail",...}`.
  Pairing-Codes werden darin nur als 4-Zeichen-Präfix protokolliert.

### Admin-CLI (Devices & Links verwalten)

```bash
# Entwicklung (Repo-Root):
npx tsx src/admin.ts list-devices        # im server/-Workspace: npm exec -- tsx src/admin.ts ...
npx tsx src/admin.ts revoke-device <id>
npx tsx src/admin.ts list-links
npx tsx src/admin.ts revoke-link <id>

# Produktion (im Container, gebaute dist/):
node dist/admin.js list-devices
node dist/admin.js revoke-device <id>
```

Hinweis: Die CLI läuft als eigener Prozess direkt auf der DB und kann daher **lebende
WS-Verbindungen nicht sofort schließen** — gesperrte Devices/Links fallen beim nächsten
Reconnect bzw. Restart des Orchestrators heraus (wird beim Revoke-Befehl mit ausgegeben).
Revocation über die App (`device.revoke`/`link.revoke` via WS) schließt lebende Sockets sofort.

App installieren (CI-Artifact), koppeln (URL + Code + Gerätename), dann in
Settings → Secrets hinterlegen: `github` (fine-grained PAT, Contents R/W +
Pull requests R/W je Repo), danach pro Adapter siehe README-Tabelle
(`zai`/`openai`/`moonshot`, `claude_oauth` = `claude setup-token`, `junie`,
`kilo` = Inhalt der Kilo-Gateway-`auth.json`).

## 5. Erste echte Session (E2E)

1. Repo in Settings hinzufügen (z. B. ein Test-Repo)
2. Neue Session: Adapter `opencode`, Provider mit vorhandenem Key, Mode `ask`
3. Prompt senden → Approval-Karte in der App bestätigen
4. Diff öffnen → Push-Button → Draft-PR auf GitHub prüfen
5. Container-Kill-Test: `docker kill <session-container>` → in App „Resume" →
   Volume + Session-Resume muss den Zustand wiederherstellen

## Bekannte Grenzen (bewusst)

- Junie: keine Remote-Approvals (ein-shot-CLI) → App zeigt Warnbanner; ask/acceptEdits
  verhalten sich dort wie yolo.
- Kilo: Gateway-Modelle brauchen `kilo`-Secret (auth.json-Inhalt); Provider-Keys
  (openai/zai/...) funktionieren direkt.
- FCM: ohne `FCM_SERVICE_ACCOUNT_JSON` nur Dry-Run (Pushes werden geloggt).
- `docker.sock` im Orchestrator = Root-äquivalent — für Single-User akzeptiert,
  für Multi-Tenant migrieren (siehe Plan).
