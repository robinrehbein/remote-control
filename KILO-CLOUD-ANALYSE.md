# Kilo Cloud Sessions: Analyse & Übernahme-Empfehlungen für PocketAgent

Analyse der Kilo-Code-Cloud-Agents-Architektur (Quellcode `Kilo-Org/kilocode`, offizielle
Architektur-Doku; die Server-Seite `Kilo-Org/cloud` ist closed-source und wurde aus den
Client-Verträgen rekonstruiert) — mit dem Ziel, die gleichen Muster **generisch** über das
bestehende PocketAgent-Shim-Protokoll für **Claude Code, OpenAI Codex, JetBrains Junie, pi
und Kilo Code** verfügbar zu machen.

---

## 1. Wie Kilo Cloud Sessions umsetzt (Kurzfassung)

Kilos zentrale Entscheidung: **Alle Produkte (IDE, TUI, Cloud, Mobile) sind Clients derselben
CLI-Runtime** (`kilo serve`, HTTP + SSE). Die Cloud orchestriert also keine eigene
Agent-Implementierung, sondern dieselbe Runtime in einem Container. Darüber liegen vier
getrennte Dienste:

| Ebene | Dienst | Aufgabe |
|---|---|---|
| Orchestrierung | `cloud-agent-next` (Cloudflare Durable Objects, queue-first) | Session-Admission, Turn-Queue, Container-Zuteilung |
| Transkript | `ingest.kilosessions.ai` | Session-Mirroring, Export/Import, Sharing |
| Stream | WSS mit kurzlebigem Ticket | Live-Events an Web/Mobile/CLI |
| Kontrollebene | Web-App / Gateway | Auth, Env-Profile, Trigger, Billing |

Betriebsmodell im Container: **ein Container pro User, ein Workspace-Verzeichnis pro
Session, ein Branch pro Session**; nach jedem Turn Auto-Commit + Push (Git ist die
Persistenz-/Recovery-Ebene, Container sind ephemer). Env-Profile (Vars + verschlüsselte
Secrets + Setup-Commands) sind eine eigene, wiederverwendbare Ressource; Webhook- und
Cron-Trigger starten Sessions ohne App. Cloud-Turns laufen immer im Yolo-Modus mit
15-Minuten-Limit pro Message.

Das Gegenstück zu PocketAgents `link/` heißt bei Kilo **Remote Connections** (`kilo remote`):
Die lokale CLI verbindet sich outbound per WebSocket mit einem Relay, meldet per Heartbeat
(alle 10 s) die **vollständige** Session-Liste inkl. Status, und Web/Mobile senden Commands
(`send_message`, `interrupt`, `permission_respond`, `question_reply`, `create_session`)
über das Relay zurück. Handoff Cloud → lokal ist ein **Fork**: Transkript-Export, komplettes
ID-Remapping, transaktionaler Import, und die kumulierten Datei-Diffs werden auf den lokalen
Worktree angewendet.

## 2. Vergleich mit PocketAgent heute

PocketAgent hat die Grundarchitektur bereits richtig — und in einem Punkt *generischer* als
Kilo: Kilo kann nur die eigene Runtime orchestrieren, PocketAgent über die Adapter-Registry
beliebige Harnesses.

| Dimension | Kilo Cloud | PocketAgent heute | Bewertung |
|---|---|---|---|
| Agent-Anbindung | nur Kilo-CLI (`kilo serve`) | Shim-Protokoll, 5 Harnesses | **PocketAgent generischer** ✔ |
| Isolation | 1 Container/User, Workspace/Session | 1 Container/Session | beide legitim; PocketAgent stärker isoliert, teurer bei vielen Sessions |
| Git-Persistenz | Branch/Session, Auto-Commit+Push je Turn | `agent/<session-id>`, Auto-Commit je Turn, Push je nach Modus | gleichwertig |
| Turn-Admission | queue-first, client-generierte Message-IDs, expliziter Message-Status (`queued→running→terminal`) | direkter `POST /prompt` an den Shim | **Kilo robuster** → übernehmen |
| Live-Stream | WSS mit kurzlebigem Ticket, getrennt vom API-Token | WS mit Device-Token | Ticket-Muster übernehmen, falls je ein zweiter Client-Typ (Web) kommt |
| Lokale Workspaces | `kilo remote`: Heartbeat-Vollzustand, Command-Relay, Capability-Flags | `link/`-Agent | gleiches Konzept; Kilos Protokoll-Details sind die reifere Vorlage |
| Handoff Cloud↔lokal | Fork mit ID-Remap + Diff-Replay | — | optionales Feature, sauberes Vorbild |
| Env-Konfiguration | Env-Profile als eigene Ressource, von Triggern referenzierbar | Secrets im Vault, pro Session injiziert | **Profile-Konzept übernehmen** |
| Automatisierung | Webhook-/Cron-Trigger mit Prompt-Templates, harten Limits | — | übernehmen (kleiner Aufwand, großer Nutzen) |
| Modi/Permissions | Cloud immer Yolo | 4 Modi inkl. Approval-Karten in der App | **PocketAgent kann mehr** ✔ |

## 3. Was konkret übernommen werden sollte (priorisiert)

### P1 — Robustheit des Turn-Lebenszyklus (queue-first light)

Kilos wertvollstes Muster, unabhängig von Cloudflare umsetzbar:

1. **Client-generierte Message-IDs.** Die App erzeugt pro Prompt eine ID
   (`msg_<random>`); Orchestrator und Shim echoen sie. Antwortet der Server nach einem
   Netzwerkfehler nicht mit derselben ID, gilt die Admission als *unklar* und wird nicht
   automatisch retried → keine doppelten Agent-Turns bei Funklöchern (Android!).
2. **Message-Status als eigene Ressource.** Statt nur Session-Status ein pro-Turn-Status
   `queued → running → completed | failed | interrupted` mit strukturierten
   Failure-Objekten (`stage`, `code`, `retryable`) und Zeitstempeln. Der Orchestrator
   persistiert das in SQLite; die App kann nach Reconnect jeden Turn eindeutig
   rekonstruieren statt aus dem Event-Strom zu raten.
3. **Turn-Queue im Orchestrator.** Prompts werden angenommen (persistiert) und dann an den
   Shim übergeben; stirbt der Container zwischen Annahme und Start, kann der Orchestrator
   den Turn nach Container-Neustart erneut zustellen — Grundlage auch für Trigger (P3).

### P2 — Link-Agent auf Kilos Relay-Muster heben

Das `link/`-Konzept ist identisch zu `kilo remote`; drei Protokoll-Details von Kilo machen
es deutlich robuster:

- **Heartbeat als Vollzustand:** Der Link-Agent sendet periodisch die komplette
  Session-Liste inkl. Status (`idle|busy|question|permission`) statt Deltas. Der Server
  braucht kein Delta-Tracking, Reconnects sind trivial korrekt.
- **Capability-Advertisement:** `protocolVersion` + Feature-Flags im Heartbeat, damit
  App/Server additiv neue Features ausrollen können, ohne alte Link-Agents zu brechen.
- **Klare Terminal-Close-Codes:** Auth-/Konflikt-Fehler (à la 4401/4403/4409) beenden den
  Reconnect-Loop, alles andere reconnectet mit Backoff und begrenztem Sende-Puffer.

### P3 — Env-Profile & Trigger

- **Env-Profile:** benannte Bundles aus Plain-Vars, Vault-Secrets und Setup-Commands als
  eigene DB-Entität; Sessions und Trigger referenzieren ein Profil statt Einzel-Secrets.
  Passt direkt auf den bestehenden Vault.
- **Trigger:** Webhook-URL (Token-geschützt) und Cron je Adapter+Repo+Profil+Prompt-Template
  (`{{body}}`, `{{timestamp}}`), mit Kilos harten Limits als Vorbild (Payload-Cap,
  max. parallele Runs, Mindestintervall). Ein Trigger-Run ist einfach eine normale Session
  im Yolo- oder Auto-Modus — die Infrastruktur dafür existiert schon.

### P4 — Optional: Ticket-Auth und Session-Export

- **Kurzlebige Stream-Tickets** statt des Device-Tokens in der WS-URL, sobald es neben der
  Android-App einen zweiten Consumer (Web-Dashboard, Sharing) gibt.
- **Session-Export/-Import** (Transkript + kumulierte Diffs, ID-Remap beim Import) als
  Handoff zwischen Server-Session und Link-Session — nice-to-have, klar spezifiziertes
  Vorbild in Kilos `cloudSessionImport`.

### Nicht übernehmen

Cloudflare-Spezifika (Durable Objects, Queues, R2), tRPC als Wire-Format, Kilos
In-Process-Multi-Session-Hosting und der Legacy-Doppelpfad im Storage — alles
Implementierungsdetails ohne Mehrwert gegenüber dem bestehenden Node/SQLite/Docker-Stack.

---

## 4. Codex-Shim: Bauplan für den sechsten Adapter

Damit die Zielliste (Claude Code, OpenAI Codex, Junie, pi, Kilo) vollständig ist, fehlt nur
Codex. Die richtige Integrationsfläche ist **`codex app-server`** (JSON-RPC-lite über
stdio) — derselbe Layer, der die offizielle VS-Code-Extension und das JetBrains-Plugin
treibt. `codex exec --json` scheidet für die Modi `acceptEdits`/`ask` aus, weil der
exec-Modus **keine Approval-Prompts** kennt.

### Endpoint-Mapping

| Shim-Endpoint | Codex app-server |
|---|---|
| `POST /prompt` | erster Turn: `thread/start` + `turn/start`; Folge-Prompts: `turn/steer` (laufender Turn) bzw. neuer `turn/start` |
| `POST /abort` | `turn/interrupt` |
| `POST /resume` | `thread/resume <threadId>` (Thread-ID im Shim-State; `CODEX_HOME` als Volume, sonst überlebt Resume den Container nicht) |
| `POST /permissions/:id` | Antwort auf server-initiierte Requests `item/commandExecution/requestApproval` und `item/fileChange/requestApproval` (`accept` / `decline` / `acceptWithExecpolicyAmendment` = „always allow"); Timeout ⇒ `decline` |
| `GET /events` (SSE) | `item/started` → `item/*/delta` → `item/completed` normalisieren: `agent_message`→Assistant-Text, `reasoning`→Thinking, `command_execution`→Tool-Use/-Result, `file_change`→Edit; `turn/completed`→Usage, `turn/failed`→Error |
| `GET /status` | eigener Tracker aus dem Turn-Lifecycle (`idle`/`running`/`awaiting-approval`) |
| `GET /diff` | `git diff` im Workspace (wie bei den anderen Adaptern) |

### Modi-Mapping

| PocketAgent-Modus | `approval_policy` | `sandbox_mode` | Shim-Verhalten bei Approval-Request |
|---|---|---|---|
| Yolo | `never` | `danger-full-access` (der Docker-Container ist die Sandbox) | kommt nicht vor |
| Auto | `never` | `workspace-write` (+ `network_access=true`) | falls doch: auto-`accept` |
| AcceptEdits | `on-request` | `workspace-write` | `file_change` auto-`accept`; Commands → Approval-Karte |
| Ask | `untrusted` | `workspace-write` | alles → Approval-Karte |

### Betriebs-Hinweise

- **Auth:** primär `CODEX_HOME` mit `auth.json` als **beschreibbares** Volume (Token-Refresh)
  für ChatGPT-Subscription; alternativ einmalig `codex login --device-auth` (Code in der App
  anzeigen); `OPENAI_API_KEY` als BYOK-Weg. OpenAI empfiehlt für Automation offiziell
  API-Keys; Subscription-Auth im eigenen Dev-Container ist Grauzone (Plan-Rate-Limits gelten).
- **Robustheit:** Codex-Version im Image pinnen und Event-Typen per
  `codex app-server generate-ts` aus der gepinnten Version generieren; unbekannte
  Event-Typen tolerant ignorieren; JSON-RPC-Fehler `-32001` (Overload, Queue 128) mit
  Backoff behandeln; SIGTERM-Drain beim Container-Stop; dediziertes `CODEX_HOME` +
  `--ignore-user-config`, damit User-Config das Policy-Mapping nicht überschreibt.
- **Referenz:** der promptfoo-Provider `openai-codex-app-server` implementiert genau dieses
  Muster (Child-Prozess, thread/turn, deterministische Approval-Policy) und taugt als
  Vorlage.

---

## 5. Vorgeschlagene Reihenfolge

1. **Codex-Shim** (§4) — schließt die Harness-Lücke; Aufwand vergleichbar mit dem pi-Shim.
2. **Turn-Lebenszyklus** (P1) — client-generierte Message-IDs + Message-Status-Ressource;
   größter Robustheitsgewinn für die mobile Nutzung.
3. **Link-Agent-Protokoll** (P2) — Heartbeat-Vollzustand + Capability-Flags.
4. **Env-Profile + Trigger** (P3) — macht aus PocketAgent eine Automationsplattform
   (Kilos „Cloud Agents + Triggers" in generisch).
5. **Ticket-Auth / Export** (P4) — erst bei zweitem Client-Typ bzw. Handoff-Bedarf.

## Quellen

- Kilo Cloud Platform Architecture: https://kilo.ai/docs/contributing/architecture/cloud-platform
- Kilo Cloud Agents (Nutzersicht): https://kilo.ai/docs/advanced-usage/cloud-agent
- Kilo-Quellcode (Client-Seite): https://github.com/Kilo-Org/kilocode —
  `packages/opencode/src/kilocode/cloud/` (tRPC-Client, Contracts, Stream-Ticket),
  `packages/opencode/src/kilo-sessions/` (Remote-Relay-Protokoll),
  `packages/opencode/src/kilocode/server/httpapi/handlers/kilo-gateway.ts` (Session-Import)
- Codex app-server: https://openai.com/index/unlocking-the-codex-harness/ ,
  https://developers.openai.com/codex/agent-approvals-security ,
  https://www.promptfoo.dev/docs/providers/openai-codex-app-server/
