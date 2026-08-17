# Entwicklungsplan: PocketAgent → persönliche Agent-Fernbedienung

Beschlossene Rahmenbedingungen (17.08.2026):

- **Zielbild**: Persönliches Werkzeug (kein Produkt für Dritte). Jeden Agent (Claude Code,
  Codex, Kilo, pi, Junie) vom Handy steuern — auf dem Server (Cloud-Sessions) oder dem PC
  (`link/`), auch wenn der PC aus ist. Subscriptions nutzbar (offizielle Harnesses laufen
  unverändert in Containern), kein Vendor-Lock-in. **Kein eigener Harness** — der würde
  Subscription-Auth verlieren; der Protokoll-Layer ist der richtige Ort für Einheitlichkeit.
- **UX-Nordstern**: Fernbedienung > Chat. Statusliste + Approvals + Diff→Push→PR sind der
  Kern, Chat ist eine Ebene dahinter.
- **opencode-Adapter fliegt raus** (Kilo bleibt als OpenCode-Stamm).
- **Lieferung**: ein Branch (`claude/<paket>`) + PR gegen `main` **pro Arbeitspaket**.
  Merge erfolgt **autonom** (Robins Anweisung vom 17.08.): sobald Tests/CI grün sind, wird
  der PR ohne Rückfrage gemergt; abhängige Pakete starten vom aktualisierten `main`.
- **Codex**: erst API-Key + Device-Code (autonom testbar); das In-App-Browser-OAuth-Paket
  (W3.4) wird direkt nach W2.3 gestartet — nur der finale Login-Test am Handy bleibt manuell.

Referenzen: `APP-REVIEW.md` (71 Funde, Details mit Datei:Zeile + Fix-Vorschlag),
`KILO-CLOUD-ANALYSE.md` (Architektur-Muster, codex-shim-Bauplan), `CODEX-OAUTH.md`
(OAuth-Flow-Konzept).

## Arbeitsweise der Subagenten

- Jedes Paket bearbeitet **ein** Agent in einem isolierten Worktree, Branch ab
  `origin/main`, Modellwahl laut Tabelle (Opus 5 für nebenläufigkeits-/protokoll-/
  security-kritische Pakete, Sonnet 5 für gut abgegrenzte Fixes).
- Pflicht pro Paket: relevante Abschnitte aus `APP-REVIEW.md` lesen; Fix implementieren;
  **Tests ausführen** (Server: `npm test` bzw. Smoke-Suite in `server/src/smoke.ts`;
  Android: `./gradlew test` in `android/`); bei Protokolländerungen
  `packages/protocol` zuerst; Commit-Messages konventionell, Draft-PR mit
  Funde-Referenzen.
- Kein Paket ändert Dateien außerhalb seines Zuschnitts; Überschneidungen sind unten als
  Abhängigkeit markiert.

## Welle 1 — Stabilität (keine neuen Features)

| Paket | Branch | Inhalt (Funde aus APP-REVIEW.md) | Modell |
|---|---|---|---|
| W1.1 Lifecycle | `claude/fix-lifecycle` | GC nach `last_active_at` statt `created_at`; Generation-Counter/Abort-Checks in `provision()`/`reprovisionAdapter()`/`resumeSession()` (nach jedem `await`); Label-basierter Orphan-Reaper beim Start; `creating`-Recovery in `reconcile`; Container-Stop bei fehlgeschlagener Provisionierung; `oneShotPush`-Leak; Resume-Re-Entrancy; Prompt-Status-Gate | Opus |
| W1.2 Egress | `claude/fix-egress` | `networkPolicy: isolated` im Proxy pro Session durchsetzen; `Proxy-Authorization` vor Upstream strippen; private/link-local IPs nach DNS-Resolve blocken; Gateway-Proxy authentifizieren; Port-Gate für Plain-HTTP; Egress-Token timing-safe + nur laufende Sessions | Opus |
| W1.3 Link-Agent | `claude/fix-link-agent` | `wss://`→`ws://`-Downgrade beheben; Shim-Port pro SSE-Verbindung neu auflösen; Restart nach Health-Wait-Crash; `eventQueue`-Obergrenze | Sonnet |
| W1.4 Server-Rest | `claude/fix-server-hardening` | `waitForShim`-HTTP-Status prüfen; `/api/secrets` mit AAD + Rate-Limit; WS `secret.set` kind-Validierung; Secrets eindeutig pro (tenant,kind); `session_events`-Index; Manifest-Validierung (`adapters.ts`); ADAPTERS_DIR-Präzedenz; Pending-Link-Calls bei Socket-Close; WS-Auth-Timeout; Event-Injection nur in eigene Link-Sessions | Sonnet |
| W1.5 Android-Bugs | `claude/fix-android-bugs` | `onClosing` implementieren (4001-Erkennung + kein Auto-Reconnect bei Unauthorized); Biometrie-Gate ohne `collectAsState`-Initialwert-Lücke; FCM: Deep-Link-Intent, eigener Kanal/Icon, Token aktiv abholen; doppelte WS-Verbindungen; Pairing-Timeout; unbekannte Enums tolerant decoden | Sonnet |
| W1.6 opencode raus | `claude/remove-opencode` | `shims/opencode/` entfernen; Registry/Bundling, docker-compose-Profil, Smoke-Tests, Doku (README/ADAPTERS.md) bereinigen; prüfen, dass kilo-shim nichts importiert | Sonnet |

Reihenfolge: W1.1 → dann W1.2 (beide berühren `docker.ts`); W1.3/W1.5/W1.6 parallel;
W1.4 nach W1.1 (berührt `sessions.ts`/`ws.ts`).

## Welle 2 — Event-Integrität & Codex

| Paket | Branch | Inhalt | Modell |
|---|---|---|---|
| W2.1 Event-Replay | `claude/event-replay` | Monotone Event-IDs im Protokoll (`packages/protocol`); Ringpuffer (~1000 Events) + SSE `id:`/`Last-Event-ID`-Replay in allen Shims (geteilte Utility); Cursor im `shim-client`; Dedup bei Persistenz; `withShim()` reißt gesunde Streams nicht mehr ab | Opus |
| W2.2 Turn-Lifecycle | `claude/turn-lifecycle` | Kilo-P1: App-generierte Message-IDs mit Echo (Ambiguous-Admission-Regel), Turn-Status-Ressource (`queued→running→completed/failed/interrupted`) in DB + WS + App-Anzeige | Opus |
| W2.3 Codex-Shim | `claude/codex-shim` | Neuer Adapter nach `KILO-CLOUD-ANALYSE.md` §4: `codex app-server` (JSON-RPC/stdio), Modi-Mapping, `adapter.json` mit `authFlows`, `OPENAI_API_KEY` + Device-Code, `CODEX_HOME`-Volume, Dockerfile, Smoke-Test | Opus |
| W2.4 Link-Relay | `claude/link-relay` | Kilo-P2: Heartbeat mit Vollzustand aller Sessions, `protocolVersion` + Capability-Flags, terminale Close-Codes | Sonnet |

W2.1 vor W2.2 (beide ändern Protokoll + `sessions.ts`). W2.3/W2.4 unabhängig.

## Welle 3 — Fernbedienung-first (Android)

| Paket | Branch | Inhalt | Modell |
|---|---|---|---|
| W3.1 Fluss-Endpunkte | `claude/ux-flow-endpoints` | Diff→Push→PR als sichtbarer Abschluss: Aktionsleiste im DiffScreen, klickbare PushCard/PR-Zeile (Browser-Intent), ein Stop-Konzept, Unauthorized-Hinweis korrigieren | Opus |
| W3.2 Reduktion | `claude/ux-reduction` | Session-Karten-Chips reduzieren; Doppel-Metadaten im SessionScreen; „Autonomie"=„Modus" vereinheitlichen (deutsche Labels); NewSession auf 2 Kern-Entscheidungen (Rest hinter „Erweitert" mit Label); Repository-Sheet statt Dropdown; Secret-Katalog aufräumen (Duplikate, Klartextnamen); Secret-Löschen mit Bestätigung/Undo; Wisch-Richtung; Empty-States/Kaltstart; Approval-Karten-Hierarchie (Erlauben primär, Immer sekundär) | Sonnet |
| W3.3 Notifications | `claude/ux-notifications` | Actionable FCM: Approve/Deny direkt aus der Notification, Deep-Link in die Session, Gruppierung pro Session | Sonnet |
| W3.4 Codex-OAuth | `claude/codex-oauth-app` | `CODEX-OAUTH.md` Variante A: WS-Nachrichten `auth.*`, Loopback-Listener + Custom Tab in der App, Auth-Container-Flow im Server, Vault-Backup. **Endet mit manuellem Test durch Robin am Handy** | Opus |

W3.1/W3.2 nacheinander (gleiche Screens), W3.3 danach, W3.4 nach W2.3.

## Abnahme-Kriterien (jede Welle)

1. Alle bestehenden Tests grün (Server-Smoke, Android-Unit-Tests, CI-APK-Build).
2. Neue Logik hat mindestens einen Test, der den ursprünglichen Fund reproduziert hätte.
3. `APP-REVIEW.md`-Funde, die ein PR behebt, sind im PR-Text referenziert.
4. Kein Paket führt neue Konfigurationspflichten ein, ohne README/RUNBOOK zu aktualisieren.
