# PocketAgent auf Fly.io deployen

## Warum kein "Fly Sprite"?

Fly Sprites sind fertige Ein-Klick-Apps aus einem Katalog — PocketAgent ist eine
eigene Multi-Container-Anwendung und braucht `fly deploy` mit dem eigenen
Dockerfile. Der wichtige architektonische Punkt:

**Der Orchestrator steuert Session-Container über die Docker-API.** Fly-VMs
haben keinen `docker.sock` und erlauben keine Container-in-Container-Spawns.
Deshalb läuft im Fly-Setup **geteilt**:

```
Android-App
   ↕ wss://pocketagent.fly.dev (TLS, Fly edge)
ORCHESTRATOR auf Fly.io (WS, Pairing, Vault, FCM, SQLite-Volume)
   ↕ Docker-Remote-API (tcp+TLS, DOCKER_HOST)
DEIN DOCKER-HOST (Coolify-Server zuhause)
   └─ Session-Container (Adapter-Shims) — Images dort bauen!
```

Der Orchestrator verbindet sich per `DOCKER_HOST` mit dem Docker-Daemon deines
Servers, erstellt Container/Volumes dort und erreicht die Shims über
veröffentlichte Ports (`DOCKER_ADDR`). Ab Fly ist alles identisch zur
Selfhost-Variante.

## Voraussetzungen

1. `fly` CLI installiert + `fly auth login`
2. Docker-Daemon auf deinem Coolify-Server mit **TLS-geschützter Remote-API**:
   - `/etc/docker/daemon.json`: `{"hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"], "tlsverify": true}`
   - Server-Zertifikate erzeugen (offizielle Docker-Doku "Protect the Docker daemon socket"):
     ```bash
     # auf dem Docker-Host (CN/SAN = öffentlicher Hostname, z.B. docker.example.com)
     openssl genrsa -aes256 -out ca-key.pem 4096
     openssl req -new -x509 -days 365 -key ca-key.pem -sha256 -out ca.pem
     openssl genrsa -out server-key.pem 4096
     openssl req -subj "/CN=docker.example.com" -new -key server-key.pem -out server.csr
     echo "subjectAltName = DNS:docker.example.com,IP:1.2.3.4" > extfile.cnf
     openssl x509 -req -days 365 -sha256 -in server.csr -CA ca.pem -CAkey ca-key.pem \
       -CAcreateserial -out server-cert.pem -extfile extfile.cnf
     ```
   - **Client-Zertifikat für den Orchestrator** (commonName beliebig):
     ```bash
     openssl genrsa -out client-key.pem 4096
     openssl req -subj '/CN=pocketagent' -new -key client-key.pem -out client.csr
     echo extendedKeyUsage = clientAuth > extfile-client.cnf
     openssl x509 -req -days 365 -sha256 -in client.csr -CA ca.pem -CAkey ca-key.pem \
       -CAcreateserial -out client-cert.pem -extfile extfile-client.cnf
     ```
   - Daemon neustarten; Firewall: Port 2376 **nur** für Fly-Egress offenhalten
     (idealerweise auf Fly-IPs einschränken).

3. **Adapter-Images auf dem Docker-Host bauen** (nicht auf Fly — die Container
   laufen dort!). Auf dem Coolify-Server, im Repo:
   ```bash
   docker build -f server/Dockerfile         -t pocketagent/orchestrator:latest .   # nur falls auch lokal betrieben
   docker build -f shims/opencode/Dockerfile -t pocketagent/opencode-shim:latest .
   docker build -f shims/kilo/Dockerfile     -t pocketagent/kilo-shim:latest .
   docker build -f shims/claude/Dockerfile   -t pocketagent/claude-shim:latest .
   docker build -f shims/pi/Dockerfile       -t pocketagent/pi-shim:latest .
   docker build -f shims/junie/Dockerfile    -t pocketagent/junie-shim:latest .
   ```

## Transport-Sicherheit (Pflicht-Lektüre vor dem ersten Session-Start)

Remote-Modus heißt: Shim-Ports werden **auf dem Docker-Host veröffentlicht** und
der Orchestrator (auf Fly) spricht sie per Plaintext-HTTP an. Drei Regeln:

1. **`DOCKER_PUBLISH_IP`** (Standard `127.0.0.1`): Shim-Ports lauschen nur auf
   Loopback des Docker-Hosts — aus dem Internet unerreichbar, aber Fly kommt
   auch nicht direkt ran. Zwei Wege:
   - **SSH-Reverse-Tunnel**: Auf dem Docker-Host pro Session-Port einen Tunnel
     zur Fly-VM aufbauen, Muster: `ssh -R 18080:127.0.0.1:<port> ...` — der
     Orchestrator verbindet sich dann via `DOCKER_ADDR`+Tunnelport.
   - **WireGuard**: Ein privates Netz zwischen Fly-VM (Fly unterstützt
     WireGuard-Peering via `fly wireguard`) und Docker-Host; dann
     `DOCKER_PUBLISH_IP` auf die Tunnel-Interface-IP des Docker-Hosts setzen,
     sodass die Ports nur im WireGuard-Netz lauschen.
2. **Port 2376 firewallen**: Docker-Remote-API nur für Fly-Egress offenhalten
   (siehe Voraussetzungen) — daran ändert auch ein Tunnel nichts.
3. **`REMOTE_NETWORK_OPEN=1`**: Remote-Sessions laufen zwingend mit
   `networkPolicy 'open'` (interne Docker-Netzwerke + Egress-Proxy brauchen den
   lokalen Socket). Der Orchestrator verweigert Remote-Sessions ohne dieses
   explizite Consent-Flag. Klarstellung: **auch mit Flag bleibt der
   Shim-Traffic Plaintext** über `DOCKER_ADDR`, solange nicht getunnelt wird —
   das Flag ersetzt keine Verschlüsselung, es dokumentiert dein Einverständnis.

## Deployment

```bash
fly launch --no-deploy          # App anlegen (fly.toml übernehmen)
fly volumes create pocketagent_data --size 1   # SQLite + Vault

# Secrets (Base64 ohne Zeilenumbrüche):
B64() { base64 -w0 "$1"; }
fly secrets set \
  MASTER_KEY="$(openssl rand -hex 32)" \
  DOCKER_HOST="tcp://docker.example.com:2376" \
  DOCKER_ADDR="docker.example.com" \
  DOCKER_CLIENT_CA_B64="$(B64 ca.pem)" \
  DOCKER_CLIENT_CERT_B64="$(B64 client-cert.pem)" \
  DOCKER_CLIENT_KEY_B64="$(B64 client-key.pem)" \
  REMOTE_NETWORK_OPEN="1" \
  SESSION_MEM_LIMIT="2g" \
  IDLE_STOP_SEC="900" \
  GC_DAYS="14"
  # optional: DOCKER_PUBLISH_IP (Standard 127.0.0.1, siehe Transport-Sicherheit),
  #           FCM_SERVICE_ACCOUNT_JSON='{...single line...}'

fly deploy
```

Danach: `fly status`, Health-Check grün unter `https://<app>.fly.dev/api/health`.

## App koppeln & Secrets

```bash
fly ssh console -C "node dist/pair.js"   # Pairing-Code erzeugen (10 min gültig)
```

App: Server-URL `https://<app>.fly.dev` + Code + Gerätename. Danach in
Settings → Secrets wie gewohnt: `github` (PAT), Provider-Keys je Adapter
(`zai`, `openai`, `moonshot`, `claude_oauth`, `junie`, `kilo`).

## Betriebshinweise

- **SQLite liegt auf dem Fly-Volume** (`/data`) — 1 GB reicht für Tausende
  Sessions; Backup via `fly ssh console -C "cat /data/orchestrator.db"` oder
  `fly vol snapshot`.
- **Latenz**: App ↔ Fly ist Edge-schnell; Fly ↔ Docker-Host hängt von der
  Leitung deines Servers ab (SSE-Events sind unproblematisch, Prompt-Latenz
  eine Sekundeordnung).
- **Docker-Host offline**: Orchestrator läuft weiter (Sessions → error status),
  Pairing/Secrets/Repo-Verwaltung bleiben nutzbar.
- **Alternativ ohne Fly**: Alles auf dem Coolify-Server via `docker compose up -d`
  (siehe README) — dann ohne DOCKER_HOST, mit lokalem Socket. Beide Modi
  unterstützen dieselbe DB/API.
- Kosten: shared-cpu-1x + 512 MB + 1 GB Volume liegt unter ~5 USD/Monat.
