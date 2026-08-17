# PocketAgent zuhause: Devcontainer, PC & Co.

Drei Wege, PocketAgent im eigenen Umfeld zu betreiben. Alle drei koexistieren mit dem Cloud-Deployment (Coolify/Fly) – du kannst deinen Devcontainer als *zusätzlichen* Agenten anmelden, während der Orchestrator in der Cloud läuft.

## Variante A – Kompletter Stack auf dem Heim-PC (heute möglich)

Orchestrator + Session-Container auf deinem Docker:

```bash
git clone https://github.com/robinrehbein/remote-control && cd remote-control
# Images bauen (einmalig)
docker build -f server/Dockerfile -t pocketagent/orchestrator:latest . # usw. je Adapter
cp .env.example .env   # MASTER_KEY setzen
docker compose up -d
```

Erreichbarkeit für die App: Tailscale (empfohlen, `tailscale serve` vor dem Container) oder Port-Forward. Agents laufen in **frischen Session-Containern** mit eigenen Repo-Clones.

## Variante B – Orchestrator im Devcontainer (heute möglich)

Wenn dein Devcontainer den Host-Docker-Socket gemountet hat (docker-from-docker), läuft der Orchestrator **in** deinem Devcontainer und erzeugt Session-Container als Siblings auf dem Host – identisch zu Variante A, aber alles in deiner Dev-Umgebung:

```bash
# im Devcontainer (mit /var/run/docker.sock gemountet):
npm install && cd server && npx tsx src/index.ts
```

## Variante C – Link-Agent: Agents IN deinem Devcontainer (empfohlen)

Der Orchestrator bleibt in der Cloud (Coolify/Fly) oder läuft irgendwo anders. Ein kleiner **Link-Agent** läuft in deinem Devcontainer, verbindet sich **ausgehend** per WebSocket (kein Port-Forwarding, kein Tunnel, NAT-egal) und stellt deinen Live-Workspace als Session bereit. Die App steuert dann den Agenten, der auf **deinem echten Working Directory** arbeitet – mit allen Tools und deinem Git-State.

```
Android-App
   ↕ wss:// (Cloud, TLS)
ORCHESTRATOR (Coolify/Fly/PC)
   ↕ outbound WebSocket (vom Agenten initiiert!)
LINK-AGENT in deinem Devcontainer
   └─ Adapter-Shim (kilo/claude/pi/junie) auf deinem Workspace
```

### Setup (einmalig, auf dem Server)

```bash
npm run link:token -w server -- --name devcontainer
# → Token ausgeben (PA_TOKEN)
```

### Setup (im Devcontainer)

```bash
git clone https://github.com/robinrehbein/remote-control && cd remote-control && npm install
PA_SERVER=wss://dein-orchestrator.example.com \
PA_TOKEN=<token> \
PA_ADAPTER=kilo \
PA_MODE=ask \
PA_WORKDIR=/workspaces/mein-projekt \
npm run start -w link
```

Die Session erscheint automatisch in der App (Name `link:devcontainer`), Events, Approvals, Diffs – alles wie bei Cloud-Sessions.

### Hinweise zu Variante C

- **Provider-Keys** kommen aus der Env des Devcontainers (`OPENAI_API_KEY`, `ZHIPU_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `JUNIE_API_KEY` …) bzw. aus `~/.config/kilo/auth.json` etc. – der Server-Vault injiziert hier nichts (deine Keys bleiben komplett lokal).
  Der Z.AI-Key heißt für kilo (OpenCode-kompatibler Fork) `ZHIPU_API_KEY`; unter `ZAI_API_KEY` sieht es ihn nicht und jedes GLM-Modell endet in „model not found". Nur `PA_ADAPTER=pi` liest `ZAI_API_KEY`.
- **Branch**: Der Shim arbeitet auf `agent/<PA_NAME>` (Default: Hostname). Vorhandenen Checkout-Branch behalten? Der Shim checkt `agent/<name>` aus deinem Workspace aus – commite vorher oder setze `PA_NAME` passend.
- **Auto-Push**: Nur im Yolo-Modus (pusht + Draft-PR, braucht `GITHUB_PAT` in der Devcontainer-Env). Tap-Push aus der App ist für Link-Sessions nicht verfügbar.
- **Reconnect**: Link-Agent verbindet sich automatisch neu (Netzwechsel, Server-Restart). Die Session geht dabei auf `stopped` → `idle` – Verlauf bleibt.
- **Stop aus der App** beendet den Link-Agenten sauber (Prozess endet); neu starten wie oben.
- **Mehrere Umgebungen**: Einfach mehrere Link-Agents mit verschiedenen Namen/Token anmelden (Devcontainer, VPS, Arbeits-PC) – jede erscheint als eigene Session.

## Welche Variante für wen?

| | A (Stack zuhause) | B (Orchestrator im Devcontainer) | C (Link-Agent) |
|---|---|---|---|
| Agents arbeiten auf Live-Workspace | nein (eigene Clones) | nein | **ja** |
| Cloud-Orchestrator nötig | nein | nein | optional |
| NAT/Firewall | Tunnel nötig | Tunnel nötig | **kein Problem** (outbound) |
| Setup-Aufwand | mittel | mittel | **minimal** |
