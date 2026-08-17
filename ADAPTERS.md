# Adapter-Plugins (Harness-Agnostik)

PocketAgent ist harness-agnostisch: Jeder Coding-Agent-Harness ist ein **Adapter-Plugin**, beschrieben durch ein Manifest. Der Orchestrator kennt keine Harness-Namen im Code — er lädt zur Laufzeit alle `shims/*/adapter.json` (Dev) bzw. `/app/adapters/*.json` (Container) und treibt Container-Erzeugung, Credential-Injection und App-UI daraus an.

## Mitgelieferte Adapter

| id | Harness | Auth | Approvals | Resume |
|---|---|---|---|---|
| `kilo` | Kilo CLI (`kilo serve`, OpenCode-Fork) | Provider-API-Keys oder `kilo`-Secret (Gateway `auth.json`-Inhalt → `KILO_AUTH_CONTENT`) | ja | ja |
| `claude` | Claude Code (Agent SDK) | `claude_oauth` (setup-token, Pro/Max) oder `anthropic` API-Key | ja | ja |
| `pi` | pi (SDK-Embedding) | Provider-API-Keys (ZAI/Kimi/Qwen-Kataloge) | ja (`tool_call`-Hook) | ja |
| `junie` | Junie CLI (headless one-shot) | `junie` API-Key oder BYOK-Keys | nein (App-Banner) | nein |

## Manifest-Schema (`shims/<id>/adapter.json`)

```jsonc
{
  "id": "myharness",                  // muss zum Verzeichnisnamen passen
  "name": "My Harness",              // Anzeigename in der App
  "description": "…",                // optionale Beschreibung (App)
  "image": "pocketagent/myharness-shim:latest",  // optional; Default <PREFIX>/<id>-shim:latest
  "pushScript": "/app/scripts/push.js",          // optional; Default /app/shims/<id>/scripts/push.js
  "capabilities": {
    "approvals": true,               // Remote-Permission-Flow implementiert
    "resume": true,                  // Runtime-Session überlebt Container-Restart
    "streaming": true,               // Token-Deltas statt nur Turn-Granularität
    "autoPush": true                 // Shim macht selbst Auto-Push + Draft-PR (Yolo)
  },
  "credentials": {                   // feste Secret-Kinds → Env-Vars (immer injiziert, wenn vorhanden)
    "myharness_oauth": ["MYHARNESS_TOKEN"]
  },
  "providerEnv": {                   // Provider-Wahl der Session → Env-Var (Secret-Kind == Provider)
    "openai": "OPENAI_API_KEY",
    "zai": "ZHIPU_API_KEY"
  },
  "defaults": { "provider": "zai", "model": "" } // App-Defaults beim Session-Anlegen
}
```

Ungültige Manifeste werden beim Boot übersprungen (Log-Warnung), der Server startet weiter.

**`providerEnv` muss die Variable nennen, die die Runtime wirklich liest** — nicht
die, die nach dem Provider-Namen klingt. Beispiel Z.AI: kilo (ein OpenCode-Fork)
zieht seine Provider aus dem Models.dev-Katalog, und der schreibt für alle vier Z.AI-Einträge
(`zai`, `zai-coding-plan`, `zhipuai`, `zhipuai-coding-plan`) `ZHIPU_API_KEY` vor.
Mit `ZAI_API_KEY` taucht kein einziger davon auf; der Key ist dann faktisch nicht
gesetzt, und jedes Modell endet in „model not found". pi ist der Gegenfall — dessen
SDK dokumentiert `ZAI_API_KEY` für den Coding Plan, also steht das so in `shims/pi`.
Im Zweifel: Runtime mit dem Key starten und ihren Provider-Katalog abfragen.

## Neuen Harness hinzufügen (5 Schritte)

1. **Shim bauen**: Neues Verzeichnis `shims/<id>/` mit eigenem HTTP-Server (fastify, Port 8080, Bearer-Auth via `SHIM_TOKEN`), der das Shim-Protokoll implementiert (siehe `packages/protocol` und bestehende Shims als Vorlage — `shims/junie` ist die kleinste Vorlage, `shims/kilo` zeigt die Wiedervernutzung des OpenCode-Protokolls).
2. **Manifest schreiben**: `shims/<id>/adapter.json` mit Credential-Mapping und Capabilities.
3. **Image bauen**: `docker build -f shims/<id>/Dockerfile -t pocketagent/<id>-shim:latest .` (Build-Kontext = Repo-Root, wegen `file:../../packages/protocol`).
4. **Secrets hinterlegen**: In der App (Settings → Secrets) die im Manifest referenzierten Kinds anlegen (z. B. `myharness_oauth`).
5. **Orchestrator neu starten** — der neue Adapter erscheint automatisch in `adapter.list` und damit in der App (Neue Session → Adapter-Auswahl). Kein Code-Changing im Server, kein App-Update.

## Shim-Protokoll (Vertrag)

Jeder Shim muss bereitstellen (Details + Typen: `packages/protocol/src/index.ts`):

- `POST /prompt` `{text, mode?, provider?, model?}` → sofort `{ok:true}`, Ergebnis als Events
- `POST /abort`, `POST /resume {sessionRef}`, `POST /permissions/:id {response}`
- `GET /status` → `ShimStatus`; `GET /diff` → `DiffEntry[]`
- `GET /events` → SSE (`event: agent`) mit normierten `AgentEvent`s (`message.delta`, `tool.call`, `permission.request`, `turn.completed`, …)

Konventionen: Repo-Checkout liegt in `$WORK_DIR` (Volume `/work`), Branch `agent/$SESSION_ID`, Auto-Commit nach jedem Turn, Auto-Push + Draft-PR im Yolo-Modus (pro Turn aus `PromptRequest.mode` abgeleitet, `AUTO_PUSH=1` ist nur der Startwert für Prompts ohne `mode`), `scripts/push.js` für Tap-Push durch den Orchestrator, Provider-Credentials kommen ausschließlich als Env (nie loggen).

## Registrierung im Detail

- Dev: Registry scannt `<repo>/shims/*/adapter.json`
- Container: `server/Dockerfile` kopiert alle Manifeste nach `/app/adapters/<id>.json`; alternativ Env `ADAPTERS_DIR` auf ein eigenes Verzeichnis zeigen lassen
- Präzedenz bei gleicher Adapter-`id`: `ADAPTERS_DIR` > `<repo>/shims/*` > gebündelte `/app/adapters` — ein eigenes Manifest (z. B. mit gepinntem `image`-Digest) überschreibt also nie kommentarlos das eingebaute; die gewählte Reihenfolge steht beim Start im Log
- App: holt Adapter via WS `adapter.list` beim Verbinden; Provider-/Model-Defaults und Approval-Warnbanner kommen aus dem Manifest
