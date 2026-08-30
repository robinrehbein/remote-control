/**
 * PocketAgent v2 — gemeinsames Protokoll (pi-only).
 *
 * Einzige Quelle der Wahrheit für:
 *  - den REST-Contract Orchestrator -> Runner (im Session-Container bzw.
 *    in-process im Link-Agent): POST /prompt, /abort, /resume,
 *    /permissions/:id, GET /status, /models, /diff, /events
 *  - den normalisierten Event-Strom (SSE vom Runner, per WS an die App)
 *  - die WebSocket-Nachrichten App <-> Orchestrator
 *  - das Link-Protokoll (Heartbeat, Session-Announce, terminale Close-Codes)
 *  - die Pairing-REST-Typen
 *  - die pi-Tabellen (Provider -> Env-Var, Modi-Semantik), die Server, Runner
 *    und App früher jeweils für sich hielten
 *
 * Das Wire-Format ist zu v1 kompatibel für alles, was übernommen wurde — die
 * App verlässt sich darauf. Entfallen ist ausschließlich die Multi-Adapter-
 * Schicht (siehe GREENFIELD-PI.md): AdapterDescriptor/-Manifest, AuthFlow und
 * die Codex-OAuth-Nachrichten (`auth.*`), `adapter.list` sowie das Feld
 * `adapter` in `session.create`/`session.update`/`SessionInfo`/`ShimStatus`/
 * `agent.hello`. Empfänger ignorieren unbekannte JSON-Felder, ein alter Client
 * der `adapter` noch mitsendet wird also nicht abgewiesen — der Server liest es
 * schlicht nicht mehr.
 *
 * Dieses Paket MUSS eine einzige Datei bleiben und ohne Laufzeit-Abhängigkeiten
 * auskommen: der Runner-Container lädt es als TypeScript-Quelle über Nodes
 * Type-Stripping, und das löst — anders als tsx und tsc — einen Import
 * './x.js' nicht auf './x.ts' auf. Eine zweite Datei würde in der Entwicklung
 * überall laden und jeden Session-Container beim Start zerlegen. Aus demselben
 * Grund importiert hier nichts aus `node:*`: Senken und Umgebungen kommen als
 * strukturelle Typen bzw. als Record herein.
 */

/* ------------------------------------------------------------------ */
/* pi: Provider-Tabelle (Quelle: ehemals shims/pi/adapter.json)        */
/* ------------------------------------------------------------------ */

/**
 * Provider -> Env-Variable, unter der der Runner-Container den API-Key
 * erwartet. Der Orchestrator baut daraus die Container-Umgebung (genau der
 * Key des gewählten Providers wird injiziert, nie alle), der Runner liest die
 * Variable, und die App benutzt dieselben Ids als `SecretKind`.
 *
 * `moonshot` und `kimi` teilen sich bewusst `KIMI_API_KEY`: pi spricht beide
 * Kataloge über dieselbe Moonshot-Plattform an, die Ids bleiben trotzdem
 * getrennt, weil die Modellkataloge unterschiedlich heißen.
 */
export const PI_PROVIDER_ENV = Object.freeze({
  openai: 'OPENAI_API_KEY',
  zai: 'ZAI_API_KEY',
  moonshot: 'KIMI_API_KEY',
  kimi: 'KIMI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
} as const);

/** Die von pi unterstützten Provider-Ids (Schlüssel von `PI_PROVIDER_ENV`). */
export type PiProviderId = keyof typeof PI_PROVIDER_ENV;

/**
 * Menschenlesbare Metadaten zu einem Provider-Key. Rein kosmetisch: die App
 * rendert Anzeigename, „Key anlegen"-Link und Einrichtungshinweis daraus,
 * statt eine eigene Tabelle zu pflegen.
 */
export interface ProviderDescriptor {
  /** Provider-Id == Schlüssel von `PI_PROVIDER_ENV` == `SecretKind`. */
  id: PiProviderId;
  /** Anzeigename, z. B. "Google Gemini". */
  name: string;
  /** Seite, auf der der Nutzer den Key anlegt/kopiert. */
  keyUrl?: string;
  /** Einzeiler für den Secret-Dialog. */
  hint?: string;
}

/**
 * Reihenfolge ist Anzeigereihenfolge in der App (häufigster Provider zuerst).
 * Die Hinweise sind absichtlich deutsch — sie erscheinen unverändert in der UI.
 */
export const PI_PROVIDERS: readonly ProviderDescriptor[] = Object.freeze([
  { id: 'openai', name: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', hint: 'API-Key von platform.openai.com (sk-…)' },
  { id: 'zai', name: 'Z.AI', keyUrl: 'https://z.ai/manage-apikey/apikey-list', hint: 'API-Key aus dem Z.AI-Dashboard' },
  { id: 'moonshot', name: 'Moonshot', keyUrl: 'https://platform.moonshot.ai/console/api-keys', hint: 'API-Key von platform.moonshot.ai' },
  { id: 'kimi', name: 'Kimi', keyUrl: 'https://platform.moonshot.ai/console/api-keys', hint: 'API-Key von platform.moonshot.ai (gleicher Key wie Moonshot)' },
  { id: 'anthropic', name: 'Anthropic', keyUrl: 'https://console.anthropic.com/settings/keys', hint: 'API-Key von console.anthropic.com (sk-ant-…)' },
  { id: 'google', name: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey', hint: 'API-Key aus Google AI Studio' },
] as const satisfies readonly ProviderDescriptor[]);

/** Provider-Ids in Anzeigereihenfolge — abgeleitet, damit nichts driften kann. */
export const PI_PROVIDER_IDS: readonly PiProviderId[] = Object.freeze(PI_PROVIDERS.map((p) => p.id));

/** Vorgabe für neue Sessions, wenn die App keinen Provider mitschickt. */
export const PI_DEFAULT_PROVIDER: PiProviderId = 'openai';

/** True für eine Id, die pi kennt (Eingangsprüfung für WS/REST-Payloads). */
export function isPiProvider(id: string): id is PiProviderId {
  return Object.prototype.hasOwnProperty.call(PI_PROVIDER_ENV, id);
}

/**
 * Env-Variable für einen Provider oder `undefined` für eine unbekannte Id.
 * Der Orchestrator injiziert dann keinen Key, statt einen falschen Namen zu
 * setzen — der Runner meldet den fehlenden Key sauber als Turn-Fehler.
 */
export function piProviderEnvVar(provider: string): string | undefined {
  return isPiProvider(provider) ? PI_PROVIDER_ENV[provider] : undefined;
}

/* ------------------------------------------------------------------ */
/* pi: Modi-Semantik                                                   */
/* ------------------------------------------------------------------ */

/** Reihenfolge = Anzeigereihenfolge (von „freilaufend" nach „streng"). */
export const AGENT_MODES = Object.freeze(['yolo', 'auto', 'acceptEdits', 'ask'] as const);

export type AgentMode = (typeof AGENT_MODES)[number];

/** Vorgabe, wenn weder Session noch Prompt einen Modus setzen. */
export const DEFAULT_AGENT_MODE: AgentMode = 'ask';

export function isAgentMode(value: string): value is AgentMode {
  return (AGENT_MODES as readonly string[]).includes(value);
}

/** Gating-Stufe eines Tool-Typs: nie / nur riskante Aufrufe / immer nachfragen. */
export type GateLevel = 'none' | 'risky' | 'all';

/**
 * Was ein Modus konkret bedeutet. Bisher stand diese Matrix nur als Kommentar
 * an der Approval-Weiche im pi-Shim; App (Modus-Auswahl), Server (AUTO_PUSH)
 * und Runner (Gating) sollen dieselbe Quelle lesen.
 *
 * Reine Lese-Tools (read/grep/glob/…) werden in *keinem* Modus gegated — das
 * ist Eigenschaft des Tools, nicht des Modus, und taucht deshalb hier nicht auf.
 */
export interface PiModeSemantics {
  id: AgentMode;
  /** Kurzlabel für die App. */
  name: string;
  /** Auto-Commit + Push + Draft-PR nach jedem abgeschlossenen Turn. */
  autoPush: boolean;
  /** Gating für Shell-Aufrufe. `risky` = nur bei erkannt gefährlichem Kommando. */
  bash: GateLevel;
  /** Gating für Datei-Änderungen (edit/write). */
  edits: Extract<GateLevel, 'none' | 'all'>;
  /** Einzeiler für die Modus-Auswahl in der App. */
  hint: string;
}

/**
 * Die vier Modi. `yolo` ist der einzige Modus mit Auto-Push: er ist als
 * „laufen lassen und Ergebnis als Draft-PR abholen" gedacht, alle anderen
 * pushen erst auf Tap (`session.push`).
 */
export const PI_MODE_SEMANTICS: Readonly<Record<AgentMode, PiModeSemantics>> = Object.freeze({
  yolo: {
    id: 'yolo',
    name: 'Yolo',
    autoPush: true,
    bash: 'none',
    edits: 'none',
    hint: 'Keine Rückfragen; pusht nach jedem Turn und legt einen Draft-PR an.',
  },
  auto: {
    id: 'auto',
    name: 'Auto',
    autoPush: false,
    bash: 'risky',
    edits: 'none',
    hint: 'Änderungen laufen durch; nur riskante Shell-Kommandos werden nachgefragt.',
  },
  acceptEdits: {
    id: 'acceptEdits',
    name: 'Edits ok',
    autoPush: false,
    bash: 'all',
    edits: 'none',
    hint: 'Datei-Änderungen laufen durch, jedes Shell-Kommando wird nachgefragt.',
  },
  ask: {
    id: 'ask',
    name: 'Nachfragen',
    autoPush: false,
    bash: 'all',
    edits: 'all',
    hint: 'Fragt vor jeder Änderung und jedem Kommando nach.',
  },
} as const satisfies Record<AgentMode, PiModeSemantics>);

/**
 * Auto-Push ist Eigenschaft des Modus *dieses Turns*, nicht des Modus, mit dem
 * der Container gestartet ist: `session.update` schaltet yolo<->ask mitten in
 * der Session um, während `AUTO_PUSH` seit dem Containerstart eingefroren ist.
 * Ein Prompt ohne Modus (älterer Orchestrator) behält deshalb die Env-Vorgabe.
 */
export function autoPushForMode(mode: AgentMode | undefined, envDefault: boolean): boolean {
  return mode === undefined ? envDefault : PI_MODE_SEMANTICS[mode].autoPush;
}

/* ------------------------------------------------------------------ */
/* Gemeinsame Aufzählungen                                             */
/* ------------------------------------------------------------------ */

/**
 * Normalisiertes Denk-Budget. pi bildet die drei Stufen auf seine
 * Reasoning-Option ab; Modelle ohne solche Option ignorieren das Feld.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high'] as const);

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Netzwerk-Isolation je Session:
 *  - 'allowlist' (Vorgabe): internes Docker-Netz, Ausgang nur über den
 *    HTTP(S)-Proxy des Orchestrators, beschränkt auf eine Host-Allowlist.
 *  - 'isolated': internes Docker-Netz ohne Proxy => gar kein Internet.
 *  - 'open': normales Docker-Netz mit direktem Internetzugang.
 * Link-Sessions laufen auf fremder Hardware; dort ist die Policy nur
 * dokumentarisch — der Link-Agent erzwingt sie nicht.
 */
export type NetworkPolicy = 'allowlist' | 'isolated' | 'open';

export type SessionStatus =
  | 'creating'   // Container wird erzeugt / Repo geklont
  | 'running'    // Agent arbeitet an einem Prompt
  | 'idle'       // Container läuft, wartet auf Eingabe
  | 'stopped'    // Container gestoppt, Volume erhalten (fortsetzbar)
  | 'error';

/**
 * Lebenszyklus eines einzelnen Turns — abzugrenzen von `SessionStatus`: eine
 * Session ist ein langlebiger Container, ein Turn eine Prompt-zu-Antwort-Runde
 * darin. Lineare Maschine: `queued` (angenommen, persistiert, noch nicht an den
 * Runner übergeben) → `running` → genau ein Endzustand:
 *  - `completed`   : der Agent hat den Turn beendet (`turn.completed`).
 *  - `failed`      : der Turn endete im Fehler, siehe `TurnFailureReason`.
 *  - `interrupted` : von außen abgeschnitten (Abbruch durch den Nutzer oder ein
 *                    Server-Neustart, der den laufenden Turn verloren hat).
 * Nach einem Reconnect liest die App die Turns einer Session, statt deren
 * Ausgang aus dem Event-Strom zu raten.
 */
export type TurnState = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

/**
 * Strukturierter Grund für `failed`. `stage` benennt, wo es brach (z. B.
 * 'transport', 'runner', 'provision'), `code` ist ein optionaler
 * maschinenlesbarer Tag, `retryable` sagt der App, ob ein neuer Versuch
 * überhaupt Aussicht hat. Garantiert ist nur `message`.
 */
export interface TurnFailureReason {
  message: string;
  stage?: string;
  code?: string;
  retryable?: boolean;
}

/**
 * Ein Turn, wie der Orchestrator ihn persistiert und meldet. `turnId` ist seine
 * eigene Id, `messageId` die von der App erzeugte Id, die den Turn zugelassen
 * hat (fehlt, wenn der Prompt ohne eine kam).
 */
export interface TurnInfo {
  turnId: string;
  sessionId: string;
  messageId?: string;
  state: TurnState;
  createdAt: string;
  updatedAt: string;
  /** Nur im Zustand `failed` gesetzt. */
  reason?: TurnFailureReason;
}

export type PermissionDecision = 'once' | 'always' | 'reject';

/**
 * Art eines genehmigungspflichtigen Tool-Aufrufs. Nur `bash` und `edit`
 * (edit/write): das ist die feste Toolliste des Runners
 * (['read','bash','edit','write','grep','find','ls']), von der read/grep/find/ls
 * reine Lese-Tools sind (nie gegated) und die restlichen drei genau in diese
 * zwei Klassen fallen. Frühere Werte 'webfetch'/'external'/'other' hatte nie ein
 * Tool produziert.
 */
export type PermissionKind = 'bash' | 'edit';

/**
 * Secret-Arten, die der Vault des Orchestrators kennt: die pi-Provider-Ids plus
 * `github` (PAT für Clone/Push/Draft-PR). Der Typ bleibt offen (`string & {}`),
 * damit ein neuer Provider keine Protokolländerung erzwingt; der Server
 * validiert gegen `SECRET_KINDS`.
 */
export const SECRET_KINDS: readonly string[] = Object.freeze([...PI_PROVIDER_IDS, 'github']);

export type SecretKind = PiProviderId | 'github' | (string & {});

/* ------------------------------------------------------------------ */
/* Runner-REST (Orchestrator -> Runner im Session-Container)           */
/*                                                                     */
/* Identisch zum bewährten Shim-Protokoll aus v1, nur ohne die         */
/* „welcher Adapter bin ich"-Felder. Der Link-Agent bedient dieselben  */
/* Pfade in-process und tunnelt sie über `agent.command`/`agent.response`. */
/* ------------------------------------------------------------------ */

/** POST /prompt */
export interface PromptRequest {
  text: string;
  /** Überschreibt den Modus, mit dem der Container gestartet wurde. */
  mode?: AgentMode;
  /**
   * Von der App erzeugte Turn-Id (`msg_<random>`), Ende zu Ende durchgereicht.
   * Optional: ein Prompt ohne sie verhält sich wie früher. Der Orchestrator
   * macht damit einen erneut gesendeten Prompt idempotent (kein doppelter Turn
   * nach einem Funkloch-Reconnect); der Runner darf sie zurückspiegeln, muss
   * aber nicht.
   */
  messageId?: string;
  provider?: string;
  /**
   * Überschreibt das Modell für diesen und alle folgenden Turns. pi adressiert
   * Modelle als provider + id, akzeptiert also auch die Form
   * `"<provider>/<model>"` (dieselben Ids, die GET /models liefert). Der
   * leere String setzt auf die pi-Vorgabe zurück.
   */
  model?: string;
  /** Wird ignoriert, wenn das gewählte Modell keine Reasoning-Stufe kennt. */
  reasoningEffort?: ReasoningEffort;
}

/** Ein Eintrag des Modellkatalogs (GET /models). */
export interface ModelInfo {
  /** Id, die `PromptRequest.model` akzeptiert. */
  id: string;
  /** Anzeigename; die UI fällt auf `id` zurück. */
  name?: string;
}

/** GET /models — eine leere Liste ist gültig (Katalog noch nicht geladen). */
export interface ModelsResponse {
  models: ModelInfo[];
}

/** GET /status */
export interface ShimStatus {
  /** pi-eigene Session-Referenz (Session-Datei), für /resume. */
  sessionRef?: string;
  provider?: string;
  model?: string;
  mode: AgentMode;
  busy: boolean;
}

/** GET /diff — ein Eintrag je geänderter Datei. */
export interface DiffEntry {
  path: string;
  patch: string;
  binary?: boolean;
}

/** Standard-Erfolgshülle */
export interface OkResponse { ok: true }
export interface ErrorResponse { ok: false; error: string }

export type ShimApiResponse = OkResponse | ErrorResponse;

/**
 * Env-Variablen, die der Orchestrator in jeden Session-Container injiziert und
 * die der Runner beim Start liest. Der Link-Agent baut dieselbe Struktur lokal
 * zusammen, auch wenn dort kein Container beteiligt ist.
 */
export interface ShimEnv {
  /**
   * Zufälliges API-Token je Session; der Orchestrator sendet es als
   * `authorization: Bearer <token>` an die Runner-API (u. a. das Permission-Gate).
   * Es ist NICHT das Egress-Proxy-Credential: der Orchestrator leitet daraus einen
   * separaten Wert ab (server/src/runner.ts `proxyTokenFor`) und spielt nur den in
   * die HTTP(S)_PROXY-URL des Containers. Der Runner löscht SHIM_TOKEN direkt nach
   * dem Start aus process.env, damit vom Agenten gestartete Kindprozesse es nicht
   * erben und damit ihr eigenes Approval-Gate umgehen können.
   */
  SHIM_TOKEN: string;
  WORK_DIR: string;              // z. B. /work (Repo-Checkout)
  AGENT_MODE: AgentMode;
  SESSION_ID: string;            // Session-Id des Orchestrators (uuid)
  // Optional: der Link-Embed setzt REPO_URL leer bzw. REPO_FULL_NAME gar nicht
  // (lokaler Checkout, keine PR ohne owner/name). Der Runner behandelt beide
  // ohnehin als „darf fehlen" (ensureRepo/createDraftPr).
  REPO_URL?: string;             // https-Clone-URL, ohne eingebettetes Token
  REPO_BRANCH?: string;          // Basis-Branch (Vorgabe: Default-Branch des Repos)
  GITHUB_PAT?: string;           // nur gesetzt, wenn Push erlaubt ist
  REPO_FULL_NAME?: string;       // owner/name für die PR-API
  /**
   * Nur Startwert (yolo => 1): Auto-Push + Draft-PR nach jedem beendeten Turn.
   * Weil der Modus mitten in der Session umschaltbar ist, entscheidet der
   * Runner pro Turn über `PromptRequest.mode` und fällt nur ohne diesen auf die
   * Env-Vorgabe zurück (siehe `autoPushForMode`).
   */
  AUTO_PUSH: '1' | '0';
  /** Startwerte für Provider/Modell; danach führt `PromptRequest`. */
  PI_PROVIDER?: string;
  PI_MODEL?: string;
  /**
   * Der eine Provider-Key dieser Session, unter dem Namen aus
   * `PI_PROVIDER_ENV` (z. B. OPENAI_API_KEY). Nie werden mehrere injiziert.
   */
  [key: string]: string | undefined;
}

/* ------------------------------------------------------------------ */
/* Normalisierter Event-Strom                                          */
/* ------------------------------------------------------------------ */

export interface TokenUsage {
  input?: number;
  output?: number;
  costUsd?: number;
}

/**
 * Schritt, in dem ein Session-Start gerade steckt; getragen von `notice`:
 *  - 'container-start' : der Session-Container wird gestartet
 *  - 'shim-start'      : der Container bootet (Repo-Clone, Agent-Prozess)
 *  - 'ready'           : der Runner antwortet, die Session nimmt Prompts an
 * Die Reihenfolge ist die eines Starts, aber Clients dürfen nicht annehmen,
 * dass jede Phase vorkommt (eine Link-Session hat keinen Container-Start).
 *
 * Diese drei Schreibweisen sind vollständig: gesendet werden sie AUSSCHLIESSLICH
 * vom Orchestrator (server/src/sessions.ts, server/src/docker.ts); der Runner
 * selbst kennt `phase` gar nicht, seine Notices sind gewöhnliche Systemzeilen.
 * v1 kannte zusätzlich 'image-build'. Das Runner-Image wird zwar weiterhin zur
 * Laufzeit gebaut (`ensureRunnerImage`, beim ersten Start auf einem Host), aber
 * bewusst unter 'container-start' gemeldet — es ist Teil des Container-Starts,
 * keine eigene Phase mehr.
 *
 * `ready` ist das Ende: erst danach nimmt die Session Prompts an, und erst
 * dadurch verschwindet die Fortschrittskarte der App. Ein Startpfad, der nicht
 * in `ready` mündet, MUSS stattdessen in einem `error`-Event enden (die App
 * räumt die Karte auch daran weg) — sonst dreht sie sich ewig.
 */
export type NoticePhase = 'container-start' | 'shim-start' | 'ready';

/**
 * Sequenz-Metadaten, die der `SequencedSseBroadcaster` jedem normalisierten
 * Event aufprägt:
 *  - `seq`: monotone Sequenznummer, gespiegelt im SSE-Feld `id:`. Sie heißt
 *    `seq` und nicht `id`, weil `tool.call`/`tool.result` bereits ein
 *    string-`id` (die Tool-Call-Id) tragen, mit dem sie nicht kollidieren darf.
 *  - `ts`: Sendezeitpunkt in Millisekunden seit Epoch.
 *
 * Beide sind optional: Events aus der gespeicherten Historie oder von einem
 * älteren Sender haben sie nicht, jeder Decoder muss sie als „darf fehlen"
 * behandeln.
 *
 * WICHTIG - zwei Bedeutungen, je nach Hop:
 *  - Runner -> Orchestrator (SSE): `seq` ist der TRANSPORT-Cursor. Er beginnt
 *    bei jedem Runner-Neustart wieder bei 1 (neuer Container, Resume) und ist
 *    nur innerhalb EINES Runner-Streams eindeutig. Er trägt den
 *    Last-Event-ID-Replay: der Orchestrator verbindet sich mit der zuletzt
 *    gesehenen seq neu, der Runner spielt ab dort nach.
 *  - Orchestrator -> Gerät (`session.event`-Broadcast und `session.events.get`-
 *    Historie): `seq` ist die SERVER-kanonische Sequenz - die rowid aus
 *    `session_events`, sessionweit streng monoton, ohne Reset und ohne Kollision
 *    über Resume-Generationen. NUR auf diesem Wert darf die App sessionweit
 *    dedupen (`seq:$id`); die Runner-seq würde nach jedem Neustart kollidieren.
 *    Der Orchestrator ersetzt die Transport-seq beim Broadcast/Read durch diesen
 *    kanonischen Wert (server/src/sessions.ts, db.ts listSessionEvents).
 */
export interface AgentEventMeta {
  seq?: number;
  ts?: number;
}

export type AgentEventBody =
  /** Zustands-Schnappschuss; der Runner sendet ihn beim Verbinden und nach jeder Änderung. */
  | {
      type: 'status';
      sessionRef?: string;
      provider?: string;
      model?: string;
      mode: AgentMode;
      busy: boolean;
    }
  | { type: 'message.delta'; role: 'assistant'; delta: string }
  | { type: 'message.completed'; role: 'assistant' | 'user'; text: string }
  | { type: 'tool.call'; id: string; tool: string; input: unknown; title?: string }
  | { type: 'tool.result'; id: string; tool: string; output: string; isError?: boolean }
  | {
      type: 'permission.request';
      permissionId: string;
      kind: PermissionKind;
      /** Kurzer Titel für die Karte, z. B. "bash: npm install". */
      title: string;
      /** Ausführliches Detail (vollständiges Kommando, Dateiinhalt …). */
      detail?: string;
      /** Unified Diff bei Edit-Freigaben. */
      diff?: string;
      /** Vorgeschlagene Muster für die Entscheidung 'always'. */
      patterns?: string[];
    }
  | { type: 'permission.resolved'; permissionId: string; decision: PermissionDecision }
  | { type: 'turn.completed'; summary?: string; usage?: TokenUsage; commitSha?: string }
  | { type: 'turn.failed'; error: string }
  | { type: 'pushed'; branch: string; prUrl?: string; auto: boolean }
  | { type: 'error'; message: string; fatal?: boolean }
  /**
   * Nicht-fataler Hinweis für die Timeline. Mit `phase` ist es Live-Fortschritt
   * eines Starts: der Client ersetzt damit seine Statuszeile (gleiche Phase =
   * Aktualisierung derselben Zeile, neue Phase = nächster Schritt). Ohne
   * `phase` bleibt es ein gewöhnlicher Timeline-Eintrag.
   */
  | { type: 'notice'; message: string; phase?: NoticePhase; detail?: string }
  /** Keepalive; hält SSE-Verbindung und Zwischenboxen warm, siehe Broadcaster. */
  | { type: 'ping'; ts: number };

/**
 * Ein normalisiertes Event auf dem Draht: Rumpf plus optionale Sequenz-Meta.
 * Konsumenten schalten weiterhin über `type` (der Schnitt erhält die
 * diskriminierte Union), `seq`/`ts` stehen einfach zur Verfügung, wenn da.
 */
export type AgentEvent = AgentEventBody & AgentEventMeta;

/* ------------------------------------------------------------------ */
/* App <-> Orchestrator (WebSocket)                                    */
/* ------------------------------------------------------------------ */

export interface SessionInfo {
  id: string;
  repoId: string;
  repoFullName?: string;
  provider: string;
  model: string;
  mode: AgentMode;
  status: SessionStatus;
  /** Branch, auf dem die Session arbeitet: agent/<session-id> */
  branch: string;
  createdAt: string;
  lastActiveAt: string;
  prUrl?: string;
  networkPolicy?: NetworkPolicy;
  /** Persistierte Reasoning-Stufe; fehlt, wenn nie eine gesetzt wurde. */
  reasoningEffort?: string;
  /** Vom Nutzer gesetzter Name (`session.rename`); fehlt => Client leitet einen ab. */
  title?: string;
  /** Fehlt => false. Archivierte Sessions bleiben in `session.list`, der Client filtert. */
  archived?: boolean;
  /**
   * True für Link-Sessions: der Agent läuft auf dem Rechner des Nutzers
   * (ausgehende WS, kein Container). Fehlt => false. Die Status-Semantik
   * unterscheidet sich: 'stopped' heißt hier „Agent-Host gerade offline".
   */
  linked?: boolean;
}

export interface RepoInfo {
  id: string;
  fullName: string;
  defaultBranch: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  enrolledAt: string;
  /** True, solange das Gerät eine authentifizierte WS-Verbindung hält. */
  online: boolean;
}

export interface LinkInfo {
  id: string;
  name: string;
  createdAt: string;
}

/** Metadaten eines Vault-Eintrags — enthält nie den Klartext. */
export interface SecretInfo {
  id: string;
  kind: SecretKind;
  createdAt: string;
}

export interface ServerStats {
  sessionsActive: number;
  sessionsTotal: number;
  containersRunning: number;
  uptimeSec: number;
  versions: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Link-Agent-Relay (Kilo-Muster „remote connections", siehe             */
/* KILO-CLOUD-ANALYSE.md P2 im Tag v0.13.0 — GREENFIELD-PI.md,           */
/* „Entfallene Dokumente")                                               */
/* ------------------------------------------------------------------ */

/**
 * Status je Session, wie ihn ein Link-Agent im Heartbeat meldet. Der
 * Event-Strom kennt kein Signal für „wartet auf eine Freitext-Antwort", nur
 * `permission.request`; der Server faltet ohnehin alles Nicht-idle auf
 * 'running' (statusFromLinkHeartbeat), sodass 'busy' und 'permission'
 * gleichwertig sind.
 */
export type LinkSessionStatus = 'idle' | 'busy' | 'permission';

/** Eine Session, die ein Link-Agent gerade führt (Inhalt von `agent.heartbeat`). */
export interface LinkSessionState {
  /** Vom Orchestrator vergebene Id, also die `sessionId` aus `agent.ready`. */
  sessionId: string;
  status: LinkSessionStatus;
}

/**
 * WebSocket-Close-Codes für App<->Orchestrator und Link<->Orchestrator (der
 * Bereich 4000-4999 ist laut RFC 6455 privat). Hier zentral, damit `server/`
 * (das sie sendet) und `link/` (das darauf reagiert) nicht auseinanderlaufen;
 * `android/` spiegelt `WS_CLOSE_UNAUTHORIZED` als Literal in `WsClient.kt`,
 * weil Kotlin dieses Paket nicht importieren kann.
 */
/** Eine andere Verbindung hat sich mit demselben Link-Token registriert; dieser Socket hat das Rennen verloren. */
export const WS_CLOSE_REPLACED = 4000;
/** Falsches/fehlendes/widerrufenes Token oder kein `hello`/`agent.hello` innerhalb des Auth-Timeouts. */
export const WS_CLOSE_UNAUTHORIZED = 4001;
/** Verbindungsobergrenze je Quell-Adresse (grober DoS-Schutz), siehe ws.ts. */
export const WS_CLOSE_TOO_MANY_CONNECTIONS = 4002;

/**
 * Terminal in dem Sinn, in dem Kilos 4401/4403/4409 es sind: ein neuer Versuch
 * mit derselben Registrierung kann nie gelingen, der Link-Agent beendet seine
 * Reconnect-Schleife also endgültig statt mit Backoff weiterzuprobieren.
 *  - `WS_CLOSE_UNAUTHORIZED`: das Token ist falsch oder widerrufen — daran
 *    ändert sich ohne menschliches Zutun nichts.
 *  - `WS_CLOSE_REPLACED`: ein anderer Prozess hält den Platz dieses Links.
 *    Ein Reconnect würde drüben dasselbe Ersetzen auslösen (oder beide Seiten
 *    flattern ewig); diese Seite gibt auf und überlässt die Entscheidung dem,
 *    was den Prozess beaufsichtigt (systemd, Dockers Restart-Policy, Mensch).
 * Jeder andere Code — auch `WS_CLOSE_TOO_MANY_CONNECTIONS`, eine
 * vorübergehende Ressourcengrenze, sowie jeder normale Netzabbruch oder
 * Server-Neustart — führt weiter zum Reconnect mit exponentiellem Backoff.
 */
export function isTerminalLinkCloseCode(code: number): boolean {
  return code === WS_CLOSE_UNAUTHORIZED || code === WS_CLOSE_REPLACED;
}

/* ------------------------------------------------------------------ */
/* WS: App/Link -> Server                                              */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  /** Erste Nachricht einer App-Verbindung; ohne sie schließt der Server mit 4001. */
  | { type: 'hello'; deviceId: string; token: string }
  | {
      /** Registrierung eines Link-Agenten (Heim-PC/VPS): ausgehende WS, keine offenen Ports nötig. */
      type: 'agent.hello';
      token: string;
      name?: string;
      mode?: AgentMode;
      branch?: string;
      workDir?: string;
    }
  | {
      type: 'session.create';
      requestId: string;
      repoId: string;
      provider: string;
      /** Leerer String => pi-Vorgabemodell. */
      model: string;
      mode: AgentMode;
      branch?: string;
      networkPolicy?: NetworkPolicy;
    }
  /**
   * `requestId` quittiert diese eine WS-Anfrage über `request.ok` (bzw. `error`
   * mit derselben Id). `messageId` ist die von der App erzeugte Turn-Id
   * (`msg_<random>`), die ein Resend unverändert wiederholt: der Server lässt
   * eine messageId genau einmal zu (idempotent) und spiegelt sie in
   * `request.ok`, damit die App die Quittung ihrem Turn zuordnen kann. Beide
   * sind optional — ohne sie bleibt es beim alten „abschicken und hoffen".
   */
  | { type: 'session.prompt'; sessionId: string; text: string; mode?: AgentMode; requestId?: string; messageId?: string }
  /**
   * Modus / Modell / Reasoning-Stufe einer laufenden Session ändern. Alle
   * Felder optional; der Server persistiert, was gesetzt ist, und antwortet
   * allen Geräten mit `session.status`. (Der Adapterwechsel aus v1 entfällt —
   * es gibt nur pi.)
   */
  | {
      type: 'session.update';
      requestId: string;
      sessionId: string;
      mode?: AgentMode;
      /** Leerer String setzt die Session auf das pi-Vorgabemodell zurück. */
      model?: string;
      reasoningEffort?: ReasoningEffort;
    }
  /** Modellkatalog der Session erfragen (durchgereichtes GET /models). */
  | { type: 'session.models.get'; requestId: string; sessionId: string }
  | { type: 'session.permission'; sessionId: string; permissionId: string; decision: PermissionDecision }
  | { type: 'session.abort'; sessionId: string }
  | { type: 'session.stop'; sessionId: string }
  | { type: 'session.resume'; sessionId: string }
  /** Push + Draft-PR auf Tap (alle Modi außer yolo). */
  | { type: 'session.push'; sessionId: string }
  | { type: 'session.diff.get'; requestId: string; sessionId: string }
  | { type: 'session.list'; requestId: string }
  /**
   * Gespeicherte Timeline einer Session, damit ein Client, der seine
   * In-Memory-Nachrichten verloren hat (Screen verlassen, App neu gestartet),
   * den Verlauf wieder zeigen kann. `limit` zählt die jüngsten Events
   * (Vorgabe 200, max. 1000); die Antwort liefert sie chronologisch, älteste
   * zuerst.
   */
  | { type: 'session.events.get'; requestId: string; sessionId: string; limit?: number }
  /**
   * Turn-Lebenszyklus einer Session. Lässt einen wiederverbundenen Client den
   * Ausgang jedes Turns (`TurnState`) rekonstruieren, statt ihn aus dem
   * Event-Strom zu erschließen. `limit` zählt die jüngsten Turns (Vorgabe 50,
   * max. 500), Antwort älteste zuerst.
   */
  | { type: 'session.turns.get'; requestId: string; sessionId: string; limit?: number }
  /** Session umbenennen; ein leerer Titel entfernt den Namen wieder. */
  | { type: 'session.rename'; requestId: string; sessionId: string; title: string }
  | { type: 'session.archive'; requestId: string; sessionId: string; archived: boolean }
  | { type: 'session.delete'; requestId: string; sessionId: string }
  | { type: 'repo.list'; requestId: string }
  | { type: 'repo.add'; requestId: string; fullName: string; defaultBranch: string }
  | { type: 'secret.set'; requestId: string; kind: SecretKind; value: string }
  /**
   * Einen Key live gegen seinen Provider prüfen, vor bzw. ohne Speichern. Der
   * Wert wird ausschließlich für die eine ausgehende Anfrage benutzt — nie
   * persistiert, geloggt oder zurückgespiegelt.
   */
  | { type: 'secret.validate'; requestId: string; kind: SecretKind; value: string }
  | { type: 'secret.list'; requestId: string }
  | { type: 'secret.delete'; requestId: string; id: string }
  /**
   * FCM-Token des Geräts hinterlegen (nach `hello`, und erneut bei jeder
   * Token-Rotation durch Firebase). Bewusst ohne `requestId`: die App wartet
   * auf keine Antwort, und ein verlorenes Register kostet nur die nächste
   * Push-Zustellung, die beim nächsten Verbinden ohnehin nachgeholt wird.
   */
  | { type: 'fcm.register'; token: string }
  | { type: 'device.list'; requestId: string }
  | { type: 'device.revoke'; requestId: string; deviceId: string }
  | { type: 'link.list'; requestId: string }
  | { type: 'link.revoke'; requestId: string; linkId: string }
  | { type: 'server.stats'; requestId: string };

/* ------------------------------------------------------------------ */
/* WS: Server -> App/Link (und die Link->Server-Gegenrichtung)         */
/*                                                                     */
/* Die `agent.*`-Varianten laufen in beide Richtungen: der Server      */
/* sendet `agent.ready`/`agent.command`/`agent.bye`, der Link-Agent    */
/* antwortet mit `agent.response`/`agent.event`/`agent.heartbeat`.     */
/* Sie stehen zusammen in einem Typ, weil beide Seiten denselben       */
/* Decoder benutzen.                                                   */
/* ------------------------------------------------------------------ */

export type ServerMessage =
  | { type: 'welcome'; ok: true; serverVersion: string }
  /** Server -> Link-Agent: Registrierung akzeptiert, Session gebunden. */
  | { type: 'agent.ready'; sessionId: string }
  /**
   * Server -> Link-Agent: einen Runner-HTTP-Aufruf über die ausgehende WS
   * durchreichen. Keine sessionId - ein Link führt genau eine Session, und der
   * Link-Agent adressiert den Aufruf ohnehin nur über callId/path an seinen
   * eingebetteten Runner.
   */
  | { type: 'agent.command'; callId: string; path: string; method: 'GET' | 'POST'; body?: unknown }
  /** Link-Agent -> Server: Antwort auf ein `agent.command`. */
  | { type: 'agent.response'; callId: string; status: number; body?: unknown }
  /** Link-Agent -> Server: normalisiertes Runner-Event. */
  | { type: 'agent.event'; sessionId: string; event: AgentEvent }
  /** Keepalive in beide Richtungen. */
  | { type: 'agent.ping'; ts: number }
  | { type: 'agent.pong'; ts: number }
  /**
   * Link-Agent -> Server: periodischer Voll-Schnappschuss (~10 s, Kilo-Muster
   * P2). Trägt jede Session, die der Link gerade führt, statt eines Deltas:
   * der Orchestrator braucht keine Event-Buchhaltung, um korrekt zu bleiben,
   * und eine Session-Id, die hier nicht mehr auftaucht, ist aus Sicht des
   * Link-Agenten weg — dieselbe Folgerung wie bei einem Socket-Close, nur ohne
   * dass einer nötig wäre.
   */
  | { type: 'agent.heartbeat'; sessions: LinkSessionState[] }
  /** Server -> Link-Agent: Session aus der App gestoppt; der Link-Agent fährt herunter. Keine sessionId - der Link führt genau eine Session. */
  | { type: 'agent.bye' }
  | { type: 'error'; requestId?: string; sessionId?: string; message: string }
  | { type: 'request.ok'; requestId: string; payload?: unknown }
  | { type: 'session.list'; requestId: string; sessions: SessionInfo[] }
  /** Live-Event einer Session an alle verbundenen Geräte. */
  | { type: 'session.event'; sessionId: string; event: AgentEvent }
  /** Antwort auf `session.events.get`: chronologisch, älteste zuerst. */
  | { type: 'session.events'; requestId: string; sessionId: string; events: AgentEvent[] }
  /** Antwort auf `session.turns.get`: chronologisch, älteste zuerst. */
  | { type: 'session.turns'; requestId: string; sessionId: string; turns: TurnInfo[] }
  /**
   * Live-Push bei jedem Turn-Zustandswechsel (queued/running/terminal). Rein
   * additiv: ein Client, der die Turn-Ressource nicht kennt, ignoriert diesen
   * Typ und arbeitet wie bisher mit `session.status`/`session.event`.
   */
  | { type: 'turn.status'; sessionId: string; turn: TurnInfo }
  | { type: 'session.diff'; requestId: string; sessionId: string; diff: DiffEntry[] }
  /** `session` fehlt bei reinen Statuswechseln ohne weitere Änderung. */
  | { type: 'session.status'; sessionId: string; status: SessionStatus; session?: SessionInfo }
  | { type: 'session.models'; requestId: string; sessionId: string; models: ModelInfo[] }
  | { type: 'session.deleted'; requestId: string; sessionId: string }
  | { type: 'repo.list'; requestId: string; repos: RepoInfo[] }
  | { type: 'repo.added'; requestId: string; repo: RepoInfo }
  | { type: 'secret.list'; requestId: string; secrets: SecretInfo[] }
  | { type: 'secret.saved'; requestId: string; secret: SecretInfo }
  /**
   * Ergebnis einer `secret.validate`; trägt nie den Wert. `unverified: true`
   * heißt, dass es für diese Art keinen Live-Check gibt — `ok` ist dann true,
   * damit der Ablauf weitergeht, die UI muss es aber neutral darstellen und
   * nicht als bestätigten Key.
   */
  | {
      type: 'secret.validated';
      requestId: string;
      kind: SecretKind;
      ok: boolean;
      detail?: string;
      unverified?: boolean;
    }
  | { type: 'secret.deleted'; requestId: string; id: string }
  | { type: 'device.list'; requestId: string; devices: DeviceInfo[] }
  | { type: 'device.revoked'; requestId: string; deviceId: string }
  | { type: 'link.list'; requestId: string; links: LinkInfo[] }
  | { type: 'link.revoked'; requestId: string; linkId: string }
  | { type: 'server.stats'; requestId: string; stats: ServerStats };

/* ------------------------------------------------------------------ */
/* Pairing (REST vor der WS)                                           */
/* ------------------------------------------------------------------ */

/**
 * POST /api/pairing/confirm
 * Die App scannt einen QR-Code mit `<serverUrl>` und einem einmaligen Code aus
 * 12 Hex-Zeichen (erzeugt vom Betreiber über `npm run pair`, TTL 10 min, nach
 * 5 Fehlversuchen ungültig). Der Endpunkt ist ratenbegrenzt (IP + global).
 */
export interface PairingConfirmBody {
  code: string;
  deviceName: string;
}

export interface PairingConfirmResponse {
  ok: true;
  deviceId: string;
  /** Langlebiges Gerätetoken; landet im Keystore-gestützten Speicher der App. */
  deviceToken: string;
}

/* ------------------------------------------------------------------ */
/* FCM-Push                                                            */
/* ------------------------------------------------------------------ */

export interface FcmPushPayload {
  sessionId: string;
  eventType: 'permission.request' | 'turn.completed' | 'turn.failed' | 'session.status';
  title: string;
  body: string;
  /**
   * Nur bei `permission.request` gesetzt: erlaubt die Antwort direkt aus der
   * Benachrichtigung (Erlauben/Ablehnen), ohne die Session vorher zu öffnen —
   * `session.permission` braucht die Id, um die richtige Freigabe zu treffen.
   */
  permissionId?: string;
}

/* ------------------------------------------------------------------ */
/* Event-Sequenzierung + Replay (Broadcaster des Runners)              */
/*                                                                     */
/* Der Runner-SSE-Strom hat in v0 bei jeder Reconnect-Lücke Events     */
/* verloren, weil nichts gepuffert war und keine Ids mitliefen. Diese  */
/* Implementierung gibt jedem Event eine monotone `seq`, hält einen    */
/* Ringpuffer der jüngsten Vergangenheit und beherrscht                */
/* Last-Event-ID-Replay: der Orchestrator verbindet sich mit der       */
/* zuletzt gesehenen Id neu, der Runner schickt nach, was noch im Ring */
/* liegt. Bleibt pur und ohne node-Import (die Senke ist ein           */
/* struktureller Typ), weil die Datei im Container als TS-Quelle lädt. */
/* ------------------------------------------------------------------ */

/** Wie viele Events der Runner für den Last-Event-ID-Replay vorhält. */
export const EVENT_RING_CAPACITY = 1000;

/**
 * Minimale SSE-Senke, in die der Broadcaster schreibt. Nodes `ServerResponse`
 * erfüllt sie strukturell, deshalb hängt hier nichts an `node:http`.
 * `writableEnded` lässt den Broadcaster einen Client wegwerfen, dessen Socket
 * schon zu ist.
 */
export interface SseSink {
  write(chunk: string): unknown;
  readonly writableEnded?: boolean;
}

/**
 * Einen `Last-Event-ID`-Header (SSE-Reconnect) in eine Sequenznummer wandeln.
 * Node schreibt Headernamen klein und liefert bei doppeltem Header ein Array;
 * alles, was keine nicht-negative Ganzzahl ist, bedeutet „kein Cursor" (frische
 * Verbindung) und spielt nichts nach.
 */
export function parseLastEventId(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Fan-out-Broadcaster für den normalisierten AgentEvent-SSE-Strom, mit
 * Sequenz-Ids je Event und Replay-Ring.
 *
 * `publish` prägt die nächste Id (und ein `ts`) ins Event, formatiert den
 * SSE-Frame mit `id:`-Zeile, puffert ihn und schreibt ihn an jeden lebenden
 * Client. `add` registriert einen Client; bei einem Reconnect reicht der
 * Aufrufer dessen Last-Event-ID mit, und jeder gepufferte Frame danach wird
 * zuerst nachgespielt — eine Verbindungslücke verliert also kein Event, das
 * noch im Ring liegt.
 *
 * `ping`-Keepalives sind bewusst unsequenziert: sie gehen live raus, um den
 * Socket warm zu halten, verbrauchen aber weder Id noch Ringplatz. Sonst
 * könnten die Pings einer lange leerlaufenden Session genau die echten Events
 * (ein verpasstes `turn.completed`) aus dem Ring drängen, die ein
 * wiederverbindender Client noch braucht.
 */
export class SequencedSseBroadcaster {
  private seq = 0;
  private readonly ring: { id: number; frame: string }[] = [];
  private readonly clients = new Set<SseSink>();
  private readonly capacity: number;

  constructor(capacity: number = EVENT_RING_CAPACITY) {
    this.capacity = capacity > 0 ? capacity : EVENT_RING_CAPACITY;
  }

  /**
   * Event prägen, puffern und verteilen. Liefert die vergebene Id, oder
   * `undefined` für ein `ping` (das gesendet, aber nie sequenziert wird).
   */
  publish(event: AgentEvent): number | undefined {
    if (event.type === 'ping') {
      this.fanout(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
      return undefined;
    }
    const id = ++this.seq;
    const stamped: AgentEvent = { ...event, seq: id, ts: event.ts ?? Date.now() };
    const frame = `id: ${id}\nevent: agent\ndata: ${JSON.stringify(stamped)}\n\n`;
    this.ring.push({ id, frame });
    if (this.ring.length > this.capacity) this.ring.shift();
    this.fanout(frame);
    return id;
  }

  /**
   * SSE-Client registrieren. `lastEventId` (aus dessen Last-Event-ID-Header bei
   * einem Reconnect) spielt jeden noch gepufferten Frame danach nach, bevor der
   * Client wieder Live-Frames bekommt.
   */
  add(sink: SseSink, lastEventId?: number): void {
    if (lastEventId !== undefined) {
      for (const entry of this.ring) if (entry.id > lastEventId) this.writeTo(sink, entry.frame);
    }
    this.clients.add(sink);
  }

  remove(sink: SseSink): void {
    this.clients.delete(sink);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Id des zuletzt sequenzierten Events (0, solange nichts veröffentlicht wurde). */
  get lastId(): number {
    return this.seq;
  }

  private fanout(frame: string): void {
    for (const sink of this.clients) this.writeTo(sink, frame);
  }

  private writeTo(sink: SseSink, frame: string): void {
    if (sink.writableEnded === true) {
      this.clients.delete(sink);
      return;
    }
    try {
      sink.write(frame);
    } catch {
      this.clients.delete(sink);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Egress-Proxy-Verdrahtung (beim Prozessstart des Runners)            */
/*                                                                     */
/* Unter der Policy 'allowlist' hängt ein Session-Container in einem   */
/* internen Docker-Netz ohne Route nach draußen: der einzige Weg ins   */
/* Internet ist der Egress-Proxy des Orchestrators, hereingereicht als */
/* HTTP_PROXY / HTTPS_PROXY / NO_PROXY (server/src/docker.ts).         */
/* Node beachtet keine dieser Variablen von sich aus — weder fetch     */
/* (undici) noch http.request — es hing also am HTTP-Client des SDK,   */
/* ob ein Provider-Aufruf überhaupt beim Proxy ankam. Clients, die die */
/* Variablen ignorieren, starben mit einem nackten "Connection error." */
/* und hinterließen keine Zeile im Proxy-Log, weil nie etwas ankam.    */
/* Den *globalen* Dispatcher von undici zu setzen behebt das für den   */
/* ganzen Prozess auf einen Schlag, mitgebrachte undici-Kopien eines   */
/* SDK eingeschlossen: der globale Dispatcher liegt auf einem          */
/* globalThis-Symbol, das jede Kopie liest. (PR #57)                   */
/* ------------------------------------------------------------------ */

/**
 * Die Proxy-URL, über die die Umgebung ausgehenden Verkehr haben will, oder
 * `undefined`, wenn die Session ohne Proxy gestartet wurde (Policy 'open':
 * direktes Internet). https schlägt http, weil jeder Provider-Endpunkt https
 * ist; beide Schreibweisen werden gelesen — konventionell sind die Variablen
 * klein geschrieben, der Orchestrator injiziert die große Form.
 */
export function envProxyUrl(env: Record<string, string | undefined>): string | undefined {
  const raw = env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY;
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Proxy-URL ohne ihren Userinfo-Teil. Die injizierte URL trägt das
 * Shim-Token der Session als Basic-Credentials für den Egress-Proxy — nur
 * diese Form darf geloggt werden.
 */
export function redactProxyUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}

/**
 * Jeden ausgehenden HTTP(S)-Aufruf dieses Prozesses auf den Egress-Proxy
 * festnageln — aber nur, wenn einer konfiguriert ist. Ohne Proxy-Variablen hat
 * der Container direkten Internetzugang und muss ihn behalten: ein Dispatcher
 * würde dort jeden Aufruf auf einen Proxy richten, den es nicht gibt.
 *
 * `install` soll undicis globalen Dispatcher auf einen `EnvHttpProxyAgent`
 * setzen, der HTTP_PROXY/HTTPS_PROXY/NO_PROXY selbst liest — damit geht
 * Loopback-Verkehr, der in NO_PROXY steht (die eigene HTTP-Oberfläche des
 * Runners), weiterhin direkt. Es ist ein Callback, weil dieses Paket im
 * Runner-Image als TypeScript-Quelle aus /app/packages/protocol geladen wird,
 * wo ein blankes `import 'undici'` gegen die (nicht vorhandenen) node_modules
 * dieses Pakets aufgelöst würde statt gegen die des Runners.
 *
 * Liefert die redigierte Proxy-URL, die jetzt gilt, oder `undefined`, wenn
 * nichts installiert wurde.
 */
export function installEnvProxyDispatcher(
  env: Record<string, string | undefined>,
  install: () => void,
): string | undefined {
  const proxy = envProxyUrl(env);
  if (proxy === undefined) return undefined;
  install();
  return redactProxyUrl(proxy);
}
