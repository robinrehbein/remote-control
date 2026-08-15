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

## Coolify-Deployment (empfohlen)

- App über Coolify mit Domain + TLS deployen (Traefik terminiert TLS; App-Port
  3000 nur intern, kein Host-Port-Publish). Der WebSocket der App läuft dann
  als `wss://` — Pairing/Device-Token nie über Klartext.
- Coolify Auto-Cleanup/„Docker Cleanup" prüfen: Session-Container heißen nach
  Label `pocketagent.session`, gestoppte Idle-Sessions und `pocketagent-*`-
  Volumes/Netze dürfen NICHT weggeräumt werden → Cleanup deaktivieren oder
  Ausnahmen konfigurieren; mindestens keinen `docker system prune --volumes`
  auf dem Host laufen lassen.
- Host-Hygiene: solange `docker.sock` gemountet ist, keine weiteren
  sensiblen Apps auf demselben Server; `MASTER_KEY` nur als Coolify-Secret.
- Verweis: Socket-Härtung via Socket-Proxy und Remote-Runner-Modus (eigene
  Sektionen/README) für mehr Isolation.

## Socket-Proxy (Härtung Stufe 2)

Optional. Standard bleibt der direkte `docker.sock`-Mount — nichts ändert sich,
solange das Profil nicht gestartet wird.

**Was es bringt:** Der Orchestrator sieht nicht mehr die komplette Docker-API,
sondern nur die per Env freigeschalteten Endpunkte (Container, Images, Netze,
Volumes + Schreiboperationen; `EXEC`, `BUILD`, `SWARM`, `SYSTEM` sind aus).
Der rohe Socket steckt nur noch im Proxy-Container (read-only gemountet), nicht
mehr im Node-Prozess, der WebSocket-Traffic aus dem Internet verarbeitet. Ein
RCE im Orchestrator kann damit z. B. kein `docker exec` in fremde Container und
kein Image-Build mit beliebigem Kontext mehr auslösen.

**Was es NICHT ist:** keine Sicherheitsgrenze. Wer Container erstellen und
starten darf (das braucht PocketAgent per Definition), kann sich mit
Bind-Mounts/Privileges praktisch immer Root auf dem Host verschaffen. Der Proxy
ist eine Hürde und eine Verkleinerung der Angriffsfläche, kein Sandkasten.
Echte Trennung gibt es erst, wenn der Docker-Daemon auf einer anderen Maschine
läuft → **Remote-Runner-Modus** (`DOCKER_HOST` auf einen separaten Host, siehe
`FLY.md`); dann ist ein kompromittierter Orchestrator vom eigenen Host isoliert.

**Aktivieren** (3 Schritte in `docker-compose.yml`, Blöcke sind dort schon
auskommentiert vorbereitet):

```bash
# 1. beim orchestrator: Volume-Zeile /var/run/docker.sock entfernen,
#    networks: [default, socketproxy] aktivieren
# 2. beim orchestrator: DOCKER_HOST=http://socket-proxy:2375 und DOCKER_HOST_IS_LOCAL=1 setzen
docker compose --profile socketproxy up -d
```

`DOCKER_HOST_IS_LOCAL=1` ist Pflicht: ohne das Flag hält der Server jedes
gesetzte `DOCKER_HOST` für einen entfernten Daemon, erzwingt Netzwerk-Policy
`open` und published Shim-Ports auf dem Host. Mit dem Flag bleibt alles wie im
Socket-Modus (Session-Netze, Allowlist-Egress-Proxy, keine Port-Publishes).

Prüfen nach dem Start: `docker compose logs socket-proxy` (403-Zeilen zeigen
einen zu eng gesetzten Env-Schalter), `/api/health` grün, und eine Testsession
mit Policy `allowlist` starten — geht Egress durch, stimmen Netze und Proxy.

## Remote-Runner mit Netzwerk-Policies (Gateway-Container)

Gilt für den **echten** Remote-Modus: `DOCKER_HOST` zeigt auf den Daemon einer
anderen Maschine (dem „Runner"), `DOCKER_HOST_IS_LOCAL` ist **nicht** gesetzt.
(Der Socket-Proxy aus der Sektion oben ist kein Remote-Modus — dort gilt
`DOCKER_HOST_IS_LOCAL=1` und alles bleibt wie im Socket-Modus.)

**Problem:** Der Orchestrator läuft nicht als Container auf dem Runner. Er kann
sich also nicht selbst in ein Session-Netz hängen, und interne Netze
(`Internal: true`) können keine Ports veröffentlichen. Ohne Hilfsmittel bleibt
nur: Policy `open` + je Session ein veröffentlichter Shim-Port am Runner.

**Lösung:** ein einzelner, vom Orchestrator verwalteter **Gateway-Container**
auf dem Runner (`pocketagent-gateway`, Image = Orchestrator-Image, Kommando
`npx tsx src/gateway.ts`). Er hängt am Default-Bridge-Netz (hat also Internet)
*und* wird in jedes Session-Netz gehängt (Alias `gateway`). Session-Container
liegen nur im internen Netz — der Gateway ist ihr einziger Weg rein und raus:

```
Orchestrator (Fly/anderswo)
  │ Docker-API tcp+TLS :2376 ───────────────► RUNNER
  │ Shim-HTTP  :8443 (einziger Host-Port) ──►  pocketagent-gateway
                                                ├─ ingress :8443  /s/<sessionId>/<pfad>
                                                │    → http://<sessionId>:8080/<pfad>
                                                │    Auth: Header x-pocketagent-gateway
                                                └─ egress :3128 (NICHT published)
                                                     Allowlist-Forward-Proxy
                                              Session-Netz je Session (internal)
                                                └─ Shim-Container (kein Port, kein Internet)
```

### Envs am Orchestrator

| Env | Pflicht | Bedeutung |
| --- | --- | --- |
| `DOCKER_HOST` | ja | `tcp://runner.example.com:2376` |
| `DOCKER_CLIENT_{CA,CERT,KEY}_B64` | ja | TLS-Client-Zertifikate wie in `FLY.md` |
| `DOCKER_ADDR` | ja (Default = Hostname aus `DOCKER_HOST`) | Adresse, unter der der Orchestrator den Gateway-Port erreicht |
| `GATEWAY_TOKEN` | ja für Policies | Shared Secret, **stabil** halten (`openssl rand -hex 32`); wird als Header `x-pocketagent-gateway` mitgeschickt |
| `GATEWAY_PORT` | nein (8443) | fester Host-Port des Gateways am Runner |
| `GATEWAY_IMAGE` | nein | Default `${ADAPTER_IMAGE_PREFIX}/orchestrator:latest` |
| `NETWORK_ALLOWLIST` | nein | wird beim Erstellen des Gateways als `GATEWAY_ALLOWLIST` durchgereicht |

**Ohne `GATEWAY_TOKEN`** bleibt es exakt beim alten Verhalten: Policies werden
auf `open` gezwungen, Shim-Ports werden pro Session veröffentlicht, und beim
ersten Session-Start steht eine Warnung im Log
(`remote daemon without GATEWAY_TOKEN …`). Kein Gateway-Container wird erzeugt.

### Voraussetzungen am Runner

- Das **Orchestrator-Image muss dort vorhanden sein** (`docker build -f
  server/Dockerfile -t pocketagent/orchestrator:latest .` auf dem Runner oder
  aus einer Registry ziehbar, dann `GATEWAY_IMAGE=ghcr.io/<owner>/orchestrator:latest`).
  Der Gateway läuft aus demselben Image wie der Orchestrator — kein zweites
  Image, kein zweiter Build.
- **Firewall:** `2376/tcp` (Docker-API) und `GATEWAY_PORT` (Default 8443) nur
  für die IP(s) des Orchestrators öffnen. Der Gateway-Port trägt Shim-Traffic
  inkl. Tokens; er ist per Shared Secret geschützt, aber nicht TLS-terminiert →
  entweder auf die Orchestrator-IP einschränken (Pflicht) oder zusätzlich durch
  einen WireGuard/Tailscale-Tunnel schicken. Der Egress-Port 3128 wird **nicht**
  veröffentlicht und ist nur in den internen Session-Netzen erreichbar.

### Lebenszyklus

- Der Gateway-Container wird beim ersten Session-Start angelegt (`unless-stopped`,
  `CapDrop: ALL`, `no-new-privileges`) und danach wiederverwendet; ein bereits
  existierender Container wird nur gestartet, nicht neu erzeugt.
- Beim Löschen einer Session wird ihr Netz entfernt; der Gateway wird dabei nur
  *disconnected*, nie entfernt.
- Änderungen an `NETWORK_ALLOWLIST` greifen erst nach
  `docker rm -f pocketagent-gateway` auf dem Runner (die Allowlist steckt im
  Container-Env); der nächste Session-Start legt ihn neu an.

### Prüfen

```bash
# auf dem Runner
docker ps --filter name=pocketagent-gateway     # up, Port 0.0.0.0:8443->8443/tcp
docker logs pocketagent-gateway                 # "ingress listening" + "egress proxy listening"
docker network ls --filter name=pocketagent-s-  # je aktive Session ein internes Netz

# vom Orchestrator aus
curl -s -o /dev/null -w '%{http_code}\n' http://<runner>:8443/s/x/status        # 401 (ohne Header)
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-pocketagent-gateway: <TOKEN>' \
     http://<runner>:8443/s/x/status                                            # 502 (Session x existiert nicht)
```

Dann eine Testsession mit Policy `allowlist` starten: Repo-Clone muss
funktionieren (github.com ist in der Default-Allowlist), ein Zugriff auf eine
nicht gelistete Domain muss mit 403 scheitern.

## Bekannte Grenzen (bewusst)

- Junie: keine Remote-Approvals (ein-shot-CLI) → App zeigt Warnbanner; ask/acceptEdits
  verhalten sich dort wie yolo.
- Kilo: Gateway-Modelle brauchen `kilo`-Secret (auth.json-Inhalt); Provider-Keys
  (openai/zai/...) funktionieren direkt.
- FCM: ohne `FCM_SERVICE_ACCOUNT_JSON` nur Dry-Run (Pushes werden geloggt).
- `docker.sock` im Orchestrator = Root-äquivalent — für Single-User akzeptiert,
  für Multi-Tenant migrieren (siehe Plan).
