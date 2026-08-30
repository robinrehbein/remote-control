/**
 * Kernlogik des Link-Agenten: ausgehende WS-Verbindung zum Orchestrator
 * (Reconnect mit Backoff, Heartbeat, Event-Queue-Obergrenze), Proxy von
 * `agent.command` auf die HTTP-Schnittstelle des eingebetteten pi-Runners,
 * Weiterleitung von dessen SSE-Strom als `agent.event`.
 *
 * Bewusst aus index.ts ausgelagert und ohne jeden `process.exit`-Aufruf: so
 * kann der Smoke-Test diese Funktion direkt (im selben Prozess, kein
 * Kindprozess) gegen einen Fake-Orchestrator UND einen Fake-Runner treiben,
 * statt process.exit()s des echten CLI-Einstiegspunkts abfangen zu müssen.
 * `index.ts` bindet `startRunner` an den echten pi-Runner (siehe
 * runner-embed.ts) und entscheidet selbst, wann der Prozess wirklich endet
 * (`onTerminal`).
 */
import WebSocket from 'ws';
import type { AgentEvent, AgentMode, LinkSessionStatus, ServerMessage } from '@pocketagent/protocol';
import { WS_CLOSE_UNAUTHORIZED, isTerminalLinkCloseCode } from '@pocketagent/protocol';
import { resolveWsUrl } from './ws-url.js';
import { INITIAL_LINK_SESSION_STATUS, nextLinkSessionStatus } from './link-status.js';

/** Was der Link-Agent von einer laufenden Runner-Instanz braucht - egal ob
 * echter pi-Runner (runner-embed.ts) oder Fake-Runner (Smoke-Test). */
export interface EmbeddedRunner {
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface LinkAgentIntervals {
  /** Plain-Keepalive (`agent.ping`) und Stille-Erkennung, siehe silentTimeoutMs. */
  pingMs: number;
  /** Voll-Zustands-Snapshot (Kilo P2), siehe LinkSessionState. */
  heartbeatMs: number;
  /** Kein Server-Lebenszeichen länger als das -> WS wird hart getrennt (reconnect greift). */
  silentTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** Pause zwischen zwei Startversuchen, wenn `startRunner()` fehlschlägt. */
  runnerStartRetryMs: number;
}

export const DEFAULT_LINK_AGENT_INTERVALS: LinkAgentIntervals = {
  pingMs: 20_000,
  heartbeatMs: 10_000,
  silentTimeoutMs: 90_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  runnerStartRetryMs: 5_000,
};

/** Cap auf die Event-Queue, damit ein langer Orchestrator-Ausfall (oder ein
 * kaputter Token in einer Schleife) sie nicht unbegrenzt wachsen lässt. */
const MAX_QUEUED_EVENTS = 1000;

export interface LinkAgentOptions {
  server: string;
  token: string;
  name: string;
  mode: AgentMode;
  workDir: string;
  branch?: string;
  /**
   * Startet die Runner-Instanz, gegen die dieser Link-Agent arbeitet.
   * Produktion: `embedPiRunner` (runner-embed.ts, echter pi-Runner
   * in-process). Smoke-Test: ein Fake-Runner (buildApp + FakeRunner aus
   * runner/smoke/fake.ts), damit ohne Provider-Keys getestet werden kann.
   */
  startRunner: () => Promise<EmbeddedRunner>;
  intervals?: Partial<LinkAgentIntervals>;
  log?: (message: string) => void;
  /**
   * Feuert, wenn die Verbindung endgültig endet: ein terminaler Close-Code
   * (siehe isTerminalLinkCloseCode) oder `agent.bye` vom Server. `code` ist
   * der empfohlene Prozess-Exitcode. Die Produktion beendet hier den
   * Prozess (mit kurzer Gnadenfrist für den letzten WS-Frame); der
   * Smoke-Test hängt nur einen Assert daran.
   */
  onTerminal?: (code: number) => void;
}

export interface LinkAgentHandle {
  /** Sauberes Beenden von außen (App-Stop, SIGINT/SIGTERM): schließt WS und eingebetteten Runner. */
  shutdown(): Promise<void>;
}

export function startLinkAgent(opts: LinkAgentOptions): LinkAgentHandle {
  const intervals: LinkAgentIntervals = { ...DEFAULT_LINK_AGENT_INTERVALS, ...opts.intervals };
  const log = opts.log ?? ((m: string) => console.log(`[link] ${m}`));

  let runner: EmbeddedRunner | null = null;
  let runnerStarting = false;
  /** Steuert den Abbruch der aktuell offenen Runner-SSE-Verbindung, siehe cleanup(). */
  let eventStreamAbort: AbortController | null = null;
  let ws: WebSocket | null = null;
  let sessionId: string | null = null;
  let lastServerMsgAt = Date.now();
  let linkSessionStatus: LinkSessionStatus = INITIAL_LINK_SESSION_STATUS;
  let stopped = false;
  let backoff = intervals.reconnectBaseMs;

  const eventQueue: AgentEvent[] = [];
  let droppedEventCount = 0;

  function queueEvent(ev: AgentEvent): void {
    // Pings sind reine Herzschläge - bis ein verzögerter Reconnect sie
    // ausliefern würde, bedeuten sie nichts mehr, also kein Queue-Budget dafür.
    if (ev.type === 'ping') return;
    eventQueue.push(ev);
    if (eventQueue.length > MAX_QUEUED_EVENTS) {
      // Bei vollem Puffer zuerst ein `message.delta` opfern (Streaming-Token, das
      // die App durch das folgende `message.completed` ohnehin komplett ersetzt),
      // statt blind das älteste Event zu verwerfen: sonst fiele u. U. ein
      // `turn.completed`/`permission.request`/`tool.result` weg, dessen Verlust
      // die Timeline dauerhaft verfälscht. Nur wenn gar kein Delta im Puffer ist,
      // fällt das älteste Event (dann ist alles Verbliebene gleich wichtig).
      const deltaIdx = eventQueue.findIndex((e) => e.type === 'message.delta');
      eventQueue.splice(deltaIdx >= 0 ? deltaIdx : 0, 1);
      droppedEventCount++;
      if (droppedEventCount === 1 || droppedEventCount % 100 === 0) {
        log(
          `event queue at cap (${MAX_QUEUED_EVENTS}) - dropped ${droppedEventCount} event(s) so far, message.delta first (no orchestrator connection)`,
        );
      }
    }
  }

  function send(m: unknown): void {
    try {
      ws?.send(JSON.stringify(m));
    } catch {
      /* closed */
    }
  }

  function flushQueuedEvents(): void {
    while (eventQueue.length > 0) {
      const ev = eventQueue.shift();
      if (ev && sessionId) send({ type: 'agent.event', sessionId, event: ev });
    }
  }

  // TODO(event-loss-window): Bei einem langen Orchestrator-Ausfall kann die
  // gedeckelte Queue (MAX_QUEUED_EVENTS) überlaufen und Events endgültig
  // verwerfen - die Timeline drüben hätte dann eine Lücke, die kein Reconnect
  // schließt. Ein lückenloser Weg wäre: der Orchestrator trägt in `agent.ready`
  // die zuletzt für diese Session persistierte (server-kanonische) seq, und der
  // Link-Agent liest seinen eingebetteten Runner-SSE-Strom ab da per
  // Last-Event-ID nach, statt aus einem flüchtigen In-Memory-Puffer zu liefern.
  // Das setzt die in Tier 2 gebaute Server-Kanonik voraus (die steht jetzt), ist
  // aber eine Protokoll-Erweiterung (agent.ready + LinkHello-Resume) mit eigenem
  // Testbedarf und daher bewusst noch nicht umgesetzt. Bis dahin mildert der
  // message.delta-zuerst-Drop oben den Verlust ab.



  /** Liefert die laufende Runner-Instanz, wartet auf einen bereits laufenden Start statt einen zweiten anzustoßen. */
  async function ensureRunner(): Promise<EmbeddedRunner> {
    if (runner) return runner;
    if (!runnerStarting) return startRunnerWithRetry();
    while (runnerStarting) await new Promise((r) => setTimeout(r, 50));
    if (runner) return runner;
    return startRunnerWithRetry();
  }

  async function startRunnerWithRetry(): Promise<EmbeddedRunner> {
    runnerStarting = true;
    try {
      for (;;) {
        if (stopped) throw new Error('link agent stopped');
        try {
          const started = await opts.startRunner();
          runner = started;
          log(`runner ready on 127.0.0.1:${started.port}`);
          return started;
        } catch (e) {
          console.error(`[link] runner failed to start: ${e instanceof Error ? e.message : String(e)}`);
          await new Promise((r) => setTimeout(r, intervals.runnerStartRetryMs));
        }
      }
    } finally {
      runnerStarting = false;
    }
  }

  async function proxyCommand(callId: string, path: string, method: 'GET' | 'POST', body?: unknown): Promise<void> {
    let current: EmbeddedRunner;
    try {
      current = await ensureRunner();
    } catch {
      send({ type: 'agent.response', callId, status: 503, body: { ok: false, error: 'local runner not ready' } });
      return;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${current.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${current.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        parsed = { ok: false, error: text.slice(0, 500) };
      }
      send({ type: 'agent.response', callId, status: res.status, body: parsed });
    } catch (e) {
      send({
        type: 'agent.response',
        callId,
        status: 502,
        body: { ok: false, error: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  function startEventStream(): void {
    void (async () => {
      for (;;) {
        if (stopped) return;
        let current: EmbeddedRunner;
        try {
          current = await ensureRunner();
        } catch {
          return;
        }
        try {
          const base = `http://127.0.0.1:${current.port}`;
          // Der Fastify-Server hinter dem eingebetteten Runner schließt
          // per Vorgabe erst, wenn jede aktive Verbindung geendet hat - eine
          // dauerhaft offene SSE-Antwort wäre also nie "fertig" und
          // `runner.close()` in cleanup() unten hinge auf immer. Der
          // AbortController hier gibt cleanup() einen Griff, um genau diese
          // Verbindung von unserer Seite aus zu beenden, bevor der Runner
          // geschlossen wird.
          eventStreamAbort = new AbortController();
          const res = await fetch(`${base}/events`, {
            headers: { authorization: `Bearer ${current.token}`, accept: 'text/event-stream' },
            signal: eventStreamAbort.signal,
          });
          if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            // Diese SSE-Verbindung sofort verlassen, sobald der Runner unter
            // ihr ausgetauscht wurde, statt weiter von der alten Instanz zu
            // lesen - der äußere Loop verbindet sich dann gegen den neuen
            // Port neu. Heute wird die Instanz nach dem Start nie
            // ausgetauscht, aber die Prüfung bleibt der Kontrakt für den
            // Fall, dass startRunner() künftig doch einmal neu anläuft.
            if (stopped || runner !== current) break;
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx = buf.indexOf('\n\n');
            while (idx >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                try {
                  const ev = JSON.parse(line.slice(5).trim()) as AgentEvent;
                  // Spiegelt lokale Wahrheit unabhängig von der
                  // Orchestrator-Konnektivität - der nächste Heartbeat
                  // (sobald wieder verbunden) meldet, was der Runner
                  // tatsächlich getan hat, während die Leitung tot war.
                  linkSessionStatus = nextLinkSessionStatus(linkSessionStatus, ev);
                  if (sessionId && !stopped) send({ type: 'agent.event', sessionId, event: ev });
                  else if (!stopped) queueEvent(ev);
                } catch {
                  /* malformed */
                }
              }
              idx = buf.indexOf('\n\n');
            }
          }
        } catch {
          /* reconnect */
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
  }

  function dial(): void {
    if (stopped) return;
    // Die Stille-Uhr für den frischen Socket neu stellen: stünde hier noch der
    // Zeitpunkt der letzten Nachricht der ALTEN (gerade getrennten) Verbindung,
    // könnte der pingTimer den eben geöffneten Socket sofort wieder terminieren,
    // bevor der Server auch nur antworten konnte - eine Reconnect-Schleife, die
    // nie zur Ruhe kommt.
    lastServerMsgAt = Date.now();
    const url = resolveWsUrl(opts.server);
    log(`connecting ${url}`);
    const sock = new WebSocket(url);
    ws = sock;
    sock.on('open', () => {
      send({
        type: 'agent.hello',
        token: opts.token,
        name: opts.name,
        mode: opts.mode,
        branch: opts.branch || undefined,
        workDir: opts.workDir,
      });
    });
    sock.on('message', (raw) => {
      lastServerMsgAt = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(raw)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'agent.ready') {
        sessionId = msg.sessionId;
        backoff = intervals.reconnectBaseMs;
        log(`registered as session ${sessionId}`);
        flushQueuedEvents();
        return;
      }
      if (msg.type === 'agent.command') {
        void proxyCommand(msg.callId, msg.path, msg.method, msg.body);
        return;
      }
      if (msg.type === 'agent.bye') {
        log('server closed the session - shutting down');
        void terminalShutdown(0);
      }
    });
    sock.on('close', (code, reason) => {
      if (stopped) return;
      sessionId = null;
      // Terminale Close-Codes (falsches/widerrufenes Token, oder ein anderer
      // Link-Agent hält den Platz dieses Tokens bereits): ein Reconnect kann
      // nicht gelingen - dieselben Credentials/Registrierung führten zur
      // Ablehnung - und bei einem Replace insbesondere würde ein Reconnect
      // drüben genau dasselbe Ersetzen erneut auslösen (oder beide Seiten
      // flattern ewig). Die Schleife hier endgültig beenden statt mit
      // Backoff weiterzuprobieren, siehe isTerminalLinkCloseCode.
      if (isTerminalLinkCloseCode(code)) {
        const why =
          code === WS_CLOSE_UNAUTHORIZED
            ? 'the orchestrator rejected this token (invalid or revoked) - fix PA_TOKEN, then restart this process'
            : 'another link agent is already registered with this PA_TOKEN - stop it or give this checkout its own token, then restart this process';
        console.error(`[link] connection closed permanently (code=${code} reason=${String(reason) || '-'}): ${why}`);
        void terminalShutdown(1);
        return;
      }
      log(`connection lost - retrying in ${Math.round(backoff / 1000)}s`);
      setTimeout(() => dial(), backoff);
      backoff = Math.min(backoff * 2, intervals.reconnectMaxMs);
    });
    sock.on('error', () => {
      /* close handler retries */
    });
  }

  const pingTimer = setInterval(() => {
    send({ type: 'agent.ping', ts: Date.now() });
    if (Date.now() - lastServerMsgAt > intervals.silentTimeoutMs) {
      log(`server silent >${Math.round(intervals.silentTimeoutMs / 1000)}s - forcing reconnect`);
      ws?.terminate();
    }
  }, intervals.pingMs);

  /**
   * Voll-Zustands-Heartbeat (Kilo P2), eigene Kadenz gegenüber dem reinen
   * agent.ping oben: jede Session, die dieser Link-Agent führt, mit ihrem
   * aktuellen Status, damit der Orchestrator ohne Abhängigkeit von jedem
   * einzelnen agent.event rekonziliieren kann. Heute immer höchstens die eine
   * in `agent.ready` gebundene Session.
   *
   * Erst NACH der Registrierung senden (sessionId gesetzt): Der Heartbeat ist ein
   * VOLL-Zustand - ein leeres `sessions`-Array bedeutet dem Orchestrator "diese
   * Session ist weg" und setzt sie auf 'stopped'. Zwischen einem Reconnect und
   * dem nächsten `agent.ready` ist sessionId aber kurz null; ein in diesem Fenster
   * gesendeter leerer Heartbeat würde die gerade wieder verbundene Session
   * fälschlich auf 'stopped' flappen lassen. Also in diesem Fenster gar nichts
   * senden - der Server behält den letzten bekannten Zustand.
   */
  const heartbeatTimer = setInterval(() => {
    if (!sessionId) return;
    send({
      type: 'agent.heartbeat',
      sessions: [{ sessionId, status: linkSessionStatus }],
    });
  }, intervals.heartbeatMs);

  async function cleanup(): Promise<void> {
    stopped = true;
    clearInterval(pingTimer);
    clearInterval(heartbeatTimer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    // Erst die eigene SSE-Leseverbindung zum Runner beenden, dann erst den
    // Runner selbst schließen - sonst wartet dessen Fastify-Server auf das
    // Ende einer Verbindung, die nur wir offenhalten (siehe startEventStream()).
    eventStreamAbort?.abort();
    if (runner) {
      try {
        await runner.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Server-seitig ausgelöstes Ende (terminaler Close-Code, agent.bye): räumt auf und meldet es nach außen. */
  async function terminalShutdown(code: number): Promise<void> {
    if (stopped) return;
    await cleanup();
    opts.onTerminal?.(code);
  }

  void (async () => {
    // Wie v1: erst den Runner betriebsbereit haben, dann erst beim
    // Orchestrator anmelden - eine Anmeldung ohne lauffähigen Runner dahinter
    // wäre eine Session, die jeden agent.command sofort mit 503 beantwortet.
    await startRunnerWithRetry();
    if (stopped) return;
    startEventStream();
    dial();
  })();

  return {
    async shutdown() {
      if (stopped) return;
      await cleanup();
    },
  };
}
