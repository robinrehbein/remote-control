/**
 * Tests für die logiktragenden Teile des Protokolls: den sequenzierten
 * SSE-Broadcaster (Replay-Verhalten ist der Kern der Reconnect-Garantie), die
 * Egress-Proxy-Helfer (falsch redigiert = Token im Log) und die pi-Tabellen
 * (Server, Runner und App leiten daraus Env-Namen und Modus-Verhalten ab).
 *
 * Lauf: `npm test -w packages/protocol` bzw. `node --test test/*.test.ts` im
 * Paketverzeichnis. Node ≥ 22.18 strippt die Typen selbst; getypt wird hier
 * bewusst nur sparsam, denn `tsc -p packages/protocol` prüft nur `src/`
 * (Tests bräuchten sonst @types/node, und das Paket bleibt abhängigkeitsfrei).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  EVENT_RING_CAPACITY,
  LINK_PROTOCOL_VERSION,
  PI_DEFAULT_PROVIDER,
  PI_MODE_SEMANTICS,
  PI_PROVIDERS,
  PI_PROVIDER_ENV,
  PI_PROVIDER_IDS,
  SECRET_KINDS,
  SequencedSseBroadcaster,
  WS_CLOSE_REPLACED,
  WS_CLOSE_TOO_MANY_CONNECTIONS,
  WS_CLOSE_UNAUTHORIZED,
  autoPushForMode,
  envProxyUrl,
  installEnvProxyDispatcher,
  isAgentMode,
  isPiProvider,
  isReasoningEffort,
  isTerminalLinkCloseCode,
  parseLastEventId,
  piProviderEnvVar,
  redactProxyUrl,
} from '../src/index.ts';

/* ------------------------------------------------------------------ */
/* Test-Senke: sammelt Frames, kann Socket-Ende und Wurf simulieren     */
/* ------------------------------------------------------------------ */

class FakeSink {
  frames = [];
  writableEnded = false;
  throwOnWrite = false;

  write(chunk) {
    if (this.throwOnWrite) throw new Error('socket gone');
    this.frames.push(chunk);
    return true;
  }

  /** Die `data:`-Nutzlasten der empfangenen Frames als Objekte. */
  events() {
    return this.frames.map((f) => JSON.parse(/^data: (.*)$/m.exec(f)[1]));
  }

  /** Die `id:`-Zeilen (undefined für unsequenzierte Frames). */
  ids() {
    return this.frames.map((f) => {
      const m = /^id: (\d+)$/m.exec(f);
      return m === null ? undefined : Number(m[1]);
    });
  }
}

/* ------------------------------------------------------------------ */
/* SequencedSseBroadcaster                                             */
/* ------------------------------------------------------------------ */

test('publish vergibt monotone seq und schreibt id-Zeile plus SSE-Rahmen', () => {
  const b = new SequencedSseBroadcaster();
  const sink = new FakeSink();
  b.add(sink);

  assert.equal(b.lastId, 0);
  assert.equal(b.publish({ type: 'notice', message: 'eins' }), 1);
  assert.equal(b.publish({ type: 'turn.completed' }), 2);
  assert.equal(b.lastId, 2);

  assert.deepEqual(sink.ids(), [1, 2]);
  assert.match(sink.frames[0], /^id: 1\nevent: agent\ndata: \{.*\}\n\n$/s);
  const [first, second] = sink.events();
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(typeof first.ts, 'number');
});

test('publish überschreibt ein bereits gesetztes ts nicht', () => {
  const b = new SequencedSseBroadcaster();
  const sink = new FakeSink();
  b.add(sink);
  b.publish({ type: 'notice', message: 'alt', ts: 42 });
  assert.equal(sink.events()[0].ts, 42);
});

test('ping wird gesendet, aber nicht sequenziert und belegt keinen Ringplatz', () => {
  const b = new SequencedSseBroadcaster(2);
  const live = new FakeSink();
  b.add(live);

  b.publish({ type: 'notice', message: 'wichtig' });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(b.publish({ type: 'ping', ts: i }), undefined);
  }
  assert.equal(b.lastId, 1, 'pings verbrauchen keine Sequenznummer');
  assert.equal(live.frames.length, 11, 'pings gehen trotzdem live raus');
  assert.equal(live.ids()[1], undefined, 'ping-Frame trägt keine id-Zeile');

  // Der Reconnect bekommt das echte Event, obwohl 10 Pings dazwischen lagen.
  const reconnect = new FakeSink();
  b.add(reconnect, 0);
  assert.deepEqual(reconnect.events().map((e) => e.message), ['wichtig']);
});

test('add mit lastEventId spielt nur neuere Frames nach', () => {
  const b = new SequencedSseBroadcaster();
  for (const message of ['a', 'b', 'c']) b.publish({ type: 'notice', message });

  const fresh = new FakeSink();
  b.add(fresh);
  assert.deepEqual(fresh.frames, [], 'ohne Cursor wird nichts nachgespielt');

  const resumed = new FakeSink();
  b.add(resumed, 2);
  assert.deepEqual(resumed.events().map((e) => e.message), ['c']);

  const fromZero = new FakeSink();
  b.add(fromZero, 0);
  assert.deepEqual(fromZero.events().map((e) => e.message), ['a', 'b', 'c']);

  const ahead = new FakeSink();
  b.add(ahead, 99);
  assert.deepEqual(ahead.frames, [], 'eine seq aus der Zukunft spielt nichts nach');
});

test('der Ring verdrängt die ältesten Frames und der Replay liefert den Rest', () => {
  const b = new SequencedSseBroadcaster(3);
  for (const message of ['a', 'b', 'c', 'd', 'e']) b.publish({ type: 'notice', message });

  const resumed = new FakeSink();
  b.add(resumed, 1); // 'a' ist längst rausgefallen
  assert.deepEqual(resumed.events().map((e) => e.message), ['c', 'd', 'e']);
  assert.deepEqual(resumed.events().map((e) => e.seq), [3, 4, 5]);
});

test('eine Kapazität <= 0 fällt auf die Vorgabe zurück', () => {
  const b = new SequencedSseBroadcaster(0);
  for (let i = 0; i < EVENT_RING_CAPACITY + 5; i += 1) b.publish({ type: 'notice', message: String(i) });
  const resumed = new FakeSink();
  b.add(resumed, 0);
  assert.equal(resumed.frames.length, EVENT_RING_CAPACITY);
});

test('tote und werfende Senken fliegen beim Schreiben raus', () => {
  const b = new SequencedSseBroadcaster();
  const ended = new FakeSink();
  const throwing = new FakeSink();
  const ok = new FakeSink();
  b.add(ended);
  b.add(throwing);
  b.add(ok);
  assert.equal(b.clientCount, 3);

  ended.writableEnded = true;
  throwing.throwOnWrite = true;
  b.publish({ type: 'notice', message: 'x' });

  assert.equal(b.clientCount, 1);
  assert.equal(ended.frames.length, 0);
  assert.equal(ok.frames.length, 1);
});

test('remove nimmt einen Client aus dem Fan-out', () => {
  const b = new SequencedSseBroadcaster();
  const sink = new FakeSink();
  b.add(sink);
  b.remove(sink);
  b.remove(sink); // idempotent
  b.publish({ type: 'notice', message: 'x' });
  assert.equal(b.clientCount, 0);
  assert.equal(sink.frames.length, 0);
});

test('Reconnect-Runde: id-Zeile des letzten Frames taugt als Last-Event-ID', () => {
  const b = new SequencedSseBroadcaster();
  const first = new FakeSink();
  b.add(first);
  b.publish({ type: 'notice', message: 'a' });
  b.publish({ type: 'notice', message: 'b' });
  b.remove(first);

  const lastLine = /^id: (\d+)$/m.exec(first.frames[first.frames.length - 1])[1];
  b.publish({ type: 'notice', message: 'c' });

  const second = new FakeSink();
  b.add(second, parseLastEventId(lastLine));
  assert.deepEqual(second.events().map((e) => e.message), ['c']);
});

/* ------------------------------------------------------------------ */
/* parseLastEventId                                                    */
/* ------------------------------------------------------------------ */

test('parseLastEventId akzeptiert nur nicht-negative Ganzzahlen', () => {
  assert.equal(parseLastEventId('7'), 7);
  assert.equal(parseLastEventId(' 7 '), 7);
  assert.equal(parseLastEventId('0'), 0);
  assert.equal(parseLastEventId(['5', '9']), 5, 'doppelter Header: der erste zählt');
  assert.equal(parseLastEventId(undefined), undefined);
  assert.equal(parseLastEventId(''), undefined);
  assert.equal(parseLastEventId('abc'), undefined);
  assert.equal(parseLastEventId('-3'), undefined);
  assert.equal(parseLastEventId([]), undefined);
});

/* ------------------------------------------------------------------ */
/* Egress-Proxy-Helfer (#57)                                           */
/* ------------------------------------------------------------------ */

test('envProxyUrl bevorzugt https und liest beide Schreibweisen', () => {
  assert.equal(envProxyUrl({ https_proxy: 'http://a', HTTPS_PROXY: 'http://b' }), 'http://a');
  assert.equal(envProxyUrl({ HTTPS_PROXY: 'http://b', http_proxy: 'http://c' }), 'http://b');
  assert.equal(envProxyUrl({ http_proxy: 'http://c', HTTP_PROXY: 'http://d' }), 'http://c');
  assert.equal(envProxyUrl({ HTTP_PROXY: 'http://d' }), 'http://d');
  assert.equal(envProxyUrl({ HTTPS_PROXY: '  http://e  ' }), 'http://e');
});

test('envProxyUrl behandelt fehlende und leere Werte als „kein Proxy"', () => {
  assert.equal(envProxyUrl({}), undefined);
  assert.equal(envProxyUrl({ HTTPS_PROXY: '' }), undefined);
  assert.equal(envProxyUrl({ HTTPS_PROXY: '   ' }), undefined);
  assert.equal(envProxyUrl({ HTTPS_PROXY: undefined, HTTP_PROXY: 'http://d' }), 'http://d');
});

test('redactProxyUrl entfernt die Credentials, sonst nichts', () => {
  assert.equal(redactProxyUrl('http://sess:tok3n@proxy:3128'), 'http://***@proxy:3128');
  assert.equal(redactProxyUrl('http://tok3n@proxy:3128'), 'http://***@proxy:3128');
  assert.equal(redactProxyUrl('http://proxy:3128'), 'http://proxy:3128');
  assert.equal(
    redactProxyUrl('http://proxy:3128/pfad@mit-at'),
    'http://proxy:3128/pfad@mit-at',
    'ein @ hinter dem ersten / ist kein Userinfo',
  );
  assert.ok(!redactProxyUrl('http://sess:tok3n@proxy:3128').includes('tok3n'));
});

test('installEnvProxyDispatcher installiert nur mit Proxy und liefert redigiert zurück', () => {
  let calls = 0;
  const install = () => {
    calls += 1;
  };

  assert.equal(installEnvProxyDispatcher({}, install), undefined);
  assert.equal(calls, 0, 'ohne Proxy-Variablen bleibt der direkte Weg unangetastet');

  const redacted = installEnvProxyDispatcher({ HTTPS_PROXY: 'http://sess:tok3n@proxy:3128' }, install);
  assert.equal(redacted, 'http://***@proxy:3128');
  assert.equal(calls, 1);
});

/* ------------------------------------------------------------------ */
/* pi-Tabellen                                                         */
/* ------------------------------------------------------------------ */

test('PI_PROVIDERS und PI_PROVIDER_ENV beschreiben exakt dieselben Provider', () => {
  assert.deepEqual([...PI_PROVIDER_IDS].sort(), Object.keys(PI_PROVIDER_ENV).sort());
  assert.deepEqual(PI_PROVIDERS.map((p) => p.id), [...PI_PROVIDER_IDS]);
  for (const p of PI_PROVIDERS) {
    assert.ok(p.name.length > 0, `${p.id} braucht einen Anzeigenamen`);
    assert.match(p.keyUrl, /^https:\/\//, `${p.id} braucht einen https-Key-Link`);
    assert.ok(p.hint.length > 0, `${p.id} braucht einen Hinweis`);
  }
  assert.ok(isPiProvider(PI_DEFAULT_PROVIDER));
});

test('moonshot und kimi teilen sich bewusst KIMI_API_KEY', () => {
  assert.equal(PI_PROVIDER_ENV.moonshot, 'KIMI_API_KEY');
  assert.equal(PI_PROVIDER_ENV.kimi, 'KIMI_API_KEY');
  assert.equal(PI_PROVIDER_ENV.openai, 'OPENAI_API_KEY');
  assert.equal(PI_PROVIDER_ENV.zai, 'ZAI_API_KEY');
  assert.equal(PI_PROVIDER_ENV.anthropic, 'ANTHROPIC_API_KEY');
  assert.equal(PI_PROVIDER_ENV.google, 'GEMINI_API_KEY');
});

test('piProviderEnvVar liefert nur für echte Provider etwas', () => {
  assert.equal(piProviderEnvVar('zai'), 'ZAI_API_KEY');
  assert.equal(piProviderEnvVar('gibtsnicht'), undefined);
  assert.equal(piProviderEnvVar('ZAI'), undefined, 'Ids sind kleingeschrieben');
  assert.equal(piProviderEnvVar('toString'), undefined, 'keine Prototyp-Treffer');
  assert.equal(isPiProvider('constructor'), false);
});

test('SECRET_KINDS deckt alle Provider plus github ab', () => {
  for (const id of PI_PROVIDER_IDS) assert.ok(SECRET_KINDS.includes(id), `${id} fehlt`);
  assert.ok(SECRET_KINDS.includes('github'));
  assert.equal(SECRET_KINDS.length, PI_PROVIDER_IDS.length + 1);
});

test('die Modus-Matrix ist vollständig und nur yolo pusht automatisch', () => {
  assert.deepEqual(Object.keys(PI_MODE_SEMANTICS).sort(), [...AGENT_MODES].sort());
  for (const mode of AGENT_MODES) {
    assert.equal(PI_MODE_SEMANTICS[mode].id, mode, 'id spiegelt den Schlüssel');
    assert.ok(PI_MODE_SEMANTICS[mode].hint.length > 0);
  }
  const pushing = AGENT_MODES.filter((m) => PI_MODE_SEMANTICS[m].autoPush);
  assert.deepEqual(pushing, ['yolo']);

  // Gating wird von yolo nach ask strikt strenger, nie lockerer.
  assert.deepEqual(
    AGENT_MODES.map((m) => `${PI_MODE_SEMANTICS[m].bash}/${PI_MODE_SEMANTICS[m].edits}`),
    ['none/none', 'risky/none', 'all/none', 'all/all'],
  );
});

test('autoPushForMode folgt dem Turn-Modus, ohne Modus der Env-Vorgabe', () => {
  assert.equal(autoPushForMode('yolo', false), true);
  assert.equal(autoPushForMode('ask', true), false, 'der Turn-Modus schlägt AUTO_PUSH');
  assert.equal(autoPushForMode('auto', true), false);
  assert.equal(autoPushForMode(undefined, true), true);
  assert.equal(autoPushForMode(undefined, false), false);
});

test('Modus- und Reasoning-Prüfer nehmen nur bekannte Werte an', () => {
  assert.ok(isAgentMode('acceptEdits'));
  assert.ok(isAgentMode(DEFAULT_AGENT_MODE));
  assert.equal(isAgentMode('AcceptEdits'), false);
  assert.equal(isAgentMode(''), false);
  assert.ok(isReasoningEffort('high'));
  assert.equal(isReasoningEffort('extreme'), false);
});

/* ------------------------------------------------------------------ */
/* Link-Protokoll                                                      */
/* ------------------------------------------------------------------ */

test('nur unauthorized und replaced beenden die Reconnect-Schleife', () => {
  assert.ok(isTerminalLinkCloseCode(WS_CLOSE_UNAUTHORIZED));
  assert.ok(isTerminalLinkCloseCode(WS_CLOSE_REPLACED));
  assert.equal(isTerminalLinkCloseCode(WS_CLOSE_TOO_MANY_CONNECTIONS), false);
  assert.equal(isTerminalLinkCloseCode(1006), false, 'normaler Netzabbruch');
  assert.equal(isTerminalLinkCloseCode(1001), false, 'Server-Neustart');
  assert.equal(LINK_PROTOCOL_VERSION, 2);
});
