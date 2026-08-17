# App-Review: PocketAgent (Multi-Agent-Review, August 2026)

Vollständiger Review von Server, Android-App und Link-Agent durch sechs spezialisierte
Review-Agents (Session-Kern, Docker/Egress, Security, Persistenz/Link, Android-Code,
Android-UX mit Dieter-Rams/Jony-Ive-Maßstab). Alle als `high`/`critical` gemeldeten
Server-Funde wurden anschließend von unabhängigen, skeptischen Verifizierer-Agents am
echten Code gegengeprüft: **alle 7 wurden bestätigt, 0 widerlegt.** Android-Funde wurden
nicht separat adversarial verifiziert (UX-Funde sind Design-Urteile, keine Bug-Behauptungen).

**Bilanz: 71 Funde** — Server 41 (7 hoch, 19 mittel, 15 niedrig), Android-Code 8,
Android-UX 22 (Prioritäten statt Severities).

## Executive Summary

### Die 7 bestätigten Server-Probleme (Reihenfolge = empfohlene Fix-Reihenfolge)

1. **GC zerstört aktive Sessions** (`sessions.ts:1046`): Die Garbage Collection löscht
   nach `created_at`, nicht nach Aktivität — eine täglich genutzte Session ist nach 14
   Tagen samt Volume weg. Echtes Datenverlust-Risiko im Normalbetrieb. Fix ist klein
   (auf `last_active_at` umstellen).
2. **Event-Verlust bei jedem Stream-Bruch** (`shim-client.ts:108` + alle Shims): Die
   SSE→WS-Kette hat keine Event-IDs, keinen Replay-Puffer, kein Last-Event-ID. Fällt
   `turn.completed` in eine Reconnect-Lücke, fehlt die Antwort dauerhaft in der Historie
   und die Session hängt in `running` (der Ping hält sie sogar vorm Idle-Reaper am
   Leben). Deckt sich exakt mit Empfehlung P1 aus `KILO-CLOUD-ANALYSE.md` —
   Sequenznummern + Ringpuffer im Shim, Cursor beim Reconnect.
3. **Lifecycle-Operationen nicht abbrechbar** (`sessions.ts:283`): Delete/Stop während
   `provision()`/`reprovision()`/`resume()` erzeugt verwaiste, weiterlaufende Container
   **mit injizierten Credentials**, die kein Reaper je findet, plus ewige
   SSE-Reconnect-Loops. Generation-Counter/Abort-Checks nach jedem `await` +
   Label-basierter Orphan-Reaper beim Start.
4. **`networkPolicy: isolated` ist wirkungslos** (`docker.ts:469`): Der Egress-Proxy
   hängt dual-homed am internen Netz und sein Peer-IP-Gate autorisiert jeden
   Session-Container unabhängig von dessen Policy — ein „isolierter" Agent kommt einfach
   über den Proxy raus. Policy muss im Proxy pro Session durchgesetzt werden.
5. **Session-Token leakt an externe Server** (`egress-proxy.ts:202`): Der Forward-Proxy
   reicht den `Proxy-Authorization`-Header (Shim-Token) an Upstream-Ziele weiter.
   Header vor dem Forward strippen.
6. **Link-Agent: `wss://` wird zu `ws://` degradiert** (`link/src/index.ts:174`): Explizit
   verschlüsselt konfigurierte URLs werden unverschlüsselt verbunden — Link-Token im
   Klartext übers Netz.
7. **Link-Agent: eingefrorener Shim-Port** (`link/src/index.ts:217`): Nach einem
   Shim-Neustart mit neuem Port gehen alle Events dauerhaft verloren.

### Android-Code: 3 gewichtige Fehler

Revozierte Geräte merken nie, dass sie revoziert sind (Close-Code 4001 wird mangels
`onClosing`-Implementierung nie gesehen — toter Code); die optionale Biometrie-Sperre
wird beim Kaltstart deterministisch umgangen (Gate prüft den `collectAsState`-Initialwert);
FCM-Pushes bei getöteter App haben keinen Deep-Link und umgehen Kanal/Icon.

### Android-UX: das Urteil in einem Satz

Die App ist handwerklich diszipliniert (Token-System, Statuspunkt-Primitive, bewusste
Zustände) — aber **der Zielpunkt des Produkts ist versteckt**: Diff prüfen → pushen →
PR öffnen ist ein Overflow-Menü und nicht-klickbare Karten statt der sichtbare letzte
Schritt jedes Flows. Dazu drei Schutzlücken (u. a. Secret-Löschen per Wisch ohne
Bestätigung/Undo). Empfehlung im Sinne von „weniger, aber besser": die Fernbedienungs-
Endpunkte (Approval, Diff, Push/PR) prominent machen, Metadaten-Chips und
Doppel-Anzeigen reduzieren, Begriffe vereinheitlichen („Autonomie" vs. „Modus").

### Empfohlene Reihenfolge

| Prio | Paket | Funde |
|---|---|---|
| 1 | Datenverlust & Orphans: GC-Kriterium, Abort-Checks, Orphan-Reaper, `creating`-Recovery | #1, #3, server-data |
| 2 | Event-Integrität: Sequenz-IDs + Replay (Shim-Protokoll erweitern) | #2 |
| 3 | Egress härten: Policy im Proxy, Header strippen, private IPs blocken, Gateway-Auth | #4, #5, docker-Bereich |
| 4 | Link-Agent: TLS-Fix (Einzeiler), Port-Refresh, Restart-Handling | #6, #7 |
| 5 | Android: onClosing/4001, Biometrie-Gate, FCM-Intent | android-code |
| 6 | UX-Paket: Diff→Push→PR-Fluss, Schutz destruktiver Aktionen, Reduktion | android-ux |

Die Detailfunde folgen pro Bereich, jeweils mit Datei:Zeile, Fehlerszenario und
konkretem Fix-Vorschlag.

---

## Server: Session-Kern & Event-Weiterleitung

**Gesamturteil:** Der Kern (SessionManager, WS-Hub, ShimClient) ist sauber strukturiert und gut kommentiert, hat aber systematische Luecken bei Nebenlaeufigkeit und Event-Zustellung. Die gravierendsten Probleme: (1) Die SSE->WS-Weiterleitung hat keinerlei Cursor-/Replay-Mechanik — der Shim-Broadcaster puffert nichts, der Orchestrator sendet kein Last-Event-ID, d.h. jede Reconnect-Luecke verliert Events endgueltig (inkl. turn.completed, wodurch Sessions in 'running' haengen bleiben). (2) Asynchrone Lifecycle-Operationen (provision, reprovision, resume) sind nicht abbrechbar und nicht gegeneinander serialisiert — Delete/Stop waehrend eines Starts fuehrt zu dauerhaft verwaisten Containern und ewigen SSE-Reconnect-Loops. (3) GC loescht rein nach created_at und zerstoert damit aktiv genutzte Sessions samt Volume nach 14 Tagen. Dazu kommen ein Trust-Boundary-Problem (Link-Agent kann Events in fremde Sessions injizieren) und fehlende HTTP-Status-Pruefung im ShimClient, die waitForShim Fehlerantworten als "ready" werten laesst.

### [HOCH] provision()/reprovision nicht abbrechbar: Delete/Stop waehrend des Starts erzeugt verwaiste Container und ewige SSE-Loops

`server/src/sessions.ts:283` — **verifiziert: bestätigt**

createSession startet provision() fire-and-forget ohne Abbruchflag. Faelle: (a) deleteSession() waehrend des Image-Builds (container_id noch null, setProvisioned erst Zeile 318): die Row wird geloescht, provision() laeuft weiter, erstellt und startet den Container, setProvisioned/setStatus laufen als UPDATE auf 0 Rows ins Leere (db.ts:357/303, kein Fehler), connectEvents() registriert einen ShimClient fuer die nicht mehr existente Session. Ergebnis: dauerhaft laufender Container, den weder reapIdle noch gc je findet (beide iterieren nur ueber DB-Rows; es gibt keinen Label-basierten Orphan-Cleanup), plus ein ewiger SSE-Reconnect-Loop und ein Leak im clients-Map bis zum Server-Neustart. appendEvent (db.ts:396, kein FK) fuegt zudem verwaiste session_events-Rows ein, die nie mehr geloescht werden. (b) stopSession() waehrend 'creating': setzt 'stopped', aber provision() laeuft weiter, startet den Container (erneut) und ueberschreibt den Status am Ende mit 'idle' — der explizit gestoppte Container laeuft wieder.

**Vorschlag:** Pro Session ein AbortSignal/Generation-Counter fuehren: provision()/reprovisionAdapter()/resumeSession() pruefen nach jedem await, ob die Session noch existiert und die eigene Generation noch aktuell ist, und raeumen sonst den eben erstellten Container selbst ab. Ergaenzend beim Serverstart (reconcile) Container mit Label pocketagent.session ohne zugehoerige DB-Row entfernen — das faengt auch Altlasten.

### [HOCH] GC loescht nach created_at: aktiv genutzte Sessions (inkl. Link-Sessions) werden nach 14 Tagen samt Volume zerstoert

`server/src/sessions.ts:1046` — **verifiziert: bestätigt**

gc() loescht jede Session, deren created_at aelter als GC_DAYS (Default 14) ist — ohne Ruecksicht auf status, last_active_at oder archived. Eine Session, die taeglich benutzt wird, wird am Tag 14 mitten in der Arbeit per deleteSession entsorgt: Container gestoppt+entfernt, Volume mit allen ungepushten Commits auf agent/<id> geloescht. Besonders hart trifft es Link-Sessions: die sind laut reapIdle-Kommentar (Zeile 1033) bewusst langlebig, ueberschreiten die 14 Tage also garantiert; deleteSession sendet dann agent.bye (Zeile 886) und faehrt damit den Agenten auf dem Rechner des Users herunter.

**Vorschlag:** Cutoff auf last_active_at statt created_at beziehen, laufende/idle Sessions sowie Link-Sessions vom GC ausnehmen (oder nur 'stopped'/'error' mit last_active_at < cutoff loeschen).

### [HOCH] SSE-Weiterleitung ohne Cursor/Replay: Event-Verlust bei jedem Reconnect

`server/src/shim-client.ts:108` — **verifiziert: bestätigt**

eventLoop() verbindet nach Abbruch erst nach RECONNECT_MS=3s neu und sendet kein Last-Event-ID; der Shim-Broadcaster (shims/opencode/src/events.ts:16-25, gleiche Struktur in allen Shims) haelt keinerlei Backlog und schreibt nur an aktuell verbundene Clients. Jedes Event, das waehrend einer Reconnect-Luecke, eines Orchestrator-Redeploys oder eines durch withShim() (sessions.ts:521) ausgeloesten Stream-Neustarts emittiert wird, geht endgueltig verloren: es wird nie persistiert (persistEvent sieht nur, was SSE liefert) und nie an die App gebroadcastet. Konkretes Szenario: turn.completed faellt in die 3s-Luecke -> onEvent (sessions.ts:461-462) setzt nie idle -> Session haengt in 'running', bis der Idle-Reaper sie nach IDLE_STOP_SEC stoppt; die Assistant-Antwort fehlt dauerhaft in der Historie. Verschaerft: withShim() ruft bei jedem Transport-Timeout (auch einem langsamen /diff//models-Call, 10s Timeout) connectEvents() und reisst damit einen gesunden Event-Stream mitten im Turn ab.

**Vorschlag:** Sequenznummern einfuehren: Shim vergibt pro Event eine monotone id, sendet sie als SSE `id:`-Feld und haelt einen Ringpuffer (z.B. letzte 1000 Events); Orchestrator merkt sich die letzte id pro Session und sendet sie beim Reconnect als Last-Event-ID, Shim replayt ab dort. Zusaetzlich in withShim() connectEvents() nur aufrufen, wenn attachOrchestratorTo tatsaechlich eine Netzanbindung neu hergestellt hat, nicht bei jedem null-Ergebnis.

### [MITTEL] AgentEvent hat keine Sequenz-/Event-ID: Client kann Historie und Live-Stream nicht deduplizieren

`packages/protocol/src/index.ts:260`

Weder AgentEvent noch session.event/session.events tragen eine id oder Sequenznummer, und session.events.get kennt nur `limit` (juengste N), keinen Cursor. Ein Client, der waehrend eines laufenden Turns die Historie nachlaedt (App-Restart, Screen-Wechsel — genau der dokumentierte Zweck), bekommt Events, die er parallel schon als session.event-Broadcast erhalten hat, und kann sie mangels ID nicht deduplizieren -> doppelte Nachrichten/Tool-Calls in der Timeline; umgekehrt fehlen Events, die zwischen Antwort und Broadcast-Empfang lagen, wenn er die Reihenfolge falsch mischt. Aeltere Eintraege als die juengsten N sind gar nicht erreichbar (kein Paging). Die SQLite-Tabelle hat bereits ein monotones `id` (db.ts:424 sortiert danach), es wird nur nicht exponiert.

**Vorschlag:** Das vorhandene session_events.id als `seq` in session.events und session.event mitgeben; session.events.get um `beforeSeq`/`afterSeq` erweitern. Loest Dedupe und Paging in einem und ist die Basis fuer die Shim-seitige Last-Event-ID-Mechanik (siehe SSE-Finding).

### [MITTEL] prompt() ohne Status-Gate: Prompt waehrend 'creating' erzeugt widerspruechliche Zustandsuebergaenge

`server/src/sessions.ts:572`

prompt() prueft row.status nicht. Zeitfenster: nach setProvisioned (Zeile 318) hat die Row einen shim_token, waitForShim laeuft aber noch. Ein Prompt (z.B. vom zweiten Geraet, das die Session per creating-Broadcast schon kennt) setzt dann status 'running' (Zeile 573), withShim scheitert am noch bootenden Shim (10s Timeout + Re-Attach + Retry) und setzt 'error' + fatales Error-Event (Zeile 577-578) — waehrend die weiterlaufende Provisionierung Sekunden spaeter 'idle' setzt (Zeile 327). Die App sieht creating -> running -> error(fatal) -> idle fuer eine voellig gesunde Session. Auch zwei parallele Prompts verschiedener Geraete auf einer 'running'-Session werden ungeprueft an den Shim durchgereicht.

**Vorschlag:** Am Anfang von prompt() (und abort()) den Status pruefen: bei 'creating' mit klarer Meldung ablehnen ('Session startet noch'), bei 'running' entweder ablehnen oder explizit queuen. Das entfernt auch den irrefuehrenden 'session not provisioned'-Fehler fuer Aborts waehrend des Starts.

### [MITTEL] resumeSession ohne Re-Entrancy-Schutz: parallele Resumes erzeugen doppelte Container (einer leakt)

`server/src/sessions.ts:781`

resumeSession() hat weder Status-Check (auch 'creating'/'running' resumebar) noch In-Flight-Lock. Zwei gleichzeitige session.resume (Doppel-Tap, zwei Geraete) lesen beide dieselbe Row; ist der alte Container weg, rufen beide createSessionContainer — Container werden ohne festen Namen erstellt (docker.ts:639, nur Label), also entstehen zwei. store.setContainer gewinnt last-write (Zeile 793/797), der Verlierer-Container laeuft weiter und wird von keinem Codepfad je aufgeraeumt (kein Label-basierter Orphan-Cleanup existiert). Dieselbe Race besteht zwischen resumeSession und reprovisionAdapter (Adapter-Wechsel-Ack kommt sofort, Reprovision laeuft asynchron).

**Vorschlag:** Pro Session ein in-flight-Promise/Mutex fuer Lifecycle-Operationen (provision/resume/reprovision/stop/delete) fuehren: zweiter Aufruf wartet auf den ersten oder wird abgelehnt. Alternativ minimal: Container mit deterministischem Namen (pocketagent-sess-<id>) erstellen, dann schlaegt das zweite Create hart fehl statt zu leaken.

### [MITTEL] Fehlgeschlagene Provisionierung laesst den Container weiterlaufen

`server/src/sessions.ts:328`

Der catch-Block von provision() (und identisch reprovisionAdapter Zeile 694-700) setzt nur status 'error' und emittiert das Fehler-Event — der ggf. bereits gestartete Container wird nicht gestoppt. Konkret: waitForShim laeuft nach 60s in den Timeout, waehrend der Shim noch in einem langsamen Clone haengt oder in einer Crash-Loop CPU frisst; der Container laeuft unbegrenzt weiter. reapIdle (Zeile 1030-1041) stoppt nur 'running'/'idle'-Sessions, 'error'-Sessions nie — die Ressourcen (RAM-Limit reserviert, CPU) bleiben belegt, bis der User die Session manuell loescht oder resumed.

**Vorschlag:** Im catch von provision()/reprovisionAdapter den bekannten Container (cid bzw. row.container_id) per docker.stopContainer best-effort stoppen; alternativ reapIdle auch auf 'error'-Sessions mit laufendem Container anwenden.

### [MITTEL] HTTP-Status wird ignoriert: waitForShim wertet Fehlerantworten als "Shim bereit"

`server/src/shim-client.ts:62`

call() prueft res.ok/res.status nie — jede Antwort mit parsebarem JSON-Body wird als Erfolg vom Typ T zurueckgegeben. waitForShim (sessions.ts:408) prueft nur Truthiness: `if (await client.status()) return;`. Ein 502/401/500 mit JSON-Body (z.B. der Gateway antwortet {"error":"upstream not ready"} solange der Shim noch bootet, oder ein Reverse-Proxy liefert eine JSON-Fehlerseite) beendet das Warten sofort, die Session wird 'idle' gemeldet, und der erste Prompt schlaegt fehl. Umgekehrt fuehrt eine Nicht-JSON-Fehlerseite (HTML 503) zu null und loest in withShim() einen unnoetigen Netz-Re-Attach samt Event-Stream-Neustart aus (siehe Event-Verlust-Finding).

**Vorschlag:** In call() `if (!res.ok) ...` behandeln: 4xx/5xx als strukturierter Fehler (nicht null, nicht T) zurueckgeben; waitForShim explizit auf eine valide ShimStatus-Antwort (Feld `adapter`/`busy` vorhanden) pruefen statt auf Truthiness.

### [MITTEL] Link-Agent kann Events in beliebige fremde Sessions injizieren

`server/src/ws.ts:319`

Im Link-Zweig wird msg.sessionId aus dem agent.event-Frame ungeprueft an manager.handleLinkEvent() durchgereicht. Ein authentifizierter (oder kompromittierter) Link-Host kann damit Events in jede andere Session schreiben: gefaelschte permission.request-Events loesen FCM-Pushes aus, ein injiziertes turn.completed kippt eine fremde 'running'-Session auf 'idle' (sessions.ts:461-462), ein status-Event mit sessionRef ueberschreibt deren session_ref (sessions.ts:459 — beim naechsten Resume wird dann ein fremder/attacker-gewaehlter Runtime-Ref resumed), pushed setzt pr_url. Der Link ist an genau eine Session gebunden (registerLinkSession), die Bindung wird hier aber nicht durchgesetzt.

**Vorschlag:** sessionId serverseitig aus der Link-Bindung aufloesen statt aus dem Frame: row = store.getSessionByLink(linkId) und nur dessen id an handleLinkEvent geben (msg.sessionId ignorieren oder gegen row.id pruefen und bei Mismatch verwerfen + auditWarn).

### [NIEDRIG] User-Prompt wird nicht an andere Geraete gebroadcastet

`server/src/sessions.ts:562`

prompt() persistiert die User-Nachricht bewusst nur (Kommentar: der Sender hat sie schon auf dem Schirm). Folge fuer das dokumentierte Mehrgeraete-Szenario: Geraet B sieht die Assistant-Antwort live einstroemen, aber nie die Frage dazu — erst nach einem vollstaendigen History-Reload via session.events.get. Zudem wird die Nachricht auch dann persistiert, wenn der Prompt direkt danach fehlschlaegt ('session not provisioned' Zeile 572 wirft nach dem persistEvent) — die Historie zeigt dann eine Frage, die nie ankam.

**Vorschlag:** Das message.completed(user)-Event broadcasten und eine Absender-Kennung (deviceId oder requestId) mitgeben, damit der Sender es dedupliziert; persistEvent erst nach erfolgreicher Uebergabe an Shim/Link ausfuehren.

### [NIEDRIG] session.create validiert mode/branch nicht zur Laufzeit

`server/src/sessions.ts:257`

createSession uebernimmt msg.mode, msg.provider, msg.model und msg.branch ungeprueft in die Row bzw. in die Container-Env — die Typen aus dem Protokoll-Paket sind reine Compile-Zeit-Annahmen, das JSON vom Socket ist ungeprueft (ws.ts parst nur und castet). updateSession validiert mode dagegen explizit (Zeile 593, isAgentMode). Ein invalider mode-String landet als AGENT_MODE im Container und faellt bei buildPromptBody (Zeile 117) still weg — der Shim faehrt dann mit seinem Default-Verhalten, was bei den Permission-Gates ('ask' erwartet, Default ggf. lockerer) sicherheitsrelevant sein kann. msg.branch wird ohne das in repo.add benutzte REPO_BRANCH_RE geprueft (ws.ts:219/500 gilt nur fuer repo.add) an git clone --branch gereicht (harmlos als Optionswert, aber inkonsistent).

**Vorschlag:** In createSession isAgentMode(msg.mode) erzwingen und msg.branch gegen REPO_BRANCH_RE pruefen (Regex ins Protokoll- oder ein Shared-Modul ziehen), analog zur bestehenden Validierung in updateSession/repo.add.

### [NIEDRIG] egressTokenAllowed: Token-Vergleich nicht timing-sicher und volle DB-Abfrage pro Proxy-Request

`server/src/sessions.ts:155`

Der Egress-Proxy-Auth-Check laedt bei jedem Request alle Sessions aus SQLite und vergleicht das Klartext-Token per === in einer Schleife — ein klassischer (wenn auch schwer ausnutzbarer) Timing-Seitenkanal auf die shim_tokens, und unnoetige DB-Last auf dem heissen Proxy-Pfad (jeder LLM-/git-Request einer allowlist-Session laeuft hier durch).

**Vorschlag:** crypto.timingSafeEqual auf SHA-256-Hashes der Tokens verwenden und die gueltigen Token-Hashes cachen (Invalidierung bei Session-Create/Delete), analog zum bestehenden Peer-IP-Cache.

### [NIEDRIG] session.prompt liefert request.ok, obwohl der Prompt am Shim gescheitert ist

`server/src/ws.ts:379`

manager.prompt() wirft im Docker-Pfad bei Shim-Fehlern nicht, sondern setzt nur status 'error' und emittiert ein Fehler-Event (sessions.ts:575-579) — die .then()-Kette in ws.ts sendet dem Client daraufhin request.ok. Im Link-Pfad wirft prompt() dagegen (sessions.ts:567), der Client bekommt einen error-Frame. Ein Client, der auf request.ok wartet, haelt einen fehlgeschlagenen Prompt fuer angenommen; die beiden Pfade sind inkonsistent.

**Vorschlag:** Im Docker-Pfad von prompt() bei !res.ok ebenfalls werfen (nach dem emitEvent), damit beide Pfade dieselbe Ack-Semantik haben; oder request.ok dokumentiert strikt als 'angenommen, Ergebnis kommt als Event' definieren und dann auch im Link-Pfad nicht werfen.

### [NIEDRIG] Pending Link-Calls werden beim Socket-Close nicht aufgeloest (20s Haenger)

`server/src/ws.ts:174`

callLink() haelt Pending-Promises in pendingLinkCalls, aber weder der close/error-Handler des Link-Sockets noch dropLink/closeLink lehnen sie ab — faellt der Link-Socket mitten in einem Call weg, wartet der aufrufende Request (prompt/diff/permission einer Link-Session) die vollen 20s auf den Timeout, obwohl die Disconnection sofort bekannt ist. Der User sieht 20s lang nichts, dann 'link call timed out' statt sofort 'link agent disconnected'.

**Vorschlag:** callLink pro linkId indexieren (Map<linkId, Set<callId>>) und in dropLink/closeLink alle offenen Calls des Links sofort mit null aufloesen.

### [NIEDRIG] Unauthentifizierte WS-Verbindungen haben kein Auth-Timeout

`server/src/ws.ts:254`

Ein Socket, der nach dem Connect nie eine hello/agent.hello-Nachricht sendet, bleibt unbegrenzt offen: der Heartbeat beendet ihn nicht, weil die ws-Library Protokoll-Pings automatisch mit Pongs beantwortet — die Verbindung gilt dauerhaft als lebendig. Das Zehn-Verbindungen-Limit pro Adresse (Zeile 20) begrenzt den Schaden, aber hinter einem Proxy ohne TRUST_PROXY teilen sich alle Clients diese 10 Slots, die ein Angreifer so dauerhaft belegen kann.

**Vorschlag:** Nach dem Accept einen kurzen Timer (z.B. 10s) starten und den Socket schliessen, wenn bis dahin keine erfolgreiche Authentifizierung stattfand.


---

## Server: Docker-Lifecycle & Egress

**Gesamturteil:** Der Docker-Lifecycle ist solide gehaertet (CapDrop ALL, no-new-privileges, ReadonlyRootfs, Memory/Pids-Limits, UUID-basierte Namen/Labels/Volumes -> keine Injection in Docker-API-Aufrufe), und der Build-Race ist ueber inFlight/gatewayReady sauber dedupliziert. Die wirklich ernsten Probleme liegen im Egress-Pfad: (1) Die networkPolicy 'isolated' bietet keinerlei Netz-Enforcement, weil der Orchestrator (bzw. Gateway) dual-homed am internen Session-Netz haengt und der Peer-IP-Gate JEDEN Session-Container unabhaengig von seiner Policy autorisiert - ein isolierter Agent egress-t einfach ueber orchestrator:3128. (2) Der Forward-Proxy leitet den Proxy-Authorization-Header (= Session-Shim-Token) an Upstreams weiter. (3) Der Proxy prueft nach DNS-Aufloesung keine privaten/Link-Local-IPs (SSRF-Haertung fehlt). Zusaetzlich leakt oneShotPush bei Fehlern Container, und es gibt keinen Label-basierten Orphan-Reaper. Injection und Build-Race sind unauffaellig.

### [HOCH] networkPolicy 'isolated' ist wirkungslos - dual-homed Egress-Proxy + policy-unabhaengiger Peer-Gate

`server/src/docker.ts:469` — **verifiziert: bestätigt**

Nur policy==='allowlist' injiziert HTTP(S)_PROXY (docker.ts:469). Fuer 'isolated' wird KEIN Proxy-Env gesetzt, das Netz ist Internal:true - die Isolation haengt also allein daran, dass der Agent das (fehlende) Proxy-Env respektiert. Ein nicht-kooperativer/kompromittierter Agent tut das nicht: sessionNetworking ruft fuer JEDE Policy requireAttached() (docker.ts:465), wodurch sich der Orchestrator unter Alias 'orchestrator' auch ans isolierte Internal-Netz haengt und dort dual-homed (zusaetzlich am Bridge-Netz mit Internet) den Egress-Proxy auf 0.0.0.0:3128 anbietet. Der Peer-IP-Gate (sessions.ts:165 egressPeerAllowed -> isSessionPeerIp, docker.ts:122) autorisiert jede IP eines LEBENDEN Session-Containers, ohne dessen Policy zu pruefen. Konkret: Agent in isolierter Session setzt HTTP_PROXY=http://orchestrator:3128, seine Quell-IP ist im peerIps-Set -> autorisiert -> egress zu allen Allowlist-Hosts. 'isolated' == 'allowlist' fuer jeden nicht-kooperativen Agenten; das im README behauptete 'echte Netzwerk-Enforcement' fuer 'isolated' existiert nicht. Im Gateway-Modus (gateway.ts:155) ist es schlimmer: dort haengt der Gateway per attachGateway ebenfalls an isolierten Netzen und der Egress-Proxy hat gar keine Auth (siehe separater Befund).

**Vorschlag:** Isolierte Sessions duerfen den Orchestrator/Gateway nicht im selben Netz sehen: entweder Orchestrator NICHT ans isolierte Netz anbinden (Shim-Erreichbarkeit anders loesen) oder den Egress-Proxy nicht auf dem isolierten Netz-Interface lauschen lassen. Zusaetzlich den Peer-/Token-Gate policy-abhaengig machen: eine Anfrage darf nur autorisiert werden, wenn die Quell-Session tatsaechlich 'allowlist' ist; 'isolated'-Peers immer ablehnen.

### [HOCH] Forward-Proxy leitet Proxy-Authorization (Session-Shim-Token) an Upstream weiter

`server/src/egress-proxy.ts:202` — **verifiziert: bestätigt**

Im Plain-HTTP-Forward-Pfad wird nur 'proxy-connection' entfernt (egress-proxy.ts:201-202), aber der hop-by-hop-Header 'proxy-authorization' bleibt in headers und wird an den Upstream mitgesendet (https/http.request auf Zeile 203ff). Dieser Header enthaelt 'Basic pa:<shim_token>' bzw. 'Bearer <shim_token>'. Das shim_token ist dasselbe Geheimnis wie SHIM_TOKEN (Shim-API-Auth) und der Egress-Credential (sessions.ts:308/369, egressTokenAllowed:155). Folge: jeder ueber Plain-HTTP angesprochene Allowlist-Host (oder ein MITM/kompromittierter Allowlist-Host, z. B. registry.npmjs.org, models.dev) erhaelt das Per-Session-Token im Klartext und kann sich damit gegen die Shim-API UND den Egress-Proxy authentisieren. RFC 7235: Proxy-Authorization ist hop-by-hop und darf nicht weitergereicht werden. (CONNECT-Tunnel sind nicht betroffen, da dort kein Header geforwardet wird.)

**Vorschlag:** Vor dem Weiterleiten die hop-by-hop-Header strippen: delete headers['proxy-authorization']; zusaetzlich die in 'connection' gelisteten Header und Standard-hop-by-hop-Header (proxy-authenticate, te, trailer, transfer-encoding, upgrade, keep-alive) entfernen.

### [MITTEL] oneShotPush leakt Push-Container bei Fehler nach createContainer

`server/src/docker.ts:847`

In oneShotPush wird der Container erzeugt (docker.ts:828), gestartet (:847) und erst nach c.wait() via c.remove() aufgeraeumt (:849-850). Wirft c.start() oder c.wait() (Daemon-Hiccup, OOM-Kill, Netzfehler), springt der Ablauf in den catch-Block (:852) OHNE c.remove() aufzurufen - der Container bleibt zurueck. reapIdle/gc raeumen ihn nicht (sie kennen nur row.container_id, nicht diesen Wegwerf-Container). Er verschwindet nur, falls die Session spaeter geloescht wird (removeSessionNetwork force-removed dann alles auf pocketagent-s-<id>); bei fortbestehender Session akkumulieren gestoppte Push-Container samt Volume-Bind.

**Vorschlag:** createContainer/Start/Wait in try/finally kapseln und im finally c.remove({force:true}).catch(()=>{}) aufrufen, sodass der Push-Container in jedem Fehlerpfad entfernt wird.

### [MITTEL] Keine Private-/Link-Local-IP-Pruefung nach DNS-Aufloesung (SSRF-/DNS-Rebinding-Haertung fehlt)

`server/src/egress-proxy.ts:250`

hostAllowed() prueft nur den Hostnamen gegen die Allowlist. Sowohl der CONNECT-Pfad (net.connect({host, port}, egress-proxy.ts:250) als auch der Forward-Pfad (https/http.request, :203) loesen den Namen anschliessend selbst per DNS auf, ohne zu pruefen, dass die Ziel-IP oeffentlich ist. Loest ein Allowlist-Host (z. B. durch DNS-Rebinding eines kompromittierten/fehlkonfigurierten Eintrags wie models.dev, oder ein Angreifer mit Kontrolle ueber DNS eines Allowlist-Namens) auf 169.254.169.254, 127.0.0.1 oder 10.x/192.168.x auf, verbindet der Proxy bereitwillig dorthin -> Zugriff auf Cloud-Metadaten/interne Dienste. IP-Literale werden zwar durch die Allowlist abgewiesen, aber eine Namensaufloesung auf interne Bereiche nicht. Der Forward-Pfad loest zudem doppelt auf (URL-Konstruktion vs. request) -> klassischer TOCTOU-Rebinding-Spielraum.

**Vorschlag:** Nach der Aufloesung (bzw. via lookup-Hook / dns.resolve + Pin der geprueften IP an die Verbindung) alle privaten, Loopback-, Link-Local- (169.254/16, fe80::/10) und ULA-Bereiche ablehnen. Ideal: einmal aufloesen, IP validieren, und net.connect/request auf genau diese IP pinnen (host als IP, servername/Host-Header separat) statt den Namen erneut aufloesen zu lassen.

### [MITTEL] Gateway-Egress-Proxy ist voellig unauthentifiziert

`server/src/gateway.ts:155`

Im Remote-Gateway-Modus wird der Egress-Proxy mit createEgressProxyServer(allowlist) OHNE tokenValidator und OHNE peerValidator gestartet (gateway.ts:155). In proxyAuthorized fuehrt fehlender tokenValidator zu 'authorized:true' fuer JEDEN (egress-proxy.ts:163). Damit egress-t jeder Container, der gateway:3128 erreicht, ohne Credentials zu allen Allowlist-Hosts. Einziger Gate ist die Netz-Erreichbarkeit - der Gateway haengt aber via attachGateway an ALLEN Session-Netzen (auch 'isolated'), wodurch die isolierte Egress-Umgehung aus Befund 1 hier sogar ohne jede Auth funktioniert und das Per-Session-Token-Modell im Remote-Modus komplett entfaellt.

**Vorschlag:** Auch im Gateway einen Token-Validator etablieren (z. B. Per-Session-Token, das der Orchestrator dem Gateway ueber einen authentisierten Kanal bekanntmacht/synchronisiert) oder mindestens eine policy-abhaengige Netz-Trennung, damit 'isolated'-Netze den Gateway nie sehen und 'allowlist'-Sessions sich authentisieren muessen.

### [NIEDRIG] Plain-HTTP-Forward gated den Zielport nicht

`server/src/egress-proxy.ts:191`

Fuer forwardete Plain-HTTP-Requests wird denyReason mit port=null aufgerufen (egress-proxy.ts:191), sodass die Port-Beschraenkung (nur 80/443, siehe :103) entfaellt. Ein Agent kann so ueber Plain-HTTP jeden Port eines Allowlist-Hosts ansprechen (z. B. http://github.com:22/), waehrend CONNECT auf 80/443 begrenzt ist. Der Kommentar bezeichnet das als beabsichtigt; in Kombination mit einem Allowlist-Host, der interne Dienste auf Nicht-Standard-Ports co-lokalisiert, ist es dennoch eine unnoetige Angriffsflaeche.

**Vorschlag:** Auch im Forward-Pfad den Port gegen 80/443 pruefen (bzw. eine explizite Port-Allowlist), statt ihn ungated zu lassen.

### [NIEDRIG] Kein Label-basierter Orphan-Reaper: Container ohne persistierte ID leaken dauerhaft

`server/src/sessions.ts:310`

createSessionContainer (sessions.ts:310) legt den Container an, bevor die ID via setProvisioned (:318) in der DB landet. Wirft ein Schritt dazwischen - githubPatFor()/getSecretValue() (:311) kann bei Decrypt-Problemen werfen, setProvisioned selbst bei DB-Fehler -, ist die Container-ID verloren. Es existiert nirgends ein Reaper, der Container nach Label 'pocketagent.session' listet und solche ohne zugehoerige DB-Zeile entfernt (listRunning zaehlt nur, reconcile/gc/reapIdle arbeiten alle ueber row.container_id). Solche verwaisten Container bleiben bis zur manuellen Bereinigung liegen (gleiche Wurzel wie der oneShotPush-Leak).

**Vorschlag:** Reihenfolge robuster machen (PAT vor createSessionContainer lesen) und periodisch einen Orphan-Sweep ergaenzen: listContainers({filters:{label:['pocketagent.session']}}) und jeden Container, dessen Session-ID/Label keiner lebenden DB-Zeile entspricht, force-removen.


---

## Server: Security (Vault, Pairing, Tokens)

**Gesamturteil:** Der Security-Kern ist insgesamt solide gebaut: AES-256-GCM mit frischer 12-Byte-Random-Nonce pro Verschluesselung, Device-Tokens nur als SHA-256-Hash in der DB (48 Byte Entropie), Admin- und Gateway-Token-Vergleiche via timingSafeEqual, Pairing mit 48-Bit-Codes, atomarem Single-Use-Consume, 5-Versuche-Lockout und Sliding-Window-Rate-Limits, und die SECURITY.md benennt Restrisiken ehrlich. Die gravierendsten konkreten Befunde: der REST-Pfad /api/secrets verschluesselt entgegen seinem eigenen Kommentar ohne AAD und haelt damit den permanenten No-AAD-Downgrade-Fallback im Vault am Leben; derselbe Endpoint hat als einziger Admin-Token-Konsument kein Rate-Limit und erlaubt ungebremsten Bruteforce auf PAIRING_ADMIN_TOKEN (dessen Besitz volle Geraete-Pairing-Rechte bedeutet); und die README-Zusage 'Egress nur mit Per-Session-Shim-Token' stimmt nicht — lokal genuegt die Peer-IP, im Gateway-Modus laeuft der Egress-Proxy komplett ohne Auth. Dazu kommen kleinere Konsistenzluecken (fehlende kind-Validierung im WS-secret.set, Egress-Tokens gestoppter Sessions bleiben gueltig, CLI-Revocation trennt live Verbindungen nicht, MASTER_KEY-Passphrase-Ableitung ohne KDF, Doku-Abweichung bei der Pairing-Code-Laenge). Timing-unsichere Vergleiche auf Token-Hashes (ws.ts) wurden geprueft und als praktisch nicht ausnutzbar eingestuft (Preimage erforderlich); Secrets tauchen in keinem gepruefen Log-/Fehlerpfad auf.

### [MITTEL] Egress-Proxy-Auth-Behauptung stimmt nicht mit dem Code ueberein (Gateway: gar keine Auth, lokal: Peer-IP genuegt)

`server/src/gateway.ts:155`

README.md:140 behauptet: 'Egress-Proxy verlangt jetzt Proxy-Auth — nur Requests mit dem Per-Session-Shim-Token passieren; alles andere → 403'. Der Code weicht doppelt ab: (1) Im Remote-Gateway-Modus wird der Egress-Proxy mit `createEgressProxyServer(allowlist)` OHNE tokenValidator und OHNE peerValidator gestartet (gateway.ts:155) — proxyAuthorized (egress-proxy.ts:163) gibt dann `authorized: true` fuer jeden zurueck. Da der Gateway-Container am Default-Bridge-Netz des Runners haengt (gateway.ts Kommentar Zeile 8-9) und auf 0.0.0.0:3128 lauscht, kann jeder Container auf diesem Host den Proxy unauthentifiziert nutzen. (2) Im lokalen Modus autorisiert die Peer-IP eines Session-Containers allein, ganz ohne Token (egress-proxy.ts:164, sessions.ts:165-167). Beides ist begruendbar (undici sendet keine Proxy-Credentials), aber die dokumentierte Sicherheitszusage ist objektiv falsch.

**Vorschlag:** Entweder dem Gateway-Egress einen tokenValidator geben (z.B. Shim-Token-Liste vom Orchestrator gepusht) bzw. mindestens per GATEWAY_TOKEN gaten, oder README.md/SECURITY.md korrigieren: 'Token ODER Session-Container-Quell-IP; im Gateway-Modus nur Allowlist-Filterung ohne Auth'.

### [MITTEL] REST-Pfad /api/secrets verschluesselt ohne AAD — entgegen eigenem Doc-Kommentar

`server/src/secrets-api.ts:39`

saveSecretValue ruft `encrypt(value)` OHNE AAD auf, waehrend der WS-Pfad `secret.set` (ws.ts:518) mit AAD `secret:default:<kind>` verschluesselt. Der Datei-Kommentar (Zeile 6-8: 'both paths stay byte-for-byte identical in how a secret ends up on disk') ist damit falsch. Jede per CLI/REST gespeicherte Secret-Zeile liegt AAD-los in der DB, bis sie erstmals via Store.getSecretValue (db.ts:229-244) gelesen und dort ueber den Legacy-Fallback geheilt wird. Konsequenz: (a) die Kind-Bindung, die Ciphertext-Transplantation zwischen kinds verhindern soll (z.B. github-PAT-Ciphertext in eine openai-Zeile kopieren, damit der PAT als OPENAI_API_KEY in einen Session-Container injiziert wird), greift fuer diese Zeilen nicht; (b) der No-AAD-Fallback in vault.decrypt (vault.ts:58-65) kann nie entfernt werden, weil laufend neue AAD-lose Zeilen entstehen — der 'Legacy-Migrations'-Downgrade-Pfad ist damit permanent.

**Vorschlag:** In saveSecretValue `encrypt(value, `secret:${tenant}:${kind}`)` verwenden (identisch zu ws.ts:518). Danach kann der stillschweigende No-AAD-Fallback in vault.decrypt perspektivisch durch eine einmalige Migration ersetzt werden.

### [MITTEL] POST /api/secrets ohne Rate-Limit: unbegrenzter Online-Bruteforce auf PAIRING_ADMIN_TOKEN

`server/src/secrets-api.ts:47`

index.ts begruendet die Limiter (Zeile 43-45) explizit mit 'Pairing endpoints are brute-force targets' und haengt pairingRateLimit an /api/pairing/confirm und /api/pairing/create. registerSecretsApi registriert /api/secrets aber OHNE jeden preHandler — derselbe Admin-Token (adminTokenOk, pairing.ts:16-22) laesst sich dort mit voller Wire-Speed durchprobieren. Wer den Token erraet, kann via /api/pairing/create Pairing-Codes erzeugen und ein eigenes Geraet vollpairen (Vollzugriff auf Sessions, Secrets-Verwaltung, Device-Revocation). Zusaetzlich erzwingt niemand eine Mindestlaenge/-entropie fuer PAIRING_ADMIN_TOKEN (.env.example gibt anders als bei MASTER_KEY keinen Generierungsbefehl vor); ein kurzer, menschengewaehlter Token ist bei ungebremstem Endpoint realistisch brechbar.

**Vorschlag:** Denselben SlidingWindowRateLimiter (oder einen eigenen, z.B. 10/min/IP) als preHandler an /api/secrets haengen; optional beim Start warnen, wenn PAIRING_ADMIN_TOKEN < 16 Zeichen. In .env.example einen Generierungsbefehl (openssl rand -hex 32) dokumentieren.

### [NIEDRIG] Doku-Abweichung: Pairing-Code '8 Zeichen' vs. tatsaechlich 12 Hex-Zeichen

`README.md:87`

README.md:87 ('→ Code 8 Zeichen, 10 min gültig') widerspricht generatePairingCode (pairing.ts:10): `randomBytes(6).toString('hex')` erzeugt 12 Hex-Zeichen (48 Bit). Kein Sicherheitsproblem (der Code ist staerker als dokumentiert), aber eine falsche Angabe in der Sicherheits-relevanten Doku; Nutzer, die einen 12-stelligen Code sehen, koennten ihn fuer manipuliert halten. Zusatzbeobachtung ohne eigenen Findingswert: auditWarn loggt bei Fehlversuchen die ersten 4 der 12 Zeichen (index.ts:63), was die Restentropie fuer Log-Leser auf 32 Bit senkt — durch das 5-Versuche-Lockout (db.ts:169-182) und die Rate-Limits weiterhin unkritisch.

**Vorschlag:** README auf '12 Zeichen (hex)' korrigieren oder generatePairingCode auf die dokumentierte Laenge bringen; die Kombination aus Entropie, TTL, Lockout und Rate-Limit einmal konsistent in SECURITY.md festhalten.

### [NIEDRIG] CLI-Revocation trennt live WS-Verbindungen nicht — revoziertes Geraet bleibt bis zum Reconnect voll autorisiert

`server/src/admin.ts:26`

revokeDevice/revokeLink loeschen nur die DB-Zeile in einem separaten Prozess (Hinweis in Zeile 32 selbst dokumentiert). Der WS-Handler prueft das Token nur einmal beim hello (ws.ts:295-310); danach haelt das `authed`-Flag die Session, und der Heartbeat haelt die Verbindung beliebig lange offen, solange das Geraet Pongs sendet. Ein per CLI revoziertes (z.B. gestohlenes) Geraet behaelt also unbegrenzt Vollzugriff (Sessions steuern, Secrets setzen/loeschen, andere Geraete revozieren), bis seine Verbindung von selbst abreisst. Nur der WS-Weg `device.revoke` schliesst aktiv via hub.closeDevice (ws.ts:571).

**Vorschlag:** Entweder pro eingehender Nachricht (oder periodisch, z.B. im Heartbeat-Tick) die Existenz der Device-Zeile pruefen und bei Fehlen mit 4001 schliessen, oder einen Admin-HTTP-Endpoint (PAIRING_ADMIN_TOKEN-authentifiziert) anbieten, der im Serverprozess hub.closeDevice aufruft.

### [NIEDRIG] MASTER_KEY-Klassifizierung durch lenientes Base64 unscharf; Passphrase-Ableitung ohne KDF

`server/src/config.ts:17`

loadMasterKey akzeptiert jeden String, dessen (Node-lenient dekodiertes) Base64 exakt 32 Bytes ergibt, als Roh-Schluessel; Node ignoriert dabei Nicht-Base64-Zeichen. Eine menschengewaehlte ~43-Zeichen-Passphrase kann so zufaellig als 'starker' 32-Byte-Key durchgehen und umgeht dann auch die masterKeyWeak-Warnung in vault.ts:19 (gleiche leniente Pruefung). Der eigentliche Passphrase-Pfad (config.ts:20) leitet den Vault-Key per einfachem, ungesalzenem SHA-256 ab — kein scrypt/argon2, d.h. Offline-Woerterbuchangriffe gegen ein kopiertes orchestrator.db sind billig. Es gibt zwar eine Warnung, aber keinen harten Stopp.

**Vorschlag:** Base64 nur akzeptieren, wenn der String strikt dem Base64-Alphabet entspricht (Regex-Vorpruefung) und die Laenge plausibel ist (43-44 Zeichen + Padding); fuer Passphrases scryptSync mit persistiertem Salt statt blankem SHA-256 verwenden oder Passphrases ganz ablehnen (Fail-fast statt warn).

### [NIEDRIG] Egress-Token-Gate akzeptiert Shim-Tokens beliebiger (auch gestoppter/archivierter) Sessions

`server/src/sessions.ts:154`

egressTokenAllowed matcht `this.store.listSessions(TENANT).some((r) => r.shim_token === token)` — listSessions liefert ALLE Session-Zeilen unabhaengig vom Status, und shim_token wird beim Stoppen nicht geloescht. Der Kommentar (Zeile 151-152) behauptet 'only tokens matching a live session's shim_token pass'. Faktisch bleibt jeder jemals vergebene Shim-Token bis zur GC-Loeschung der Session (GC_DAYS=14 default) ein gueltiges Egress-Proxy-Credential; der Vergleich ist zudem ein einfacher `===`-Stringvergleich (bei 24-Byte-Random-Tokens praktisch unkritisch, aber nicht timing-sicher).

**Vorschlag:** Auf Sessions mit laufendem Container filtern (z.B. status running/idle und container_id gesetzt) oder shim_token beim Stop nullen; alternativ Kommentar und SECURITY-Doku an das reale Verhalten anpassen.

### [NIEDRIG] WS secret.set validiert kind nicht (REST-Pfad schon)

`server/src/ws.ts:516`

Der REST-Pfad prueft kind gegen KIND_RE `^[a-z0-9_-]{1,64}$` (secrets-api.ts:16,54), der WS-Handler `secret.set` (ws.ts:516-528) uebernimmt msg.kind ungeprueft in DB und AAD-String `secret:default:${msg.kind}`. Ein authentifiziertes Geraet kann damit beliebige kinds (Grossbuchstaben, Doppelpunkte, 10-KB-Strings) anlegen. Konkreter Schaden ist begrenzt (Single-Tenant, kinds werden nur ueber Adapter-Manifeste nachgeschlagen), aber die beiden als 'identisch' deklarierten Pfade divergieren, und ein kind mit ':' macht den AAD-Namensraum uneindeutig.

**Vorschlag:** isValidSecretKind (bereits exportiert aus secrets-api.ts) auch im WS-Handler vor encrypt/saveSecret aufrufen und bei Verstoss einen error-Frame senden.


---

## Server: Persistenz, Recovery & Link-Agent

**Gesamturteil:** Die Persistenzschicht (db.ts) ist sauber parametrisiert (keine SQL-Injection), hat aber Datenmodell-Schwaechen: session_events ohne Index bei einem per-Insert-DELETE-Scan, und Secrets ohne Eindeutigkeit pro (tenant,kind), wodurch Loeschen aeltere Werte reaktiviert. Die Recovery-Logik nach Neustart ist grundsaetzlich durchdacht (reconcile), laesst aber Sessions, die vor dem Container-Create abstuerzen, dauerhaft im Status 'creating' haengen. Die Adapter-Manifest-Validierung prueft credentials/defaults nur per Typ-Cast, sodass ein kaputtes adapter.json Secrets in Ein-Buchstaben-Env-Variablen streut; ausserdem ueberschreiben die gebundelten /app/adapters-Manifeste stillschweigend ein operatorgesetztes ADAPTERS_DIR. Am schwersten wiegt der Link-Agent: eine explizite wss://-URL wird auf ws:// heruntergestuft (Token im Klartext), und nach einem Shim-Neustart pollt der SSE-Loop fuer immer den alten, toten Port — Events gehen dauerhaft verloren.

### [HOCH] wsUrl() stuft explizites wss:// auf unverschluesseltes ws:// herunter

`link/src/index.ts:174` — **verifiziert: bestätigt**

`u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'` mappt nur https->wss; jede andere Eingabe wird zu 'ws:'. Die dokumentierte Nutzung (Datei-Header Zeile 10 und Usage-Meldung Zeile 55: `PA_SERVER=wss://orch.example.com`) parsed als protocol 'wss:', erfuellt die Bedingung nicht und wird auf 'ws:' gesetzt (WHATWG-URL erlaubt wss->ws, beides special schemes). Folge: Der Link-Agent verbindet sich im dokumentierten Setup per Klartext-WebSocket und sendet PA_TOKEN sowie den gesamten Session-Traffic (agent.hello Zeile 276-284, Events, Kommandos) unverschluesselt uebers Netz; ein MITM erhaelt den Link-Token und damit volle Agent-Kontrolle.

**Vorschlag:** Protokoll nur normalisieren, nie herunterstufen: `if (u.protocol === 'https:') u.protocol = 'wss:'; else if (u.protocol === 'http:') u.protocol = 'ws:';` — 'wss:'/'ws:' unveraendert lassen; optional bei 'ws:' zu Nicht-localhost-Hosts warnen/abbrechen (analog zur CLI, die http nur fuer localhost akzeptiert).

### [HOCH] SSE-Loop friert Shim-Port beim ersten Aufruf ein — nach Shim-Neustart gehen alle Events dauerhaft verloren

`link/src/index.ts:217` — **verifiziert: bestätigt**

`startEventStream()` bindet `const base = http://127.0.0.1:${shim.port}` einmalig ausserhalb der Endlosschleife (Zeile 217) und wird nur einmal aus main() (Zeile 360) aufgerufen. Stirbt der Shim-Prozess, spawnt `restart()` (Zeile 152-163) einen neuen Shim auf einem NEUEN Zufallsport (`freePort()`, Zeile 102), aber der Event-Loop fetcht weiter `${base}/events` gegen den alten, toten Port — jeder Versuch schlaegt fehl, Retry alle 2 s, fuer immer. `proxyCommand` nutzt dagegen `shim.port` zur Laufzeit (Zeile 193), Kommandos funktionieren also wieder, waehrend saemtliche Agent-Events (Antworten, Permission-Anfragen) den Orchestrator nie mehr erreichen: die App sieht eine Session, die auf Prompts scheinbar nie antwortet. Zusatz: schlaegt der ERSTE spawn fehl (shim===null), returnt startEventStream sofort (Zeile 216) und der Stream startet auch nach spaeterem erfolgreichem Restart nie.

**Vorschlag:** Basis-URL in jeder Schleifeniteration aus dem aktuellen `shim` ableiten (`const base = shim ? `http://127.0.0.1:${shim.port}` : null; if (!base) { await sleep; continue; }`) statt einmalig zu binden; alternativ den Stream in restart() nach erfolgreichem Spawn neu starten und den alten Loop abbrechen.

### [MITTEL] Shim-Crash waehrend des 90s-Health-Waits fuehrt zu permanentem Stillstand ohne weiteren Restart

`link/src/index.ts:128`

Exit-Handler (Zeile 128-131) plant `restart()` nach 5 s; `restart()` bricht bei `shimRestarting === true` sofort ab (Zeile 153). Szenario: Shim crasht sofort nach dem Spawn (fehlende Dependency, Port-Konflikt) waehrend spawnShim noch im Health-Poll (Zeile 135-143, bis 90 s) steckt: Der Exit-Handler feuert bei t+1s, der geplante Restart bei t+6s trifft auf shimRestarting=true und wird verschluckt; spawnShim pollt den toten Port bis zur Deadline, `child.kill` auf den bereits toten Prozess erzeugt kein zweites exit-Event, wirft, und `finally` setzt shimRestarting=false — danach ist nichts mehr geplant. Der Link-Agent bleibt verbunden, aber der Shim wird nie wieder gestartet; proxyCommand liefert dauerhaft 503/502.

**Vorschlag:** Im Exit-Handler bei laufendem Restart einen Retry vormerken (Flag `restartPending`), das im finally von restart() geprueft wird und ggf. sofort einen neuen restart() ausloest; alternativ im catch-Zweig von restart() selbst einen erneuten Versuch mit Backoff planen.

### [MITTEL] Manifest-Validierung castet credentials/providerEnv/defaults ungeprueft — kaputtes adapter.json streut Secrets in Ein-Zeichen-Env-Variablen

`server/src/adapters.ts:59`

`validate()` prueft nur id/name; `m.credentials as Record<string, string[]>` (Zeile 59), `m.providerEnv as Record<string, string>` (Zeile 60) und `m.defaults as {provider: string}` (Zeile 65-68) sind blinde Casts. Konkretes Fehlerszenario: `"credentials": {"github": "GITHUB_TOKEN"}` (String statt Array) passiert die Validierung; sessions.ts buildEnv (Zeile 388-389) iteriert dann `for (const v of vars)` ueber den STRING zeichenweise und ruft setKey('github','G'), setKey('github','I'), ... auf — der GitHub-PAT landet als Wert in Container-Env-Variablen namens G, I, T, H, U, B, N, O, K, E, waehrend GITHUB_TOKEN nie gesetzt wird: Adapter still kaputt plus Secret unter unerwarteten Namen im Container. Ein nicht-iterierbarer Wert (Zahl) wirft erst beim Session-Start einen TypeError statt beim Laden. `defaults: {}` liefert `provider: undefined` unter dem Typ string (Nutzung sessions.ts:103).

**Vorschlag:** In validate() Form pruefen: credentials-Werte muessen Arrays aus Strings sein, providerEnv-Werte Strings, defaults.provider ein String — sonst wie bei fehlender id mit klarer Meldung werfen (loadAll faengt und skippt das Manifest bereits sauber, Zeile 89-91).

### [MITTEL] Gebundelte /app/adapters-Manifeste ueberschreiben Operator-Manifeste aus ADAPTERS_DIR

`server/src/adapters.ts:75`

manifestDirs() liefert die Reihenfolge [ADAPTERS_DIR, ../../shims, /app/adapters] (Zeile 11-15); loadAll() iteriert in dieser Reihenfolge und `out.set(desc.id, desc)` (Zeile 88) laesst SPAETERE Verzeichnisse gewinnen. Das Server-Dockerfile kopiert alle shims/*/adapter.json nach /app/adapters (Dockerfile Zeile 46-50), das Verzeichnis existiert im Image also immer. Folge: Setzt ein Operator ADAPTERS_DIR mit einem angepassten Manifest fuer eine eingebaute Adapter-Id (z. B. opencode mit gepinntem `image`-Digest, der laut README genau so unterstuetzt werden soll), wird es kommentarlos vom gebundelten Manifest ueberschrieben — nur voellig neue Adapter-Ids funktionieren. Zudem wird das Registry-Ergebnis dauerhaft gecacht (Zeile 97-102), ein leeres/teilweises Erst-Laden bleibt bis zum Prozessende bestehen.

**Vorschlag:** Prioritaet umdrehen: entweder Verzeichnisse in umgekehrter Reihenfolge iterieren oder `if (!out.has(desc.id)) out.set(...)` verwenden, sodass ADAPTERS_DIR > Repo-shims > gebundelte Defaults gilt; die gewaehlte Rangfolge im Log ausgeben.

### [MITTEL] session_events ohne Index auf session_id — appendEvent macht pro Event zwei Full-Table-Scans

`server/src/db.ts:67`

Das Schema (Zeile 67-70) definiert keinen Index auf session_events(session_id), migrate() ergaenzt keinen. appendEvent (Zeile 396-406) fuehrt nach JEDEM Insert ein DELETE mit Subselect `WHERE session_id = ? AND id NOT IN (SELECT id ... WHERE session_id = ? ORDER BY id DESC LIMIT 5000)` aus — ohne Index sind das zwei Scans ueber die GESAMTE Tabelle (alle Sessions). Da Message-Deltas persistiert werden (isHistoryEvent filtert nur 'ping' und phase-Notices, sessions.ts:75-78, appendEvent-Aufruf Zeile 451), feuert das auf dem heissen Streaming-Pfad: Bei z. B. 20 Sessions x 5000 Events sind das ~100k gescannte Zeilen pro einzelnem Event-Write, synchron im Event-Loop (better-sqlite3 blockiert). Auch listSessionEvents (Zeile 421-426) scannt voll.

**Vorschlag:** `CREATE INDEX IF NOT EXISTS idx_session_events_sid ON session_events(session_id, id);` ins Schema bzw. migrate() aufnehmen; optional das Trim-DELETE nur alle N Inserts oder per `DELETE ... WHERE session_id=? AND id <= (SELECT id ... LIMIT 1 OFFSET 5000)` ausfuehren.

### [MITTEL] Secrets pro (tenant,kind) nicht eindeutig: Loeschen reaktiviert stillschweigend aeltere Werte, rotierte Keys bleiben unbegrenzt in der DB

`server/src/db.ts:250`

saveSecret fuegt immer eine NEUE Zeile ein (Zeile 202-206, ebenso ws.ts secret.set:517-519 und secrets-api saveSecretValue), es gibt kein UNIQUE(tenant_id, kind) und kein Aufraeumen alter Zeilen; getSecretByKind nimmt die juengste per `ORDER BY created_at DESC LIMIT 1` (Zeile 212-216). Fehlerszenario 1: Nutzer rotiert einen geleakten GitHub-PAT (neue Zeile), loescht spaeter 'den' github-Secret per deleteSecret(id) (Zeile 250-252) — geloescht wird nur die juengste Zeile, die aeltere (geleakte) wird sofort wieder aktiv und in Session-Container injiziert, obwohl die App 'geloescht' meldet. Fehlerszenario 2: Alle abgeloesten Klartext-aequivalenten Ciphertexte verbleiben unbegrenzt in der DB. Zusatz: created_at hat nur Millisekunden-Aufloesung; zwei Saves in derselben ms machen die 'juengste' Zeile nichtdeterministisch (kein rowid-Tiebreaker).

**Vorschlag:** Beim Speichern alte Zeilen gleicher (tenant_id, kind) in einer Transaktion loeschen (oder UNIQUE(tenant_id, kind) + UPSERT); deleteSecret alternativ auf kind statt id umstellen; Ordering um `, id DESC` als Tiebreaker ergaenzen.

### [MITTEL] REST-Pfad verschluesselt ohne AAD — Kind/Tenant-Bindung fehlt fuer per CLI gespeicherte Secrets

`server/src/secrets-api.ts:39`

saveSecretValue ruft `encrypt(value)` ohne AAD auf (Zeile 39), waehrend der WS-Pfad `encrypt(msg.value, 'secret:default:${msg.kind}')` nutzt (ws.ts:518). Der Docstring behauptet faelschlich, beide Pfade seien 'byte-for-byte identical' (Zeile 6-8). Per REST/CLI gespeicherte Secrets liegen dadurch als AAD-lose Zeilen in der DB — genau die Klasse, die getSecretValue (db.ts:229-244) als 'Legacy' behandelt und erst bei der ERSTEN Nutzung nachtraeglich AAD-bindet. Bis dahin fehlt die Eigenschaft, die AAD liefern soll: Ein Angreifer mit DB-Schreibzugriff kann den Ciphertext einer solchen Zeile unter anderem kind (z. B. den maechtigen github-PAT unter einem harmloseren kind, oder umgekehrt) einhaengen, ohne dass die GCM-Verifikation fehlschlaegt — der Legacy-Fallback in decrypt() (vault.ts:58-65) akzeptiert ihn.

**Vorschlag:** In saveSecretValue `encrypt(value, `secret:${tenant}:${kind}`)` verwenden (Tenant wird bereits als Parameter durchgereicht); langfristig den No-AAD-Fallback nach abgeschlossener Migration hinter ein Flag legen oder entfernen.

### [MITTEL] Crash waehrend Provisionierung (vor Container-Create) laesst Session dauerhaft in 'creating' haengen

`server/src/sessions.ts:971`

createSession schreibt die Zeile mit status 'creating' und container_id NULL (Zeile 260-263) und provisioniert asynchron (`void this.provision(...)`, Zeile 283; angestossen ohne await auch von index.ts:86). Stirbt der Orchestrator in diesem Fenster — realistisch, da der Erst-Image-Build laut README Minuten dauert —, skippt reconcile() die Zeile wegen `!row.container_id` (Zeile 971) kommentarlos; die 'creating'-Behandlung in reconcileSession (Zeile 1012) greift nur fuer Zeilen MIT Container. resumeSession verweigert mit 'session not provisioned' (Zeile 771, shim_token/volume_name NULL). Ergebnis: Die Session zeigt in der App fuer immer 'creating', ist weder resumebar noch wird sie je auf 'error' gesetzt — DB-Zustand dauerhaft inkonsistent zum Laufzeitzustand.

**Vorschlag:** In reconcile() Zeilen mit status 'creating'/'running' und container_id NULL explizit behandeln: status auf 'error' setzen und ein fatales error-Event emittieren (analog zum 'missing'-Zweig in reconcileSession Zeile 987-996), damit der Client den Neustart anbieten kann.

### [NIEDRIG] eventQueue waechst unbegrenzt, solange keine Orchestrator-Verbindung besteht

`link/src/index.ts:242`

Solange sessionId null ist (vor agent.ready und nach jedem close, Zeile 312), landet jedes SSE-Event des Shims in eventQueue ohne Groessenbegrenzung (Zeile 242). Der opencode-Shim broadcastet alle 15 s ein 'ping'-Event (shims/opencode/src/index.ts:128), das der Link-Agent nicht filtert — bei laengerem Orchestrator-Ausfall oder falschem Token (Dauerschleife dial->close) waechst die Queue mit ~5760 Objekten/Tag unbegrenzt; nach dem Reconnect werden zudem alle veralteten Pings gebuendelt uebertragen. Zweiter Verlustpfad: Ist die WS-Verbindung tot, aber noch nicht erkannt (Watchdog erst nach >90 s, Zeile 335-341), ist sessionId noch gesetzt — Events gehen dann in den Puffer des todgeweihten Sockets (send(), Zeile 179-185) und werden beim terminate() verworfen statt gequeued: bis zu ~90 s Turn-Events verschwinden lautlos.

**Vorschlag:** Queue hart deckeln (z. B. 1000 Eintraege, aelteste verwerfen) und 'ping'-Events gar nicht erst queuen; fuer das Verlustfenster Events zusaetzlich queuen, solange kein frisches Pong/Server-Echo bestaetigt ist, oder Shim-seitig Event-Replay ab Sequenznummer nutzen.

### [NIEDRIG] 5-Versuche-Lockout fuer Pairing-Codes kann konstruktionsbedingt nie greifen

`server/src/db.ts:169`

consumePairingCode inkrementiert attempts nur fuer eine Zeile, deren code EXAKT dem eingereichten Code entspricht und die used=0 ist (Zeile 178-180). Ein Brute-Forcer reicht aber falsche Codes ein, die keiner Zeile entsprechen — kein Zaehler steigt; reicht er den richtigen Code ein, wird er konsumiert (Erfolg). Der erste UPDATE (Zeile 172) kann fuer eine lebende Zeile nur an expires_at scheitern, d. h. attempts waechst ausschliesslich auf bereits abgelaufenen Codes. Der in pairing.ts:8-9 als Schutz genannte '5-attempt lockout' ist damit totes Recht; der reale Schutz ist allein Rate-Limit plus 48 Bit Entropie (was praktisch ausreicht, aber die dokumentierte Verteidigungsschicht existiert nicht). Nebenbefund: abgelaufene/verbrauchte pairing_codes-Zeilen werden nie geloescht.

**Vorschlag:** Entweder den attempts-Mechanismus entfernen (Kommentare in db.ts:163-168 und pairing.ts:8-9 korrigieren) oder als globalen/pro-Tenant Fehlversuchszaehler implementieren, der nach N Fehlversuchen ALLE offenen Codes sperrt; Cleanup abgelaufener Codes ergaenzen.


---

## Android: Datenschicht & Verhalten

**Gesamturteil:** Die Android-Datenschicht ist insgesamt sorgfaeltig gebaut (Backoff mit Jitter, Request/Ack-Muster gegen Prompt-Verlust, Verlaufs-Reload bei jedem Reconnect, Keystore-verschluesselter Token mit Backup-Ausschluss), hat aber drei gewichtige Korrektheitsfehler. Erstens ist die gesamte Unauthorized-Behandlung (Close 4001) toter Code, weil onClosing nicht implementiert ist und OkHttp onClosed bei server-initiiertem Close nie aufruft — ein revoktes Geraet retryt endlos. Zweitens wird die optionale Biometrie-Sperre beim Kaltstart deterministisch umgangen, weil das Gate auf dem collectAsState-Initialwert false entsperrt, bevor der echte DataStore-Wert eintrifft. Drittens ist der Kern-Usecase Push-bei-getoeteter-App halb kaputt: der Server schickt eine gemischte notification+data-Message, wodurch im Hintergrund das FCM-SDK rendert, der Tap ohne Deep-Link in der Sessionliste landet und der eigene High-Importance-Kanal umgangen wird. Dazu kommen ein realistischer Doppel-Verbindungs-Pfad (doConnect raeumt reconnectJob/alten Socket nicht ab, DataStore-Re-Emissionen triggern connect), eine nie nachgeholte FCM-Token-Registrierung nach Re-Pairing sowie ein potenziell ewig haengender Pairing-Call (readTimeout 0).

### [HOCH] Biometrie-Sperre wird beim Kaltstart deterministisch umgangen

`android/app/src/main/java/com/pocketagent/app/MainActivity.kt:83`

biometricEnabled kommt per collectAsState(initial = false) (Zeile 83); BiometricGate haengt an LaunchedEffect(enabled) (Zeile 110). Beim ersten Compose ist enabled zwangslaeufig der Platzhalter false, denn die DataStore-Emission erreicht den State erst nach mindestens einem Suspend-Punkt — der bereits eingeplante Effect-Body mit enabled=false laeuft aber vorher synchron durch und ruft onUnlocked() (Zeile 113-115). unlocked wird true; wenn der echte Wert true nachkommt, blockt der Guard 'if (unlocked …) return' (Zeile 111) den Prompt. Ergebnis: Bei aktivierter App-Sperre wird der Inhalt bei jedem Kaltstart ohne BiometricPrompt angezeigt — die Sperre greift nie.

**Vorschlag:** Den Enabled-Zustand dreiwertig machen (Boolean? mit initial null, z.B. collectAsState(initial = null)) und im Gate erst reagieren, wenn der echte Wert geladen ist; bei null weder entsperren noch prompten (Splash/Leerbildschirm).

### [HOCH] Unauthorized-Close (4001) wird praktisch nie erkannt: onClosing ist nicht implementiert

`android/app/src/main/java/com/pocketagent/app/data/WsClient.kt:220`

Die 4001-Erkennung haengt ausschliesslich in onClosed (Zeile 220-229). OkHttp ruft onClosed aber nur auf, wenn der Client den Close-Handshake selbst abschliesst (RealWebSocket.onReadClose: listener.onClosed nur bei enqueuedClose, d.h. nach eigenem close()-Aufruf). Der Server initiiert den Close (server/src/ws.ts:280/292/299/304: socket.close(4001,'unauthorized') bzw. :122/135 'revoked'); beim Client feuert dann nur onClosing — das der Listener nicht ueberschreibt. Ablauf real: Server schickt Close(4001) -> onClosing (ignoriert) -> Verbindung haengt, bis der 10s-Ping fehlschlaegt -> onFailure -> handleDisconnect -> generischer Retry-Loop. Ein revoked/unbekanntes Geraet landet also nie im Zustand Unauthorized, sondern haemmert endlos mit Backoff+~10-20s Ping-Timeout pro Zyklus gegen den Server; der Nutzer sieht ewig 'Verbindung abgebrochen … erneut in Xs' statt des Hinweises, neu zu koppeln. Der gesamte Unauthorized-Pfad inkl. WsClientTest ist damit im Feld toter Code.

**Vorschlag:** Im Listener onClosing(webSocket, code, reason) ueberschreiben: dort isUnauthorizedClose pruefen und handleUnauthorized aufrufen, sowie in jedem Fall webSocket.close(code, null) aufrufen, damit der Handshake abgeschlossen wird und onClosed/Cleanup normal laufen.

### [HOCH] Push bei getoeteter/backgrounded App: kein Deep-Link, eigener Kanal/Icon umgangen

`android/app/src/main/java/com/pocketagent/app/fcm/PocketFcmService.kt:22`

Der Server schickt eine gemischte FCM-Message mit notification-Block UND data (server/src/fcm.ts:92-93). Bei App im Hintergrund oder getoetetem Prozess stellt das FCM-SDK die Notification selbst in den Tray — onMessageReceived wird gar nicht aufgerufen. Der Tap startet die Launcher-Activity mit den data-Feldern nur als Intent-Extras; MainActivity.handleDeepLink (MainActivity.kt:49-59) liest ausschliesslich intent.data (pocketagent://-URI) und ignoriert Extras — der Nutzer landet auf der Sessionliste statt in der Session (genau der Hauptanwendungsfall: Approval-Anfrage waehrend die App zu ist). Zusaetzlich wird der Kanal 'sessions' (IMPORTANCE_HIGH) umgangen: Im Manifest fehlt com.google.firebase.messaging.default_notification_channel_id, das SDK legt die Notification auf den Fallback-Kanal 'Miscellaneous' mit Default-Prioritaet; auch das Small-Icon-Meta-Datum fehlt.

**Vorschlag:** Serverseitig auf reine Data-Message umstellen (notification-Block entfernen), dann laeuft immer onMessageReceived — auch bei getoetetem Prozess. Alternativ/zusaetzlich: in MainActivity die FCM-Extras (sessionId) aus dem Launch-Intent lesen und Manifest-Meta-Daten fuer default_notification_channel_id und default_notification_icon setzen.

### [MITTEL] FCM-Token wird nie aktiv abgeholt — Registrierung geht nach Prozess-Neustart/Re-Pairing verloren

`android/app/src/main/java/com/pocketagent/app/data/AppRepository.kt:486`

Der Token erreicht die App nur ueber PocketFcmService.onNewToken (feuert nur bei Erst-Generierung/Rotation) und liegt danach ausschliesslich im fluechtigen Feld fcmToken (Zeile 64-65). Nirgends wird FirebaseMessaging.getInstance().token abgefragt (Grep ueber android/: kein Treffer). Szenario: Nutzer koppelt neu (Server-DB-Reset oder Geraet revoked+neu gekoppelt) oder der Prozess wurde zwischen Token-Generierung und Pairing beendet -> im neuen Prozess ist fcmToken null, der Connected-Hook (Zeile 94) schickt nie fcm.register -> der Server kennt keinen (oder einen verwaisten) Token, Push bleibt still tot, bis FCM irgendwann rotiert (kann nie passieren).

**Vorschlag:** Beim App-/Repository-Start (z.B. in AppRepository.start oder PocketAgentApp.onCreate nach initFirebase) FirebaseMessaging.getInstance().token asynchron abfragen und via onFcmToken registrieren; Fehler still schlucken, wenn Firebase mit Platzhaltern laeuft.

### [MITTEL] Pairing-HTTP-Call kann unbegrenzt haengen (readTimeout 0 vom WebSocket-Client)

`android/app/src/main/java/com/pocketagent/app/data/PairingApi.kt:86`

PairingApi.default() (Zeile 84-88) ist fuer den WebSocket getunt: readTimeout(0) = unendlich. Derselbe Client wird in AppContainer (PocketAgentApp.kt:17) auch fuer den synchronen POST /api/pairing/confirm benutzt (Zeile 37: newCall(...).execute()). Antwortet der Server nach dem TCP-Connect nie (haengender Reverse-Proxy, halboffene Verbindung), blockiert confirm() unbegrenzt — kein readTimeout, kein callTimeout — und der Pairing-Screen bleibt ewig im Ladezustand ohne Fehlermeldung.

**Vorschlag:** Fuer den Pairing-Call einen eigenen OkHttpClient mit readTimeout/callTimeout (z.B. 15-20s) verwenden oder in confirm() per client.newBuilder().callTimeout(20, SECONDS) ableiten.

### [MITTEL] Doppelte WebSocket-Verbindungen: doConnect raeumt weder reconnectJob noch alten Socket ab

`android/app/src/main/java/com/pocketagent/app/data/WsClient.kt:106`

doConnect (Zeile 106-112) cancelt den laufenden reconnectJob nicht und schliesst einen evtl. vorhandenen socket nicht. Erreichbarer Fehlweg: Zustand Waiting mit laufendem Countdown; irgendein DataStore-Write (z.B. setBiometricEnabled in den Settings) laesst tokens.setup erneut emittieren (kein distinctUntilChanged), der Collector in AppRepository.start (AppRepository.kt:70-84) ruft ws.connect() -> Guard passiert (Waiting) -> Socket A, Zustand Connecting. Der weiterlaufende Countdown (Zeile 249-264) ueberschreibt den Zustand jede Sekunde wieder mit Waiting (auch Connecting/Connected!) und ruft am Ende connect() -> Guard sieht das selbst gesetzte Waiting -> Socket B ersetzt das Feld, A bleibt verwaist offen (Hello gesendet, Pings halten ihn am Leben). Folge: zwei live Verbindungen, jedes session.event kommt doppelt in _messages/Timeline, und das serverseitige Verbindungslimit (4002 'too many connections') kann die naechste Verbindung killen — Flattern.

**Vorschlag:** In doConnect zuerst reconnectJob?.cancel(); reconnectJob = null und socket?.cancel() ausfuehren; zusaetzlich in AppRepository.start den setup-Flow mit distinctUntilChanged() entprellen, damit fremde DataStore-Writes keinen connect() anstossen.

### [NIEDRIG] Unbekannte Enum-Werte eines neueren Servers lassen ganze Sessions still verschwinden

`android/app/src/main/java/com/pocketagent/app/data/Protocol.kt:561`

SessionInfo wird strikt via kotlinx-Serializer dekodiert (Zeile 561-563 in session.list, 595-597 in session.status): ein neuer status- oder mode-Wert eines neueren Servers (z.B. 'paused') wirft eine SerializationException, mapNotNull verwirft die komplette Session — sie fehlt kommentarlos in der Liste. Gleiches Muster beim status-Event: unbekannter mode -> return null (Zeile 450), das Busy-Update geht verloren. Das widerspricht der sonst konsequent umgesetzten Toleranz-Philosophie des Parsers (unbekannte Phasen -> UNKNOWN, unbekannte Event-Typen fallen einzeln heraus).

**Vorschlag:** In den Enums Fallback-Werte einfuehren (z.B. SessionStatus.UNKNOWN) und mit Json { coerceInputValues = true } plus Default-Wert dekodieren, oder SessionInfo wie die AgentEvents feldweise tolerant von Hand parsen.

### [NIEDRIG] Auto-Reconnect trotz Unauthorized-Zustand ueber Netz-/Foreground-Trigger

`android/app/src/main/java/com/pocketagent/app/data/WsClient.kt:131`

Die Doku von Unauthorized (Zeile 40-47) verspricht: kein automatischer Reconnect, nur ein manueller Tap. reconnectNow (Zeile 131-141) prueft den Unauthorized-Zustand aber nicht und wird automatisch aufgerufen: onNetworkAvailable (Zeile 172-176) und ensureAlive (AppRepository.kt:469-471, verdrahtet an onForeground/onNetworkAvailable in PocketAgentApp.kt:33-41). Ein abgelehntes/revoktes Geraet verbindet sich damit bei jedem Foreground-Wechsel und Netz-Event erneut, entgegen dem dokumentierten Verhalten (relevant, sobald Finding 1 gefixt ist und Unauthorized ueberhaupt erreicht wird).

**Vorschlag:** In onNetworkAvailable und in AppRepository.ensureAlive den Zustand Unauthorized ausnehmen (kein reconnectNow); alternativ reconnectNow einen Parameter manual=true geben und automatische Aufrufer bei Unauthorized abweisen.


---

## Android: Design & UX (Rams/Ive-Massstab)

**Gesamturteil:** Die App ist handwerklich ungewöhnlich diszipliniert: konsequentes Token-System (Theme.kt), eine Statuspunkt-Primitive für alle Zustände, dokumentierte Begründungen für fast jede Design-Entscheidung, gute Loading/Empty/Error-Zustände auf Diff- und Session-Screen und bottom-verankerte Dialoge/Sheets für Einhandbedienung. Der Haupt-Nutzerfluss ist bis zum Chat klar, bricht aber am Ende: Das Ziel des gesamten Produkts — Diff prüfen, pushen, PR öffnen — ist als kleines Overflow-Menü bzw. nicht-klickbare Karten versteckt statt als sichtbarer letzter Schritt. Dazu kommen drei echte Schutzlücken bzw. Sackgassen (Secret-Löschen per Wisch ohne Bestätigung, Re-Pairing-Hinweis ohne existierende Option, falscher Leer-Zustand der Liste beim Start). Auf der Reduktionsseite trägt die Session-Karte und der Session-Screen doppelte Metadaten (Adapter/Modus zweimal sichtbar), und dieselbe Einstellung heißt an zwei Orten verschieden ("Autonomie" vs. "Modus"). Die Einstellungen sind sauber gruppiert, enthalten aber Katalog-Duplikate und eine inkonsistente Lösch-Interaktion. Insgesamt: sehr gutes Fundament, das an ~4 Stellen den Fluss zu Ende denken und an ~10 Stellen weiter reduzieren sollte.

### [HOCH] Unauthorized-Hinweis verweist auf eine Option, die es nicht gibt

`android/app/src/main/java/com/pocketagent/app/ui/screens/Common.kt:257`

Bei ConnState.Unauthorized sagt die Verbindungszeile: 'Gerät nicht mehr gekoppelt. Bitte in den Einstellungen neu koppeln.' (Z. 257-258). Die Einstellungen (SettingsScreen.kt) haben aber keinen Punkt 'Neu koppeln' — nur 'Von diesem Gerät abmelden' (Z. 479), das erst nach einem Bestätigungsdialog Token und URL löscht und so indirekt zum PairingScreen führt. Der Nutzer sucht eine Funktion, die anders heißt und destruktiv klingt. In der schlimmsten Lage der App (ausgesperrt) ist die einzige Anleitung falsch.

**Vorschlag:** Entweder den Hinweistext an die Realität anpassen ('… in den Einstellungen abmelden und neu koppeln') oder besser: die Unauthorized-Zeile direkt antippbar machen und zum Pairing führen (bzw. in den Einstellungen eine Zeile 'Neu koppeln' anbieten, die tokenStore.clear() + PairingScreen in einem Schritt macht).

### [HOCH] Diff-Screen ohne Handlung: Prüfen und Pushen sind getrennte Welten

`android/app/src/main/java/com/pocketagent/app/ui/screens/DiffScreen.kt:95`

Der natürliche Fluss ist 'Diff prüfen -> gut -> pushen'. Der DiffScreen bietet aber nur Zurück und Refresh (Z. 95-102); Pushen liegt ausschließlich im Overflow-Menü des SessionScreens ('Pushen & Draft-PR', SessionScreen.kt:554-560, hinter MoreVert oben rechts). Wer den Diff geprüft hat, muss zurück navigieren, das Drei-Punkte-Menü oben (schlechte Daumen-Reichweite) öffnen und dort die Kernaktion des Produkts suchen. Die wichtigste Entscheidung des Flusses hat keinen sichtbaren Platz.

**Vorschlag:** Auf dem DiffScreen unten einen primären Pill-Button 'Pushen & Draft-PR' zeigen (nur wenn mode != YOLO und Änderungen existieren) — im Daumenbereich, wo im Rest der App die Primäraktion liegt. Im SessionScreen kann der Overflow-Eintrag bleiben, aber der Diff-Screen ist der Ort der Entscheidung.

### [HOCH] PR-Erfolg ist eine Sackgasse: PushCard und PR-Zeile sind nicht antippbar

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionScreen.kt:1867`

Die PushCard in der Timeline (Z. 1867-1899) zeigt 'Gepusht · Draft-PR erstellt' und den Branch, hat aber keinen onClick — die prUrl wird angezeigt aber nie verlinkt. Gleiches auf der Session-Karte: 'Pull Request offen' (SessionListScreen.kt:598-605) ist reiner Text. Der einzige Weg zum PR ist Long-Press auf die Listenkarte -> Aktions-Sheet -> 'Pull Request öffnen' (SessionAction.OPEN_PR) — drei Interaktionen und eine versteckte Geste für den Höhepunkt des gesamten Flusses. Der Moment des Erfolgs endet blind.

**Vorschlag:** PushCard klickbar machen (prUrl != null -> uriHandler.openUri), z. B. mit kleinem OpenInNew-Icon rechts. Die 'Pull Request offen'-Zeile auf der Karte ebenso antippbar machen oder als tappbaren Chip ausführen. Das Aktions-Sheet kann den Eintrag behalten, aber der direkte Weg muss am Ort der Meldung liegen.

### [HOCH] Secret-Löschen per Wisch ohne Bestätigung und ohne Undo

`android/app/src/main/java/com/pocketagent/app/ui/screens/SettingsScreen.kt:432`

SwipeToDismissRow ruft onDismiss = { vm.deleteSecret(secret.id) } direkt auf (Z. 432, Definition Z. 698-730) — ein einziger Wisch entfernt einen Vault-Zugang endgültig, ohne Dialog, ohne Snackbar-Rückgängig. Der Tap-Weg über das Sheet (Z. 511-518) führt dagegen zu einem Bestätigungsdialog, der explizit warnt: 'Adapter, die ihn nutzen, können danach nicht mehr starten.' Dieselbe destruktive Aktion ist also auf einem Weg abgesichert und auf dem anderen nicht. In der Session-Liste ist der Lösch-Wisch korrekt abgefangen (SessionListScreen.kt:395-402 federt zurück und fragt) — die Settings widersprechen dem eigenen Muster.

**Vorschlag:** Wisch-Verhalten an das der Session-Liste angleichen: EndToStart-Wisch federt zurück und öffnet den bestehenden Bestätigungsdialog (confirmDeleteSecret = secret; return false in confirmValueChange). Alternativ den Wisch auf Secrets ganz entfernen — Löschen über das Sheet reicht, ein Zugang wird selten entfernt.

### [MITTEL] Diff: alle Dateien immer voll ausgeklappt — kein Überblick bei großen Changes

`android/app/src/main/java/com/pocketagent/app/ui/screens/DiffScreen.kt:274`

Jede DiffEntryCard rendert den kompletten Patch sofort (Z. 274-288); es gibt keine Möglichkeit, Dateien einzuklappen. Bei einem Agent-Turn mit 15 Dateien wird der Screen ein kilometerlanger Scroll, in dem die Datei-Übersicht (welche Dateien, wie viel) verloren geht — genau die Prüf-Frage ('was wurde überhaupt angefasst?') ist am schwersten zu beantworten. Die Summary-Zeile oben (Z. 184-205) zählt nur.

**Vorschlag:** Karten einklappbar machen: Kopf (Dateiname, Ordner, +/-) immer sichtbar und antippbar, Patch klappt auf — dasselbe Expand-Muster, das ToolCard und StartProgressCard schon verwenden (ExpandMore + AnimatedVisibility). Bei wenigen Dateien (z. B. <= 3) initial aufgeklappt, sonst zu.

### [MITTEL] Dieselbe Einstellung heißt 'Autonomie' beim Anlegen und 'Modus' in der Session

`android/app/src/main/java/com/pocketagent/app/ui/screens/NewSessionScreen.kt:624`

Der Chip beim Anlegen heißt 'Autonomie' (Z. 624, Sheet-Titel Z. 711), derselbe Wert in der laufenden Session heißt 'Modus' (SessionScreen.kt:667, ModeSheet-Default 'Modus' Z. 1271). Die Einträge sind wortgleich (der Code erzwingt das sogar bewusst über ein geteiltes ModeSheet), aber der Name der Kategorie wechselt — der Nutzer muss lernen, dass zwei Begriffe eins sind. Konsistenz der Benennung ist billiger als jede Erklärung.

**Vorschlag:** Einen Begriff wählen und überall verwenden — 'Autonomie' ist der sprechendere ('Modus' sagt nichts). Den title-Parameter von ModeSheet entfernen, damit die Abweichung gar nicht mehr möglich ist.

### [MITTEL] Neue Session: bis zu 7 Entscheidungen, Netzwerk als Dauerpräsenz zu viel

`android/app/src/main/java/com/pocketagent/app/ui/screens/NewSessionScreen.kt:627`

Der Anlege-Screen stellt Agent, Modell (Provider + Modell-Freitext + Reasoning in einem Sheet), Autonomie, Netzwerk, Erweitert (Branch), Repository und Prompt zur Wahl. Der 'Netzwerk'-Chip (Z. 627-631) steht gleichrangig neben Agent und Modell, obwohl 'allowlist' der empfohlene Default ist und die Wahl selten geändert wird; der Chip-Wert 'Allowlist' ist zudem für Nicht-Techniker kryptisch. Der Kommentar begründet die Sichtbarkeit mit Sicherheitsrelevanz — aber sicherheitsrelevant ist die Abweichung vom Default, nicht der Default selbst.

**Vorschlag:** Netzwerk ins 'Erweitert'-Sheet verschieben. Weicht die Wahl vom Default ab, erscheint sie als Chip/Hinweis auf dem Screen (dasselbe Muster nutzt die App schon: die Session-Karte zeigt networkPolicy nur wenn != 'allowlist', SessionListScreen.kt:594-596). So bleiben vier Kernentscheidungen: Repo, Agent, Modell, Autonomie.

### [MITTEL] Repository-Auswahl als DropdownMenu bricht das Sheet-Idiom der App

`android/app/src/main/java/com/pocketagent/app/ui/screens/NewSessionScreen.kt:1014`

Jede andere Auswahl der App (Agent, Modell, Modus, Netzwerk, Aktions-Menüs) ist ein Bottom Sheet mit GroupCard/SelectableTile — bewusst begründet mit Erreichbarkeit ('auf großen Displays erreichbar, statt als winziges Dropdown am oberen Rand zu kleben', SessionListScreen.kt:669-671). Nur die wichtigste Auswahl des Anlege-Screens, das Repository, ist ein DropdownMenu (Z. 1014-1039) — oben am Bildschirm, schmal, ohne Radio-Konvention, bei vielen Repos ohne Suche.

**Vorschlag:** RepoSelector auf SettingSheet + SelectableTile umstellen (inkl. 'Repository hinzufügen' als AddRow im Sheet). Ein Muster für alle Auswahlvorgänge — die App liest sich dann wirklich als ein System.

### [MITTEL] Modell beim Anlegen nur als Freitext mit Format-Raten

`android/app/src/main/java/com/pocketagent/app/ui/screens/NewSessionScreen.kt:830`

Im Modell-Sheet des Anlege-Screens ist das Modell ein Freitextfeld mit dem Hinweis 'Format je nach Agent, z. B. zai-coding/glm-5.3' (Z. 830-848) — der Nutzer muss eine adapter-spezifische Id auswendig kennen und fehlerfrei tippen; ein Tippfehler fällt erst in der laufenden Session auf. Der Kommentar (Z. 746-748) begründet das damit, dass der Katalog erst nach Session-Start existiert — aber dem Nutzer wird dieser Weg ('leer lassen, später im Session-Sheet aus der Liste wählen') nirgends gesagt.

**Vorschlag:** Das Freitextfeld hinter eine Zeile 'Eigenes Modell …' zurückstufen (wie im Session-ModelSheet) und den Default prominent machen: 'Standard des Agenten — das Modell lässt sich in der laufenden Session aus der Liste wählen.' Damit ist der 95%-Fall (Default) ein No-Op und der Fehltipp-Pfad verschwindet aus dem Hauptweg.

### [MITTEL] Falscher Leer-Zustand beim Kaltstart der Session-Liste

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionListScreen.kt:231`

if (allSessions.isEmpty()) { EmptySessions(...) } (Z. 231-232) unterscheidet nicht zwischen 'noch nicht geladen' und 'wirklich leer'. Beim App-Start läuft refreshSessions() asynchron (Z. 133); bis die Antwort da ist, zeigt die Liste 'Noch keine Session' samt CTA 'Erste Session starten' — auch bei Nutzern mit zehn Sessions. Der SessionScreen löst exakt dasselbe Problem bewusst richtig ('Solange der Verlauf unterwegs ist, wird nicht behauptet, die Session sei leer', SessionScreen.kt:759-771). Die Liste widerspricht dem eigenen Prinzip.

**Vorschlag:** Einen Erst-Lade-Zustand einführen (z. B. repository-seitiges sessionsLoaded-Flag oder ein initiales null statt emptyList): solange nicht geladen, dezenter Spinner bzw. gar nichts — der Empty-State mit CTA erst, wenn der Server wirklich 'leer' gemeldet hat.

### [MITTEL] Lösch-Wisch von links kollidiert mit der System-Zurück-Geste

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionListScreen.kt:395`

SwipeToDismissBoxValue.StartToEnd (Wisch von links nach rechts, Z. 395-402) ist als Löschen belegt. Bei Android-Gestennavigation beginnt genau dort, an der linken Bildschirmkante, die Zurück-Geste — ein Zurück-Wisch, der einen Millimeter zu weit innen ansetzt, startet den Lösch-Wisch samt Haptik und Bestätigungsdialog. Umgekehrt frustriert es, wenn der Lösch-Wisch als Zurück interpretiert wird. Die aggressivste Aktion der Liste liegt auf der ambivalentesten Geste.

**Vorschlag:** Lösch-Wisch entfernen (enableDismissFromStartToEnd = false): Löschen bleibt über Long-Press -> Aktions-Sheet erreichbar, wo es mit Erklärtext ('Endgültig – mit Verlauf und Arbeitsstand') ohnehin besser aufgehoben ist. Der Archiv-Wisch (EndToStart, ungefährlich, umkehrbar) bleibt als einzige Wischgeste — weniger, aber besser.

### [MITTEL] Session-Karte trägt bis zu 6 Metadaten-Elemente — Chips ohne Entscheidungswert

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionListScreen.kt:588`

Jede Karte zeigt: Titel, Unterzeile (Repo · Zeit), Status-Badge (getönte Pille mit Pulspunkt), Adapter-Chip, Modus-Chip, ggf. Netzwerk-Chip (Z. 588-597) und ggf. 'Pull Request offen' (Z. 598-605). Adapter und Modus helfen beim Scannen der Liste kaum — die Frage in der Liste ist 'welche Session, was ist ihr Zustand', nicht 'welches Harness in welchem Modus'. Die Chips wiederholen zudem, was der Session-Screen ohnehin prominent zeigt.

**Vorschlag:** Adapter- und Modus-Chip von der Karte nehmen; der Adapter kann als Wort in die Unterzeile (Repo · Adapter · Zeit). Auf der Karte verbleiben: Name, Unterzeile, Status-Badge, und ausnahmebasiert Netzwerk-Abweichung und PR-Zeile (als tappbarer Link, s. eigenes Finding). Die Liste wird ruhiger und der Status sticht wieder.

### [MITTEL] Adapter und Modus stehen im SessionScreen doppelt auf dem Bildschirm

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionScreen.kt:519`

Die StatusLine unter dem Titel nennt Status, Repo, Adapter, Modus und ggf. Netzwerk (Z. 519-529); die Chip-Reihe über dem Composer nennt Agent und Modus erneut, dazu Modell und Reasoning (Z. 646-690). Adapter und Modus sind also gleichzeitig zweimal sichtbar — einmal als Text oben, einmal als Chip unten. Das ist Redundanz ohne Zusatznutzen und macht beide Zeilen schwerer lesbar.

**Vorschlag:** Die StatusLine auf das reduzieren, was die Chips nicht tragen: Status(-punkt) und Repository. Adapter/Modus/Modell/Reasoning leben ausschließlich in den Chips, die sie auch ändern können — der Ort der Information ist dann zugleich der Ort der Handlung.

### [MITTEL] Zwei 'Stop'-Konzepte: Abbruch-Icon oben und 'Session pausieren' im Menü

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionScreen.kt:540`

In der Top-Bar erscheint bei laufendem Turn ein Stop-Icon (Icons.Filled.Stop, Z. 539-545) für 'Aktuellen Auftrag abbrechen'; im Overflow daneben liegt 'Session pausieren' (Container stoppen, Z. 573-576) mit Close-Icon. Zwei benachbarte Aktionen, die beide 'etwas anhalten', unterscheiden sich nur über contentDescription bzw. Menütext — visuell ist das Stop-Quadrat mehrdeutig, und ein Fehlgriff (Container statt Turn gestoppt) kostet den Sessionstart. Der Code-Kommentar (Z. 541-543) erkennt das Problem selbst, löst es aber nur für Screenreader.

**Vorschlag:** Den Turn-Abbruch aus der Top-Bar zum Geschehen verlegen: solange busy, den runden Senden-Button im Composer zum Stop-Button machen (bekanntes Muster aus Chat-UIs, im Daumenbereich, eindeutig 'bricht das Laufende ab'). Oben bleibt nur Diff + Menü; 'Session pausieren' ist dann das einzige Stop-Wort im Menü.

### [MITTEL] Secret-Katalog: 13 Arten mit Duplikat (moonshot/kimi) und kryptischen Kind-Ids im Dialog

`android/app/src/main/java/com/pocketagent/app/ui/screens/SettingsScreen.kt:174`

SECRET_CATALOG (Z. 174-188) listet 13 Arten, darunter 'Moonshot/Kimi' und 'Kimi' als zwei Einträge mit identischer Beschreibung ('API-Key von platform.moonshot.ai') — zwei Wege zum selben Anbieter verwirren im Auswahl-Dropdown. Das Dropdown zeigt zudem unter jedem Anzeigenamen die rohe Kind-Id ('claude_oauth', 'zai', Z. 817-822) — Implementierungsvokabular im Nutzerdialog. Dazu doppelt die Sektion 'Empfohlen' (Z. 384-417) dieselben Key-Tiles, die eine Karte tiefer unter 'Zugänge' wieder auftauchen.

**Vorschlag:** moonshot/kimi zu einem Eintrag zusammenführen (Alias serverseitig auflösen). Die Kind-Id im Dropdown weglassen — der Anzeigename plus Beschreibung reicht; die Id ist nur für 'Eigene Art' relevant. 'Empfohlen' auf maximal die 1-2 wirklich blockierenden Zugänge beschränken (z. B. nur github) oder als Inline-Hinweis in 'Zugänge' integrieren statt als eigene Sektion.

### [NIEDRIG] 'Erweitert' hinter anonymem Zahnrad-Icon-Chip

`android/app/src/main/java/com/pocketagent/app/ui/screens/NewSessionScreen.kt:632`

Der Advanced-Sheet-Zugang ist ein SettingIconChip nur mit Zahnrad (Z. 632-636) — dasselbe Icon wie 'Einstellungen' in der Top-Bar der Liste und in der NavRail. Es enthält aber nur den Basis-Branch. Ein Zahnrad, das etwas anderes bedeutet als das andere Zahnrad der App, kostet einen Explorations-Tap.

**Vorschlag:** Da nur der Branch drinsteckt: den Chip 'Branch' nennen (Wert = aktueller Basis-Branch), oder das Feld ganz ins Repository-Sheet legen (das Ergebnis steht ohnehin dort als 'Basis: …'-Untertitel, Z. 995-1005). Ein 'Erweitert' mit einem einzigen Feld ist eine Schublade für eine Büroklammer.

### [NIEDRIG] Pairing-Logo ist das Mac-Befehlssymbol '⌘'

`android/app/src/main/java/com/pocketagent/app/ui/screens/PairingScreen.kt:137`

Der Willkommens-Kreis zeigt das Zeichen '⌘' als Text (Z. 136-140) — das Looped-Square ist auf Android semantisch die Mac-Command-Taste und wirkt als App-Identität geliehen. Erster Eindruck der App ist ein fremdes Plattform-Symbol.

**Vorschlag:** Durch das eigene App-Icon bzw. das ohnehin verwendete SmartToy-Motiv (EmptySessions, NavRail) ersetzen — ein Symbol als Identität, überall dasselbe.

### [NIEDRIG] Empty-States nutzen hartkodierte 40.dp statt der Spacing-Tokens

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionListScreen.kt:487`

EmptySessions (Z. 487), der Session-Empty-State (SessionScreen.kt:775), Diff-Error und Diff-Empty (DiffScreen.kt:118, 154) verwenden alle padding(horizontal = 40.dp) als magische Zahl, während der Rest der App durchgängig auf Theme-Tokens (ScreenGutter, ContentInset, SectionSpacing) läuft. Das ist der einzige wiederkehrende Wert ohne Token — vier Stellen, die bei einer Grid-Änderung vergessen würden.

**Vorschlag:** Ein Token EmptyStateInset (o. ä.) in Theme.kt anlegen und die vier Stellen darauf umstellen — gleiche Konsequenz wie beim Rest des Spacing-Systems.

### [NIEDRIG] ToolCard nennt das Tool doppelt, wenn kein Titel existiert

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionScreen.kt:1657`

Die Titelzeile zeigt item.title ?: item.tool (Z. 1657) und die Unterzeile immer '${item.tool} · $statusText' (Z. 1662). Fehlt der Titel, steht der Toolname zweimal direkt untereinander (z. B. 'Bash' / 'Bash · ok').

**Vorschlag:** Bei title == null die Unterzeile auf den Status reduzieren ('ok'/'läuft'/'Fehler') oder den Toolnamen nur in einer der beiden Zeilen führen.

### [NIEDRIG] Modus-Labels sind englischer Jargon in deutscher UI ('Yolo', 'Ask', 'Accept Edits')

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionScreen.kt:971`

modeLabel (Z. 971-976) liefert 'Ask', 'Accept Edits', 'Auto', 'Yolo' in einer ansonsten komplett deutschen Oberfläche. Die Untertitel im ModeSheet erklären sie gut (Z. 1276-1281), aber auf Chips und Karten stehen die Labels ohne Erklärung; 'Yolo' benennt die riskanteste Einstellung mit einem Scherzwort, dessen Tragweite ('pusht selbstständig') man nicht ablesen kann.

**Vorschlag:** Deutsche, tragweite-anzeigende Labels erwägen: 'Nachfragen', 'Edits frei', 'Automatisch', 'Vollautomatisch (Push)'. Mindestens 'Yolo' sollte im Chip-/Kartenkontext seine Konsequenz tragen — die rote Einfärbung im Sheet (Z. 1288-1292) ist ein Anfang, erscheint aber nur dort.

### [NIEDRIG] Approval-Karte: 'Immer' gleichrangig neben 'Erlauben', 'Ablehnen' unauffällig darunter

`android/app/src/main/java/com/pocketagent/app/ui/screens/SessionScreen.kt:1774`

Die Buttonzeile setzt 'Erlauben' (gefüllt) und 'Immer' (TextButton) mit gleichem weight(1f) nebeneinander (Z. 1774-1794); 'Ablehnen' steht allein, linksbündig, klein darunter. 'Immer erlauben' ist die weitreichendste Entscheidung der Karte (gilt für alle künftigen gleichen Aktionen) und erhält denselben optischen Raum wie die Einmal-Erlaubnis, während die sichere Option (Ablehnen) am wenigsten Gewicht hat.

**Vorschlag:** Rangfolge schärfen: 'Erlauben' gefüllt und dominant, 'Ablehnen' als gleichhoher Outlined/Text-Button daneben, 'Immer erlauben' als kleinere Textzeile darunter (bewusster Zweit-Tap). Die dauerhafte Entscheidung darf nicht der bequemste Nachbar des Standard-Taps sein.

### [NIEDRIG] Server-Statistik-Block (Uptime, Container) ist Admin-Info ohne Handlungswert

`android/app/src/main/java/com/pocketagent/app/ui/screens/SettingsScreen.kt:317`

Die Sektion 'Server' (Z. 317-333) zeigt vier Zeilen: Verbindung, aktive Sessions, laufende Container, Laufzeit. Verbindung ist redundant zur ConnectionLine, die überall erscheint; Sessions-Zahl steht in der Liste; 'Laufende Container' und 'Laufzeit' beantworten keine Frage, die die App stellt — es sind Debug-Werte, die die Einstellungen länger machen.

**Vorschlag:** Auf eine Zeile reduzieren (Server-URL + Verbindungsstatus); Uptime/Container-Details höchstens hinter einem Tap ('Server-Details') oder ganz streichen — wer das braucht, hat ein Server-Dashboard.
