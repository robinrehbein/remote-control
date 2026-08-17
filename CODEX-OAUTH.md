# Codex-OAuth in der App: Login-Flow-Konzept

Ziel: In der Android-App **Codex auswählen → im Browser mit ChatGPT einloggen → fertig** —
ohne Token-Kopieren vom Laptop. Grundlage ist die Analyse der Login-Implementierung im
offenen `openai/codex`-Repo (Rust-Crate `codex-rs/login/`, App-Server-Methoden in
`codex-rs/app-server/src/request_processors/account_processor.rs`).

## 1. Die entscheidenden Fakten aus dem Codex-Quellcode

| Aspekt | Befund |
|---|---|
| Callback-Server | `codex login` bindet **strikt 127.0.0.1**, Port **1455** (Fallback 1457), Pfad `/auth/callback` |
| Redirect-URI | `http://localhost:{port}/auth/callback` — Port ist an OpenAIs Allowlist gebunden, Host nicht änderbar |
| PKCE | S256; der `code_verifier` bleibt **im Speicher des Login-Prozesses** |
| **Callback-Forwarding** | **Funktioniert.** Der Callback ist nicht an Browser-Session, Cookies oder IP gebunden — es müssen nur `code` + `state` als HTTP-GET beim Login-Prozess ankommen (belegt durch Codex' eigene E2E-Tests, `login/tests/suite/login_server_e2e.rs`) |
| Programmatische API | `codex app-server` bietet `login_chatgpt` (JSON-RPC): Antwort enthält `login_id` + `auth_url`, Abschluss kommt als `AccountLoginCompletedNotification`; auch `login_chatgpt_device_code` und `cancel_login_account` existieren |
| Device-Flow | `codex login --device-auth`: Verification-URL + User-Code, 15 min gültig; **serverseitig gate-bar** (HTTP 404 = „not enabled") — nicht überall verfügbar |
| `auth.json` | `{CODEX_HOME}/auth.json`, mode 0600: `OPENAI_API_KEY` (aus Token-Exchange), `tokens.{id_token,access_token,refresh_token,account_id}`, `last_refresh`. Im File-Modus **portabel** (kein Device-Binding) |
| Refresh | proaktiv (exp < 5 min oder `last_refresh` > 8 Tage) gegen `auth.openai.com/oauth/token`; **Refresh-Token ist rotierend und single-use** — parallele Kopien der Datei invalidieren sich gegenseitig (`refresh_token_reused`) |

Konsequenz: Der offiziell erwähnte „SSH-Port-Forwarding"-Trick lässt sich 1:1 durch
**App-als-Forwarder** ersetzen — und dank der App-Server-JSON-RPC-Methoden braucht es kein
fragiles stderr-Parsen.

## 2. Empfohlener Flow (Variante A: Browser-Login mit Callback-Forwarding)

```
App                    Orchestrator                  Auth-Container (codex app-server)
 │  auth.start(codex)      │                              │
 │─────────────────────────▶│  Container/Volume starten   │
 │                          │────── login_chatgpt ───────▶│  (JSON-RPC)
 │                          │◀── {login_id, auth_url} ────│  Login-Server lauscht 127.0.0.1:1455
 │◀─ auth.url{url, port} ───│                              │
 │  Loopback-Listener auf   │                              │
 │  127.0.0.1:{port} starten│                              │
 │  Custom Tab: auth_url    │                              │
 │  … Nutzer loggt sich bei auth.openai.com ein …          │
 │  Browser-Redirect auf localhost:{port}/auth/callback?code&state
 │  → App-Listener fängt code+state                        │
 │─ auth.callback{code,state} ▶                            │
 │                          │── GET /auth/callback?code&state ▶ (in den Container)
 │                          │      Token-Exchange (PKCE-Verifier ist dort)
 │                          │      → auth.json ins CODEX_HOME-Volume
 │                          │◀─ AccountLoginCompletedNotification ─│
 │◀── auth.done{account} ───│  auth.json → Vault-Backup    │
```

Details:

1. **Server-Seite**: Der Orchestrator startet einen kurzlebigen Auth-Container (das
   codex-shim-Image) mit dem benannten Volume `codex-home-<userId>` und ruft per JSON-RPC
   `login_chatgpt` auf. Kein stderr-Parsen; `auth_url` und Abschluss kommen strukturiert.
2. **Neue WS-Nachrichten** (analog zum bestehenden `secret.*`-Muster):
   `auth.start{adapter}`, `auth.url{requestId, url, port}`, `auth.callback{requestId,
   code, state}`, `auth.done{requestId, ok, account?, error?}`, `auth.cancel{requestId}`.
3. **App-Seite**: Beim `auth.url` startet die App einen minimalen HTTP-Listener auf
   `127.0.0.1:{port}` (1455, ggf. 1457 — **der Server teilt den tatsächlich gebundenen
   Port mit**, App muss denselben nehmen) und öffnet die `auth_url` im Custom Tab. Der
   Redirect nach dem Login geht an `localhost` **auf dem Handy**, der Listener extrahiert
   `code` + `state`, schickt sie über den bestehenden WSS-Kanal und antwortet dem Browser
   mit einer kleinen Erfolgsseite („Zurück zur App"-Deep-Link). Listener sofort beenden.
4. **Sicherheit**: `code_verifier` verlässt nie den Container; `code`+`state` sind
   einmalig verwendbar und laufen über den ohnehin Device-Token-authentifizierten WSS;
   der Phone-Listener bindet nur loopback und lebt nur für die Dauer des Flows. Der
   Orchestrator validiert nichts selbst — State-Prüfung macht der Codex-Login-Server.

## 3. Fallbacks

- **Variante B — Device-Code** (`login_chatgpt_device_code`): App zeigt Verification-URL
  + Code an („auf beliebigem Gerät öffnen"). Kein Listener nötig, funktioniert auch, wenn
  Port 1455 auf dem Handy belegt ist — aber serverseitig nicht für jeden Account
  freigeschaltet (404 ⇒ automatisch auf Variante A zurückfallen, wie es Codex' eigener
  `run_login_with_device_code_fallback_to_browser` auch tut).
- **Variante C — API-Key**: bestehender `secret.set`-Weg (`OPENAI_API_KEY` bzw.
  `codex login --with-api-key` via stdin) für BYOK; keine App-Änderung nötig.

## 4. Token-Verwaltung nach dem Login

- **Ein kanonisches `CODEX_HOME` pro Nutzer** als benanntes Docker-Volume, **rw** in jeden
  Codex-Session-Container gemountet. Wegen des **rotierenden, single-use Refresh-Tokens**
  darf `auth.json` nicht in N Container kopiert werden — Kopien invalidieren sich beim
  ersten Refresh gegenseitig. Ein geteiltes Volume aktualisiert die Datei in-place; das
  verbleibende Restrisiko (zwei Container refreshen im selben 5-Minuten-Fenster) ist
  klein, sollte aber im RUNBOOK stehen.
- **Vault-Backup**: Nach `auth.done` (und periodisch, da Rotation die Datei ändert) liest
  der Orchestrator `auth.json` aus dem Volume und legt sie verschlüsselt im Vault ab
  (Secret-Kind `codex_oauth`), damit ein Volume-Verlust keinen Re-Login erzwingt.
  Achtung: Ein *altes* Backup kann wegen Rotation bereits tot sein — beim Restore
  validieren und ggf. Re-Login anstoßen.
- **Kein paralleler Login desselben Accounts** auf Laptop + PocketAgent mit *kopierter*
  Datei; getrennte Logins (eigene Refresh-Token-Ketten) sind hingegen unproblematisch.
- `secret-validate.ts`: für `codex_oauth` den `account_id`-/Plan-Claim aus dem `id_token`
  dekodieren und als Detail anzeigen („ChatGPT Plus, Account …") statt Live-Request.

## 5. Generalisierung im Adapter-Manifest

Damit das nicht Codex-Sonderlocke bleibt, deklariert das Manifest den Auth-Flow-Typ:

```jsonc
"authFlows": [
  { "type": "oauth-loopback", "ports": [1455, 1457] },   // codex
  { "type": "device-code" },                               // codex (Fallback)
  { "type": "token-paste", "hint": "claude setup-token" }, // claude heute
  { "type": "api-key", "keyUrl": "https://…" }
]
```

Die App rendert daraus generisch: „Mit <Anbieter> anmelden" (oauth-loopback/device-code)
oder das bestehende Eingabefeld. Derselbe Loopback-Forwarder deckt künftig jeden Harness
ab, dessen CLI einen localhost-OAuth-Callback nutzt.

## 6. Aufwandsschätzung

| Baustein | Umfang |
|---|---|
| Server: Auth-Flow-Endpunkt + JSON-RPC-Client + Volume/Vault-Handling | ~1–2 Tage |
| App: WS-Nachrichten, Loopback-Listener, Custom Tab, Settings-UI | ~1–2 Tage |
| codex-shim selbst (siehe KILO-CLOUD-ANALYSE.md §4) | Voraussetzung, ~2–3 Tage |

Quellen: `openai/codex` — `codex-rs/login/src/{server.rs,device_code_auth.rs,pkce.rs,
auth/manager.rs,auth/storage.rs}`, `codex-rs/app-server/src/request_processors/
account_processor.rs`, E2E-Beleg `codex-rs/login/tests/suite/login_server_e2e.rs`.
