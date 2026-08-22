# RUNBOOK-PI — Betrieb von PocketAgent v2

Alles, was zwischen „Repo ausgecheckt" und „Checkliste grün" liegt: Deploy auf
Coolify, Pairing, Secrets, Link-Agent auf dem Heim-PC, Fly-Sessions in
Produktion, Troubleshooting und das Abnahme-Protokoll.

Zielbild und Nicht-Ziele stehen in [`GREENFIELD-PI.md`](GREENFIELD-PI.md), der
Überblick in [`README.md`](README.md). Alle Befehle vom Monorepo-Root, wenn
nicht anders angegeben.

---

## 0. Vor dem Deploy: das alte System

v2 kann **nicht** auf dem Datenbestand von v1 weiterlaufen. Das DB-Schema hat
keine Adapter-Spalten mehr, und die Session-Zeilen aus v1 beschreiben Container
mit Images, die es nicht mehr gibt.

**Deshalb: frisches Volume.** Nicht migrieren, nicht reparieren.

| | |
|---|---|
| Altes System | lebt vollständig im Tag **`v0.13.0`** — auschecken und bauen genügt, um zurückzugehen |
| Volume | `orchestrator-data` neu anlegen (in Coolify: Volume löschen bzw. umbenennen und neu erzeugen lassen) |
| Folge 1 | **Einmal neu koppeln.** Alle Device-Tokens sind weg, die App muss den Pairing-Flow neu durchlaufen |
| Folge 2 | **Secrets neu hinterlegen.** Der Vault ist leer: GitHub-PAT und Provider-Keys müssen einmal neu in die App eingegeben werden |
| `MASTER_KEY` | darf derselbe bleiben (er entschlüsselt nur den — jetzt leeren — Vault); ein neuer ist genauso in Ordnung |

Wer das alte Volume behalten will, um zurückzukönnen: umbenennen statt löschen.

---

## 1. Deploy auf Coolify

Der Coolify-Pfad ist unverändert zu v1 — bewusst, damit kein
Infrastruktur-Umbau nötig ist:

- **Dockerfile**: `server/Dockerfile`
- **Build-Kontext**: Repo-Root (`.`) — Pflicht, weil `server/` und `runner/`
  `packages/protocol` per `file:`-Dependency einbinden
- **Port**: 3000 (nur intern; Traefik terminiert TLS und routet die Domain)
- **Volume**: `/data` (frisch, siehe oben)

### Envs

| Env | Pflicht | Bedeutung |
|---|---|---|
| `MASTER_KEY` | **ja** | `openssl rand -hex 32`. Ohne ihn läuft der Server mit einem Ephemeral-Key und verliert alle Secrets beim Neustart |
| `DATA_DIR` | nein (`/data`) | SQLite-Datei + Zustand |
| `TRUST_PROXY` | **hinter Coolify: ja (`1`)** | sonst teilen sich alle Geräte die Proxy-IP → das WS-Limit (10/IP) und der Pairing-Rate-Limiter treffen Unbeteiligte. Bei direkt exponiertem Server NIEMALS setzen (X-Forwarded-For ist dann fälschbar) |
| `PAIRING_ADMIN_TOKEN` | nein | erlaubt `POST /api/pairing/create` und `POST /api/secrets` per Bearer-Token |
| `FCM_SERVICE_ACCOUNT_JSON` | nein | Firebase-Service-Account als **eine** Zeile; ohne ihn gibt es keine Push-Benachrichtigungen (Checklisten-Punkt 7!) |
| `RUNNER_IMAGE_PREFIX` | nein (`pocketagent`) | Namensraum des Runner-Images |
| `RUNNER_IMAGE_TAG` | nein (`latest`) | Tag des Runner-Images — **nach Änderungen an `runner/` hochzählen** (siehe unten) |
| `RUNNER_IMAGE` | nein | vollständiges Registry-Image (`ghcr.io/acme/pi-runner:2026-08`). Gesetzt = nur pullen, nie bauen |
| `SESSION_MEM_LIMIT` | nein (`2g`) | RAM je Session-Container |
| `SESSION_CPU_QUOTA` | nein | Docker-NanoCPUs je Session (`1000000000` = 1 CPU) |
| `IDLE_STOP_SEC` / `GC_DAYS` | nein (900 / 14) | Idle-Reaper und Aufräumfrist |
| `NETWORK_POLICY` | nein (`allowlist`) | Vorgabe je Session; `isolated` und `open` sind die Alternativen |
| `NETWORK_ALLOWLIST` | nein | überschreibt die Vorgabeliste (GitHub, pi-Provider, Paket-Registries) |
| `FLY_API_TOKEN` | für Fly: **ja** | Fly-Sessions sind aktiviert, sobald das Token steht (fly.io → Settings → API) |
| `FLY_APP_NAME` | nein (`pocketagent-sessions`) | Fly-App, unter der der Server die Session-Machines verwaltet |
| `FLY_ORG_SLUG` | nur einmalige App-Anlage | erlaubt dem Server, die App beim ersten Start anzulegen; danach entbehrlich |
| `FLY_REGION` | nein | Region der Machines (z. B. `fra`); leer = Fly wählt |
| `FLY_IMAGE` | nein | fertiger Image-Ref der Machine (z. B. öffentliches ghcr-Image). Gesetzt = nie bauen, nie pushen |
| `FLY_MAX_MACHINES` | nein (3) | Deckel gleichzeitig laufender Fly-Machines (`creating`/`running`/`idle`) |
| `GHCR_IMAGE` | für Fly-Selbstbau: **ja** | Push-Ziel des Fly-Link-Images, z. B. `ghcr.io/<owner>/fly-link:2026-08` (sonst `FLY_IMAGE` setzen) |
| `GHCR_PUSH_TOKEN` / `GHCR_USERNAME` | mit `GHCR_IMAGE`: **ja** | GitHub-PAT mit `write:packages` und Username für den Image-Push |
| `PUBLIC_URL` | für Fly: **ja** | öffentliche Basis-URL des Orchestrators; daraus wird `PA_SERVER` der Machine (`https`→`wss`) |
| `EGRESS_PUBLIC_URL` | für Fly + `allowlist`: **ja** | öffentliche Proxy-URL **ohne** Userinfo, TLS empfohlen (siehe Abschnitt 5) |

Entfallen gegenüber v1 (ersatzlos, nicht umbenannt): `ADAPTER_IMAGE_PREFIX`,
`ADAPTER_IMAGE_TAG`, `ADAPTERS_DIR`, `GATEWAY_TOKEN`/`GATEWAY_PORT`/
`GATEWAY_IMAGE`, `DOCKER_ADDR`, `DOCKER_HOST_IS_LOCAL`, `REMOTE_NETWORK_OPEN`,
`DOCKER_PUBLISH_IP`, `SHIM_BUILD_CONTEXT`.

### Das Runner-Image

Es gibt genau eines: `<RUNNER_IMAGE_PREFIX>/pi-runner:<RUNNER_IMAGE_TAG>`.
**Niemand muss es von Hand bauen.** Das Orchestrator-Image bündelt unter
`/app/build-context` genau das Layout, das `runner/Dockerfile` erwartet
(`tsconfig.base.json`, `packages/protocol/`, `runner/`) und schickt es beim
ersten Session-Start als Build-Kontext an den Docker-Daemon
(`ensureRunnerImage`).

- **Erster Start dauert Minuten.** Die App zeigt den Bau als Fortschrittskarte
  („Image wird gebaut (Schritt 7/14)") mit ausklappbarem Log.
- **Invalidierung ist manuell**: `ensureRunnerImage` baut nur, wenn kein Image
  dieses Namens existiert. Nach Änderungen an `runner/` also
  `RUNNER_IMAGE_TAG` hochzählen (Coolify: Build-Arg **und** Env), sonst läuft
  der alte Stand weiter. Content-Hash-Tags wie in v1 gibt es nicht mehr.
- **Vorbauen** (spart die Wartezeit beim ersten Start):
  `docker compose --profile runner build pi-runner`.
- **Eigenes Artefakt** aus einer Registry: `RUNNER_IMAGE` setzen — dann wird
  ausschließlich gepullt.

### Coolify-Hygiene

- Auto-Cleanup / „Docker Cleanup" prüfen: Session-Container tragen das Label
  `pocketagent.session`; gestoppte Idle-Sessions sowie `pocketagent-*`-Volumes
  und -Netze dürfen **nicht** weggeräumt werden → Cleanup deaktivieren oder
  Ausnahmen setzen. Auf keinen Fall `docker system prune --volumes` auf dem Host.
- Solange `docker.sock` gemountet ist: keine weiteren sensiblen Apps auf
  demselben Server. `MASTER_KEY` nur als Coolify-Secret.
- Optionale Härtung: Socket-Proxy (`docker compose --profile socketproxy up -d`
  plus `DOCKER_HOST=http://socket-proxy:2375`). Das verkleinert die
  Angriffsfläche, ist aber keine Sicherheitsgrenze — wer Container starten darf,
  kommt über Bind-Mounts praktisch immer an Host-Root.

---

## 2. Pairing

Pairing-Codes sind **12 Hex-Zeichen**, TTL **10 Minuten**, einmal verwendbar.

```bash
# im Container (gebaute dist/):
docker exec -it pocketagent-orchestrator node dist/pair.js

# in der Entwicklung (schreibt direkt in die DB unter DATA_DIR, der Server
# muss dafür nicht laufen):
npx tsx server/src/pair.ts
```

In der App: Server-URL (`https://…`, die App macht daraus `wss://`), Code,
Gerätename. Danach lädt die Session-Liste.

**Härtung, die dabei greift:**

- **Lockout**: 5 fehlgeschlagene Confirm-Versuche machen den Code dauerhaft
  ungültig. Unbekannte Codes verbrauchen keine Versuche.
- **Rate-Limit** auf `/api/pairing/*`: 10 req/min pro IP, 60 req/min global
  (HTTP 429). Hinter einem Proxy ohne `TRUST_PROXY=1` zählen alle Clients als
  eine IP — das ist der häufigste Grund für unerwartete 429er.
- **Audit**: jeder Fehlversuch landet als `{"ev":"auth.fail",...}` im Log,
  Codes nur als 4-Zeichen-Präfix.

### Geräte und Links verwalten

```bash
# im Container:
node dist/admin.js list-devices
node dist/admin.js revoke-device <id>
node dist/admin.js list-links
node dist/admin.js revoke-link <id>
```

Die CLI arbeitet direkt auf der DB und schließt **lebende** WS-Verbindungen
nicht sofort — gesperrte Geräte fallen beim nächsten Reconnect heraus.
Revocation aus der App (`device.revoke`/`link.revoke`) schließt sofort.

---

## 3. Secrets

Alles über die App: **Settings → Secrets**. Werte werden AES-256-GCM unter
`MASTER_KEY` verschlüsselt abgelegt und nie zurückgespiegelt (die App zeigt nur
„hinterlegt/nicht hinterlegt" plus das Ergebnis einer Validierung).

| Art | Wofür | Woher |
|---|---|---|
| `github` | Clone, Push, Draft-PR | Fine-grained PAT, je Repo **Contents R/W** + **Pull requests R/W** |
| `openai` | Provider | platform.openai.com/api-keys (`sk-…`) |
| `anthropic` | Provider | console.anthropic.com/settings/keys (`sk-ant-…`) |
| `google` | Provider | aistudio.google.com/apikey |
| `zai` | Provider | z.ai/manage-apikey/apikey-list |
| `moonshot` | Provider | platform.moonshot.ai/console/api-keys |
| `kimi` | Provider | platform.moonshot.ai/console/api-keys — **derselbe Key wie Moonshot** |

**moonshot ↔ kimi:** pi kennt beide Namen für dasselbe Konto und benutzt für
beide die Env-Variable `KIMI_API_KEY`. Der Orchestrator behandelt sie deshalb
als gegenseitigen Ersatz: startet eine Session mit Provider `kimi` und liegt im
Vault nur `moonshot`, wird der moonshot-Key injiziert — und umgekehrt. Es
genügt also, **einen von beiden** zu hinterlegen. Das eigene Secret schlägt
immer den Ersatz; für alle anderen Provider gibt es keinen Fallback.

Der GitHub-PAT reist **nicht** über die Container-Umgebung: er wird als
`/run/secrets/pa/creds.json` in den noch nicht gestarteten Container gelegt.

---

## 4. Link-Agent auf Heim-PC / Devcontainer

Der Orchestrator bleibt in der Cloud; ein kleiner Agent läuft neben deinem
Code, verbindet sich **ausgehend** per WebSocket (kein Port-Forwarding, kein
Tunnel, NAT egal) und stellt deinen echten Workspace als Session bereit.

```
Android-App  ──wss──►  Orchestrator (Coolify)  ◄──outbound WS──  Link-Agent (dein PC)
                                                                   └─ pi-Runner in-process
                                                                      auf PA_WORKDIR
```

### Setup

```bash
# 1. auf dem SERVER: Token erzeugen
npm run link:token -w server -- --name=heim-pc

# 2. auf dem PC / im Devcontainer
git clone https://github.com/robinrehbein/remote-control && cd remote-control
npm install
cd runner && npm install && cd ..      # PFLICHT, siehe unten
```

> **`cd runner && npm install` ist nicht optional.** `runner/` ist bewusst
> **kein** Root-Workspace: es hat ein eigenes `package-lock.json`, weil genau
> dieses Lockfile auch `runner/Dockerfile` mit `npm ci` benutzt — das
> Session-Image und der Link-Agent fahren damit nachweislich denselben
> Abhängigkeitsstand. Der Link-Agent importiert `runner/src` relativ
> (`link/src/runner-embed.ts`) und Node löst dessen Abhängigkeiten ab
> `runner/node_modules` auf. Ohne diesen Schritt startet der Link-Agent mit
> „Cannot find package 'fastify'" o. ä.

### Starten

```bash
PA_SERVER=wss://orchestrator.example.com \
PA_TOKEN=<token aus Schritt 1> \
PA_WORKDIR=/home/robin/code/mein-projekt \
PA_NAME=heim-pc \
PA_MODE=ask \
OPENAI_API_KEY=sk-... \
npm run start -w link
```

### Env-Contract

| Env | Pflicht | Bedeutung |
|---|---|---|
| `PA_SERVER` | ja | `wss://…` des Orchestrators |
| `PA_TOKEN` | ja | Link-Token aus `npm run link:token -w server` |
| `PA_WORKDIR` | nein (cwd) | lokaler Repo-Checkout, auf dem der Agent arbeitet |
| `PA_NAME` | nein (Hostname) | Anzeigename in der App **und** Branch `agent/<PA_NAME>` |
| `PA_MODE` | nein (`ask`) | `yolo` \| `auto` \| `acceptEdits` \| `ask` |
| `PA_BRANCH` | nein | Basis-Branch, wird an `agent.hello` gereicht |
| `PA_REPO_FULL_NAME` | nein | `owner/name` für die Draft-PR-API; ohne sie wird gepusht, aber keine PR angelegt |
| Provider-Keys | je nach Provider | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY` — direkt aus der Umgebung dieses Prozesses |
| `GITHUB_PAT` | nur für Push | Auto-Push + Draft-PR im Yolo-Modus |

Alle Werte lassen sich auch als Flag setzen (`--mode=ask`, `--workdir=…`).
`PA_ADAPTER` aus v1 gibt es nicht mehr — der Link-Agent fährt immer den
pi-Runner.

### Verhalten

- **Keys bleiben lokal.** Der Server-Vault injiziert bei Link-Sessions nichts.
- **Branch**: der Runner arbeitet auf `agent/<PA_NAME>` in deinem Checkout —
  vorher committen oder `PA_NAME` passend wählen.
- **Reconnect** passiert automatisch (Netzwechsel, Server-Neustart); die
  Session geht dabei auf `stopped` → `idle`, der Verlauf bleibt.
- **Stop aus der App** beendet den Link-Agenten sauber; neu starten wie oben.
- **Mehrere Umgebungen** parallel: einfach mehrere Agents mit verschiedenen
  Namen und Tokens anmelden.

---

## 5. Fly-Sessions (Produktion)

Drittes Session-Ziel neben Docker und Link: **eine Fly.io-Machine je Session**,
disk-less (kein Volume), vom Orchestrator über die Machines-API provisioniert.
Die Machine startet vom Fly-Link-Image (Link-Agent mit eingebettetem pi-Runner,
`runner/Dockerfile.fly`), klont beim Start das Repo frisch, arbeitet auf
`agent/<session-id>` und meldet sich per **outbound WSS** beim Orchestrator —
derselbe Dial-Home wie der Link-Agent, aber mit einem frischen Link-Token, der
exklusiv zu dieser Session gehört (Delete nimmt ihn mit). Aktiviert wird Fly
allein durch das Setzen von `FLY_API_TOKEN`.

Netzwerk-Policy pro Session wie bei Docker, auf der Machine über Proxy-Env
umgesetzt:

| Policy | Machine-Env | Wirkung |
|---|---|---|
| `allowlist` (Vorgabe) | `HTTPS_PROXY=http://pa:<shim_token>@<EGRESS_PUBLIC_URL>`, `NO_PROXY=<Orchestrator-Host>` | Egress nur durch den Egress-Proxy des Orchestrators (Token-Gate + Allowlist) |
| `isolated` | `HTTPS_PROXY=http://127.0.0.1:9` (toter Proxy) | kein Egress — Clone/Fetch laufen bewusst ins Leere |
| `open` | nichts | direkter Internetzugriff |

### Voraussetzungen

1. **Fly-Account + API-Token**: Token unter fly.io → Settings → API erzeugen
   und als `FLY_API_TOKEN` setzen.
2. **Fly-App einmalig anlegen** — einer von beiden Wegen:
   - automatisch: `FLY_ORG_SLUG` setzen; der Server legt die App beim ersten
     Session-Start an (danach kann die Variable wieder weg),
   - manuell: `fly apps create --name <FLY_APP_NAME> --org <org>`.
3. **Machine-Image** — einer von beiden Wegen:
   - `FLY_IMAGE` mit fertigen Ref setzen (z. B. das öffentliche ghcr-Image):
     kein Bau, kein Push.
   - `GHCR_IMAGE` (Push-Ziel, z. B. `ghcr.io/<owner>/fly-link:2026-08`) +
     `GHCR_PUSH_TOKEN` (GitHub-PAT mit `write:packages`) + `GHCR_USERNAME`:
     der Server baut und pusht selbst (siehe unten).

   Ein **privates** ghcr-Image kann Fly nur mit Registry-Auth an der App ziehen
   (über die Fly-Plattform zu hinterlegen) — das ist bewusst **nicht**
   automatisiert. Empfehlung: Image öffentlich machen; es enthält keine
   Secrets (alle Token stehen je Session in der Machine-Env, nie im Image).
4. **`PUBLIC_URL`**: öffentliche Basis-URL des Orchestrators, z. B.
   `https://pa.example.com`; daraus leitet der Server `PA_SERVER` der Machine
   ab (`https`→`wss`).
5. **`EGRESS_PUBLIC_URL`** (nur für Policy `allowlist`): öffentliche URL des
   Egress-Proxys **ohne** Userinfo, z. B. `https://egress.example.com` oder
   `http://egress.example.com:3128` — siehe unten.

### Erster Start

- Beim ersten Fly-Session-Start stellt der Server die App sicher und sorgt für
  das Image: ohne `FLY_IMAGE` baut er `<RUNNER_IMAGE_PREFIX>/fly-link:
  <RUNNER_IMAGE_TAG>` über die Docker-API (dieselbe Baumechanik wie beim
  pi-Runner-Image) und pusht es nach `GHCR_IMAGE`.
- **Das dauert Minuten** — die App zeigt Bau und Push als Fortschrittskarte
  mit ausklappbarem Log.
- Danach startet jede weitere Session in **Sekunden**: Machine aus dem
  vorhandenen Registry-Image, Bootstrap klont das Repo, Agent dialt heim.
- Vorbauen (spart die Wartezeit beim ersten Start):
  `docker compose --profile fly-runner build fly-runner`.
- Invalidierung: `RUNNER_IMAGE_TAG` hochzählen — das gilt für beide
  Runner-Images; neuer Tag heißt neuer Build und neuer Push (den Tag in
  `GHCR_IMAGE` sinnvollerweise mitziehen).

### Egress-Proxy öffentlich machen (Policy `allowlist`)

Fly-Machines hängen in keinem Docker-Netz — für sie ist der Egress-Proxy nur
über seine öffentliche URL erreichbar:

1. Port exponieren (der Orchestrator lauscht auf 3128, umstellbar über
   `EGRESS_PROXY_PORT`): in Coolify als TCP-Port oder per Traefik-**TCP**-
   Router. Keinen HTTP-terminierenden Proxy davor — der würde dem Proxy die
   Adresse des eigentlichen Clients vorspiegeln (Details im Kopfkommentar von
   `server/src/egress-proxy.ts` und im Kommentar zu Port 3128 in der
   `docker-compose.yml`).
2. `EGRESS_PUBLIC_URL` setzen — ohne Userinfo.
3. **TLS empfehlen**: Eine HTTP-Terminierung bricht das Peer-IP-Gate der
   Docker-Sessions zwar nicht, aber ohne TLS trägt jede Fly-Session ihr
   Proxy-Token (Basic `pa:<shim_token>`) im Klartext über das Netz.

### Lifecycle & Kosten

| Ereignis | Verhalten |
|---|---|
| Idle (`IDLE_STOP_SEC`, Default 900 s) | Machine wird **gestoppt** — die Abrechnung pausiert. Die App zeigt „Pausiert". |
| Resume | Machine startet neu; der Bootstrap klont bzw. zieht den `agent/<session-id>`-Branch auf Remote-Stand (ein paar Sekunden). Ungepushte Commits der vorigen Runde sind mit dem Machine-Stop **weg** (disk-less): der Runner committet nach jedem Turn, pusht aber nur im Yolo-Modus automatisch (Tap-Push ist Docker vorbehalten). Eine laufende pi-SessionRef überlebt den Neustart bewusst nicht. |
| Delete / GC (`GC_DAYS`) | Machine wird **zerstört** (force) samt Link-Token, die Zeile verschwindet. GC sammelt gestoppte/fehlgeschlagene Fly-Sessions nach der Inaktivitätsfrist ein. |
| Deckel | `FLY_MAX_MACHINES` (Default 3) zählt Fly-Sessions in `creating`/`running`/`idle`; darüber wird `session.create` mit klarer Meldung abgelehnt. |
| Orchestrator-Neustart | nichts zu tun — laufende Machines redialen selbst (Restart-Policy `always`); gestoppte bleiben gestoppt und warten auf Resume. |

### Troubleshooting (Fly)

| Symptom | Ursache | Fix |
|---|---|---|
| `Fly-Sessions sind auf diesem Server nicht aktiviert (FLY_API_TOKEN fehlt).` | Server lief ohne `FLY_API_TOKEN` | Token setzen (fly.io → Settings → API) und den Server neu starten |
| `PUBLIC_URL fehlt: …` | öffentliche Basis-URL nicht gesetzt | `PUBLIC_URL` auf die von außen erreichbare Orchestrator-URL setzen |
| `Die Fly-App "…" existiert noch nicht. FLY_ORG_SLUG setzen …` | App noch nicht angelegt | `FLY_ORG_SLUG` setzen (der Server legt an) oder manuell `fly apps create --name <FLY_APP_NAME> --org <org>` |
| `Für Fly-Sessions mit Policy 'allowlist' fehlt EGRESS_PUBLIC_URL …` | Proxy-URL fehlt | `EGRESS_PUBLIC_URL` setzen und den Port freigeben (siehe oben) |
| Provider-Call aus einer Fly-Session scheitert; Orchestrator-Log zeigt `[egress] denied … (no proxy credentials` bzw. `token not accepted)`, der Client sieht 407 | `EGRESS_PUBLIC_URL` falsch, Port 3128 nicht exponiert oder Token tot | URL und Port prüfen; das Token ist der `shim_token` der Session und lebt nur, solange sie läuft (eine gestoppte Session wird abgewiesen — nach dem Resume ist es wieder gültig) |
| Machine-Erzeugung dauert ewig, oder `Image-Push nach … scheiterte` | erster Build + Push laufen noch, oder der ghcr-Push ist gescheitert | Fortschrittskarte abwarten (Minuten); sonst `GHCR_PUSH_TOKEN` (`write:packages`), `GHCR_USERNAME` und `GHCR_IMAGE` prüfen |
| `Die Fly-Machine hat sich innerhalb von 120s nicht mit dem Orchestrator verbunden …` („Agent hat sich nicht gemeldet") | Machine erreicht den Orchestrator nicht — `PA_SERVER` stimmt nicht | `PUBLIC_URL` prüfen: von außen erreichbar, `https` wird zu `wss`; Orchestrator-Log ansehen |
| Fly-Session nach App-/Server-Neustart „Pausiert" | erwartet | Machine redialt von selbst; sonst Resume antippen |

---

## 6. Troubleshooting

### „Failed to connect …" / keine Verbindung beim Koppeln

Die App meldet bei Netzwerkfehlern, welcher Schritt scheiterte (DNS, TLS,
Timeout, TCP) samt nächstem Prüfschritt, und wiederholt einen gescheiterten
Connect einmal automatisch. Wenn es trotzdem hakt, die Seiten einzeln
abklopfen:

1. **Server-Seite** (vom Laptop): `curl https://<domain>/api/health` → muss
   `{"ok":true,...}` liefern. Beide Adressfamilien testen, wenn die Domain A-
   **und** AAAA-Record hat: `curl -4 …` und `curl -6 …`.
2. **Kommt der Versuch überhaupt an?** Orchestrator-Logs prüfen: jeder
   Confirm-Fehlversuch erscheint als
   `{"ev":"auth.fail","kind":"pairing.confirm","ip":…}`. Steht dort nichts,
   erreicht das Handy den Server nie — das Problem liegt vor dem Server
   (Handy-Netz, VPN, DNS, Firewall).
3. **Handy-Seite**: `https://<domain>/api/health` im Handy-Browser öffnen, im
   selben Netz, in dem die App scheitert. Lädt es dort, aber die App nicht →
   VPN, privates DNS oder ein Firewall-/Werbefilter blockiert die App. Lädt es
   auch im Browser nicht → WLAN ↔ Mobilfunk wechseln; geht es in einem der
   Netze, liegt es am Provider/Netzpfad, nicht an der App.
4. **Code-Fehler sind keine Verbindungsfehler**: `HTTP 400: invalid or expired
   code` heißt, die Verbindung steht — der Code ist abgelaufen (TTL 10 min),
   verbraucht oder nach 5 Fehlversuchen gesperrt → auf dem Server einen
   frischen erzeugen.

### Die Fortschrittskarte dreht sich ewig

Der Start meldet sich in drei Phasen: `container-start` → `shim-start` →
`ready`; `ready` räumt die Karte weg, ein `error`-Event ebenfalls. Bleibt sie
stehen, ist der Session-Start hängen geblieben, ohne zu scheitern → Logs des
Orchestrators (`[sessions] provisioning failed …`) und `docker logs` des
Session-Containers ansehen. Der Runner-Image-Bau meldet sich bewusst unter
`container-start` und darf minutenlang dauern.

### Erster Session-Start dauert sehr lange

Normal: das Runner-Image wird einmalig gebaut (siehe Abschnitt 1). Bei
wiederholt langen Starts prüfen, ob `RUNNER_IMAGE_TAG` bei jedem Deploy
wechselt — dann wird jedes Mal neu gebaut.

### Session bekommt keinen Provider-Key

Der Orchestrator injiziert **genau einen** Key, unter dem Namen aus der
Provider-Tabelle. Fehlt er, meldet der Runner das als Turn-Fehler statt still
zu scheitern. Prüfen: liegt unter der gewählten Provider-Art ein Secret? (Für
`kimi`/`moonshot` genügt eines von beiden.)

### Push/Draft-PR schlägt fehl

Der PAT braucht **Contents R/W** und **Pull requests R/W** für genau dieses
Repo. Unter Policy `allowlist` muss der Egress-Proxy stehen — `api.github.com`
ist in der Vorgabeliste, eine eigene `NETWORK_ALLOWLIST` muss ihn enthalten.

---

## 7. Verifikation vor dem Ausrollen

```bash
npm install && (cd runner && npm install)
npm run typecheck        # erwartet: kein Fehler, Exit 0
npm test                 # Protocol-Typtests + Link-Tests
npm run smoke:server     # erwartete letzte Zeile: SMOKE OK
npm run smoke:runner
npm run smoke:link
cd android && gradle :app:testDebugUnitTest :app:testReleaseUnitTest
```

Der Server-Smoke prüft auch die Kopplung zwischen Orchestrator und
`runner/Dockerfile` statisch (jede `COPY`-Quelle liegt im gebündelten
Build-Kontext, der Tap-Push-Pfad zeigt auf die Datei, die im Image landet) —
Docker selbst braucht er dafür nicht.

**Was sich nur am echten System prüfen lässt** und deshalb Teil der Checkliste
unten ist: der Docker-Bau des Runner-Images, ein echter Provider-Durchstich mit
Key, FCM-Push, Netzwechsel im laufenden Turn.

---

## 8. Abnahme-Protokoll (Definition of Done)

Aus [`GREENFIELD-PI.md`](GREENFIELD-PI.md). Jede Zeile **dreimal hintereinander
fehlerfrei**, einmal über WLAN, einmal über Mobilfunk; das Ganze **zweimal in
Folge**. Kein neues Feature vorher.

| # | Schritt | Grün, wenn |
|---|---|---|
| 1 | Koppeln (frischer Code) | Session-Liste lädt |
| 2 | Session erstellen (pi) → erster Prompt | Antwort kommt an |
| 3 | Approval-Karte beantworten (Ask-Modus) | Turn läuft nach der Antwort weiter |
| 4 | Diff ansehen → Push | Draft-PR entsteht auf GitHub |
| 5 | App killen, wieder öffnen | Verlauf vollständig, Reconnect ohne Doppel-Events |
| 6 | Netzwechsel mitten im Turn | App fängt sich selbst |
| 7 | Handy weglegen | Push-Notification bei Approval/Turn-Ende kommt an |

### Fly-Checkliste (einmal je Setup)

| # | Schritt | Grün, wenn |
|---|---|---|
| 1 | Fly-Session erstellen → erster Prompt | Fortschrittskarte (beim allerersten Start inkl. Image-Bau), dann kommt die Antwort an |
| 2 | Yolo-Turn laufen lassen | pusht automatisch, Draft-PR entsteht auf GitHub |
| 3 | Idle abwarten (`IDLE_STOP_SEC`) | App zeigt „Pausiert" → Resume → weiterarbeiten ohne Datenverlust (Agent-Branch wird neu ausgecheckt) |
| 4 | `allowlist`-Session: Turn laufen lassen | Provider-Call geht durch den Proxy — Server-Log zeigt `[egress]` |
| 5 | eine Fly-Session mehr als `FLY_MAX_MACHINES` anlegen | wird abgewiesen: „Die Limite von 3 laufenden Fly-Machines (FLY_MAX_MACHINES) ist erreicht …" |

Notiere je Durchlauf Datum, Netz (WLAN/Mobilfunk), App-Version und den Punkt,
an dem es hakte. Funde gehen als eigene Fix-Pakete zurück in die Umsetzung —
nicht nebenbei mitfixen.
