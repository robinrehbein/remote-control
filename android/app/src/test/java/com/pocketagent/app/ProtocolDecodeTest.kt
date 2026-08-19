package com.pocketagent.app

import com.pocketagent.app.data.AgentEvent
import com.pocketagent.app.data.ServerMessage
import com.pocketagent.app.data.StartPhase
import com.pocketagent.app.data.parseServerMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolDecodeTest {

    @Test
    fun `decodes session event with tool call and unknown fields`() {
        val raw = """
            {
              "type": "session.event",
              "sessionId": "sess-1",
              "extraTopLevel": "unknown",
              "event": {
                "type": "tool.call",
                "id": "call-42",
                "tool": "bash",
                "input": {"command": "npm test"},
                "title": "bash: npm test",
                "futureField": {"a": [1, 2, 3]}
              }
            }
        """.trimIndent()

        val msg = parseServerMessage(raw)
        assertNotNull(msg)
        val event = msg as ServerMessage.SessionEventMsg
        assertEquals("sess-1", event.sessionId)
        val tool = event.event as AgentEvent.ToolCall
        assertEquals("call-42", tool.id)
        assertEquals("bash", tool.tool)
        assertEquals("bash: npm test", tool.title)
        assertEquals("""{"command":"npm test"}""", tool.input.toString())
        // W2.1 (Event-Replay) fügte diese seq erst nachträglich hinzu — ohne
        // sie im Payload bleibt sie null statt das Dekodieren zu verwerfen.
        assertNull(tool.seq)
    }

    /**
     * W2.1 (Event-Replay) prägt jedem sequenzierten Ereignis eine `seq` auf
     * (`SequencedSseBroadcaster`, packages/protocol). Fund W2.1-Folgepunkt:
     * die Kotlin-Seite muss sie mitnehmen, damit der Merge zwischen Live-
     * Strom und Verlauf nach einem Reconnect darauf zurückgreifen kann.
     */
    @Test
    fun `decodes the seq a sequenced server stamps onto an event`() {
        val raw = """
            {
              "type": "session.event",
              "sessionId": "sess-1",
              "event": {
                "type": "message.completed",
                "role": "assistant",
                "text": "Fertig.",
                "seq": 42,
                "ts": 1755000000000
              }
            }
        """.trimIndent()

        val msg = parseServerMessage(raw) as ServerMessage.SessionEventMsg
        val completed = msg.event as AgentEvent.MessageCompleted
        assertEquals(42L, completed.seq)
    }

    /** `ping` wird nie sequenziert (siehe AgentEvent.Ping-KDoc) — auch mit einer seq im Payload bleibt sie ignoriert. */
    @Test
    fun `ping never carries a seq, even if one is sent`() {
        val raw = """
            {
              "type": "session.event",
              "sessionId": "sess-1",
              "event": { "type": "ping", "ts": 123, "seq": 7 }
            }
        """.trimIndent()

        val msg = parseServerMessage(raw) as ServerMessage.SessionEventMsg
        val ping = msg.event as AgentEvent.Ping
        assertEquals(123L, ping.ts)
        assertNull(ping.seq)
    }

    @Test
    fun `decodes request ok with payload and unknown fields`() {
        val raw = """
            {
              "type": "request.ok",
              "requestId": "req-7",
              "payload": {"any": "thing"},
              "unknown": 123
            }
        """.trimIndent()

        val msg = parseServerMessage(raw)
        assertTrue(msg is ServerMessage.RequestOk)
        val ok = msg as ServerMessage.RequestOk
        assertEquals("req-7", ok.requestId)
        assertNotNull(ok.payload)
    }

    @Test
    fun `decodes session list with sessions and unknown fields`() {
        val raw = """
            {
              "type": "session.list",
              "requestId": "req-9",
              "unknownTop": true,
              "sessions": [
                {
                  "id": "s1",
                  "repoId": "r1",
                  "repoFullName": "acme/api",
                  "adapter": "pi",
                  "provider": "zai",
                  "model": "glm-4.6",
                  "mode": "acceptEdits",
                  "status": "running",
                  "branch": "agent/s1",
                  "createdAt": "2026-01-01T10:00:00Z",
                  "lastActiveAt": "2026-01-01T11:00:00Z",
                  "prUrl": "https://github.com/acme/api/pull/1",
                  "unknownField": 42
                }
              ]
            }
        """.trimIndent()

        val msg = parseServerMessage(raw)
        assertTrue(msg is ServerMessage.SessionListMsg)
        val list = (msg as ServerMessage.SessionListMsg).sessions
        assertEquals(1, list.size)
        val session = list.first()
        assertEquals("acme/api", session.repoFullName)
        assertEquals("pi", session.adapter)
        assertEquals(com.pocketagent.app.data.AgentMode.ACCEPT_EDITS, session.mode)
        assertEquals(com.pocketagent.app.data.SessionStatus.RUNNING, session.status)
    }

    /**
     * Die Multi-Adapter-Nachrichten sind aus dem Vertrag raus (GREENFIELD-PI):
     * ein Server, der sie noch schickt, darf die App nicht aus dem Tritt
     * bringen — sie fallen wie jeder unbekannte Typ still heraus.
     */
    @Test
    fun `ignores removed multi agent messages`() {
        assertNull(
            parseServerMessage(
                """{ "type": "adapter.list", "requestId": "req-adp", "adapters": [] }""",
            ),
        )
        assertNull(
            parseServerMessage(
                """{ "type": "auth.url", "requestId": "req-a", "url": "https://example.test", "port": 1455 }""",
            ),
        )
        assertNull(parseServerMessage("""{ "type": "auth.done", "requestId": "req-a", "ok": true }"""))
    }

    @Test
    fun `decodes session models`() {
        val models = parseServerMessage(
            """
            {
              "type": "session.models",
              "requestId": "req-mod",
              "sessionId": "s1",
              "models": [
                { "id": "zai/glm-4.6", "name": "zai \u00b7 GLM 4.6" },
                { "id": "claude-opus-5" },
                { "noId": true }
              ]
            }
            """.trimIndent(),
        )
        assertTrue(models is ServerMessage.SessionModelsMsg)
        val list = (models as ServerMessage.SessionModelsMsg).models
        assertEquals("s1", models.sessionId)
        assertEquals(2, list.size)
        assertEquals("zai/glm-4.6", list.first().id)
        assertNull(list[1].name)
    }

    @Test
    fun `decodes session status with reasoning effort`() {
        val msg = parseServerMessage(
            """
            {
              "type": "session.status",
              "sessionId": "s1",
              "status": "idle",
              "session": {
                "id": "s1", "repoId": "r1", "adapter": "pi", "provider": "anthropic",
                "model": "claude-opus-5", "mode": "auto", "status": "idle", "branch": "agent/s1",
                "createdAt": "2026-01-01T10:00:00Z", "lastActiveAt": "2026-01-01T11:00:00Z",
                "reasoningEffort": "high"
              }
            }
            """.trimIndent(),
        )
        assertTrue(msg is ServerMessage.SessionStatusMsg)
        val session = (msg as ServerMessage.SessionStatusMsg).session
        assertEquals("high", session?.reasoningEffort)
        assertEquals("claude-opus-5", session?.model)
    }

    @Test
    fun `decodes secret validated results`() {
        val ok = parseServerMessage(
            """{"type":"secret.validated","requestId":"v1","kind":"openai","ok":true,"detail":"42 Modelle verfügbar"}""",
        )
        assertTrue(ok is ServerMessage.SecretValidatedMsg)
        val okMsg = ok as ServerMessage.SecretValidatedMsg
        assertTrue(okMsg.ok)
        assertFalse(okMsg.unverified)
        assertEquals("42 Modelle verfügbar", okMsg.detail)

        val bad = parseServerMessage(
            """{"type":"secret.validated","requestId":"v2","kind":"anthropic","ok":false,"detail":"Key ungültig oder abgelaufen"}""",
        ) as ServerMessage.SecretValidatedMsg
        assertFalse(bad.ok)

        val unverified = parseServerMessage(
            """{"type":"secret.validated","requestId":"v3","kind":"moonshot","ok":true,"unverified":true}""",
        ) as ServerMessage.SecretValidatedMsg
        assertTrue(unverified.unverified)
        assertNull(unverified.detail)

        assertNull(parseServerMessage("""{"type":"secret.validated","kind":"openai","ok":true}"""))
    }

    @Test
    fun `decodes notice events as system hints`() {
        val msg = parseServerMessage(
            """
            {
              "type": "session.event",
              "sessionId": "s1",
              "event": {
                "type": "notice",
                "message": "Arbeitsverzeichnis vorbereitet …",
                "futureField": 1
              }
            }
            """.trimIndent(),
        )
        assertTrue(msg is ServerMessage.SessionEventMsg)
        val notice = (msg as ServerMessage.SessionEventMsg).event as AgentEvent.Notice
        assertEquals("Arbeitsverzeichnis vorbereitet …", notice.message)
        // Ohne phase bleibt es eine gewoehnliche Systemzeile in der Timeline
        assertNull(notice.phase)
        assertNull(StartPhase.fromRaw(notice.phase))
        assertNull(notice.detail)

        // Ohne message ist der Hinweis wertlos -> Event wird verworfen
        assertNull(parseServerMessage("""{"type":"session.event","sessionId":"s1","event":{"type":"notice"}}"""))
    }

    @Test
    fun `decodes notice with start phase and log detail`() {
        val msg = parseServerMessage(
            """
            {
              "type": "session.event",
              "sessionId": "s1",
              "event": {
                "type": "notice",
                "message": "Image wird gebaut (Schritt 7/14)",
                "phase": "image-build",
                "detail": "Step 7/14 : RUN npm ci\nadded 412 packages",
                "futureField": 1
              }
            }
            """.trimIndent(),
        )
        val notice = (msg as ServerMessage.SessionEventMsg).event as AgentEvent.Notice
        assertEquals("Image wird gebaut (Schritt 7/14)", notice.message)
        assertEquals("image-build", notice.phase)
        assertEquals(StartPhase.IMAGE_BUILD, StartPhase.fromRaw(notice.phase))
        assertEquals("Step 7/14 : RUN npm ci\nadded 412 packages", notice.detail)

        // Die uebrigen Phasen des Vertrags
        assertEquals(StartPhase.CONTAINER_START, StartPhase.fromRaw("container-start"))
        assertEquals(StartPhase.SHIM_START, StartPhase.fromRaw("shim-start"))
        // v2 nennt denselben Schritt Runner statt Shim — beides zaehlt.
        assertEquals(StartPhase.SHIM_START, StartPhase.fromRaw("runner-start"))
        assertEquals(StartPhase.READY, StartPhase.fromRaw("ready"))

        // phase ohne detail ist erlaubt — dann gibt es eben keinen Log
        val ready = (
            parseServerMessage(
                """{"type":"session.event","sessionId":"s1","event":{"type":"notice","message":"Bereit","phase":"ready"}}""",
            ) as ServerMessage.SessionEventMsg
            ).event as AgentEvent.Notice
        assertEquals(StartPhase.READY, StartPhase.fromRaw(ready.phase))
        assertNull(ready.detail)
    }

    @Test
    fun `tolerates unknown start phases`() {
        val msg = parseServerMessage(
            """
            {
              "type": "session.event",
              "sessionId": "s1",
              "event": {
                "type": "notice",
                "message": "Volume wird angelegt",
                "phase": "volume-create",
                "detail": "creating volume pocketagent-s1"
              }
            }
            """.trimIndent(),
        )
        // Das Event wird nicht verworfen, nur die Phase ist unbekannt
        assertNotNull(msg)
        val notice = (msg as ServerMessage.SessionEventMsg).event as AgentEvent.Notice
        assertEquals("Volume wird angelegt", notice.message)
        assertEquals(StartPhase.UNKNOWN, StartPhase.fromRaw(notice.phase))
        assertEquals("creating volume pocketagent-s1", notice.detail)

        // Leerer String zaehlt als "keine Phase", nicht als unbekannte
        assertNull(StartPhase.fromRaw(""))
    }

    @Test
    fun `decodes starting status like creating`() {
        val msg = parseServerMessage(
            """
            {
              "type": "session.status",
              "sessionId": "s1",
              "status": "starting",
              "session": {
                "id": "s1", "repoId": "r1", "adapter": "pi", "provider": "anthropic",
                "model": "", "mode": "auto", "status": "starting", "branch": "agent/s1",
                "createdAt": "2026-01-01T10:00:00Z", "lastActiveAt": "2026-01-01T11:00:00Z"
              }
            }
            """.trimIndent(),
        )
        assertTrue(msg is ServerMessage.SessionStatusMsg)
        val status = msg as ServerMessage.SessionStatusMsg
        assertEquals(com.pocketagent.app.data.SessionStatus.CREATING, status.status)
        assertEquals(com.pocketagent.app.data.SessionStatus.CREATING, status.session?.status)
        assertEquals("pi", status.session?.adapter)
    }

    /**
     * `session.update` kennt keinen Agentenwechsel mehr: nur noch Modus,
     * Modell und Reasoning, und jedes Feld bleibt weg, wenn es nicht gesetzt
     * wurde — der Server ändert dann nichts daran.
     */
    @Test
    fun `encodes session update without an agent switch`() {
        val modeOnly = com.pocketagent.app.data.encodeSessionUpdate(
            requestId = "req-1",
            sessionId = "s1",
            mode = com.pocketagent.app.data.AgentMode.ACCEPT_EDITS,
        )
        assertTrue(modeOnly.contains(""""type":"session.update""""))
        assertTrue(modeOnly.contains(""""mode":"acceptEdits""""))
        assertFalse(modeOnly.contains("\"adapter\""))
        assertFalse(modeOnly.contains("\"model\""))

        val modelOnly = com.pocketagent.app.data.encodeSessionUpdate(
            requestId = "req-2",
            sessionId = "s1",
            model = "zai/glm-4.6",
        )
        assertTrue(modelOnly.contains(""""model":"zai/glm-4.6""""))
        assertFalse(modelOnly.contains("\"mode\""))
        assertFalse(modelOnly.contains("\"adapter\""))
    }

    /**
     * `session.create` trägt weiterhin den Agenten im Wire-Format (Vertrag
     * unverändert zu v1) — er ist nur keine Wahl mehr, sondern immer pi.
     */
    @Test
    fun `encodes session create with the one agent`() {
        val json = com.pocketagent.app.data.encodeSessionCreate(
            requestId = "req-3",
            repoId = "r1",
            provider = "zai",
            model = "",
            mode = com.pocketagent.app.data.AgentMode.AUTO,
            branch = null,
            networkPolicy = "allowlist",
        )
        assertTrue(json.contains(""""type":"session.create""""))
        assertTrue(json.contains(""""adapter":"pi""""))
        assertTrue(json.contains(""""provider":"zai""""))
        assertFalse(json.contains("\"branch\""))
    }

    /* -------------------- session.events (Verlauf) -------------------- */

    @Test
    fun `decodes stored session events in order`() {
        val msg = parseServerMessage(
            """
            {
              "type": "session.events",
              "requestId": "req-hist",
              "sessionId": "s1",
              "unknownTop": 1,
              "events": [
                { "type": "message.completed", "role": "user", "text": "Bau den Login um" },
                { "type": "tool.call", "id": "c1", "tool": "bash", "input": {"command": "npm test"} },
                { "type": "tool.result", "id": "c1", "tool": "bash", "output": "ok" },
                { "type": "message.completed", "role": "assistant", "text": "Fertig." },
                { "type": "turn.completed", "commitSha": "abcdef1234" },
                { "type": "brandneu.aus.der.zukunft", "was": "auch immer" }
              ]
            }
            """.trimIndent(),
        )
        assertTrue(msg is ServerMessage.SessionEventsMsg)
        val events = (msg as ServerMessage.SessionEventsMsg).events
        assertEquals("s1", msg.sessionId)
        assertEquals("req-hist", msg.requestId)
        // Unbekannte Event-Typen fallen still heraus, der Rest bleibt nutzbar
        assertEquals(5, events.size)
        assertEquals("Bau den Login um", (events[0] as AgentEvent.MessageCompleted).text)
        assertEquals("user", (events[0] as AgentEvent.MessageCompleted).role)
        assertEquals("c1", (events[1] as AgentEvent.ToolCall).id)
        assertEquals("ok", (events[2] as AgentEvent.ToolResult).output)
        assertEquals("abcdef1234", (events[4] as AgentEvent.TurnCompleted).commitSha)
    }

    @Test
    fun `decodes empty and missing event lists`() {
        val empty = parseServerMessage(
            """{"type":"session.events","requestId":"r1","sessionId":"s1","events":[]}""",
        )
        assertTrue(empty is ServerMessage.SessionEventsMsg)
        assertTrue((empty as ServerMessage.SessionEventsMsg).events.isEmpty())

        // Fehlt das Feld ganz, ist das dasselbe wie "kein Verlauf"
        val missing = parseServerMessage(
            """{"type":"session.events","requestId":"r2","sessionId":"s1"}""",
        ) as ServerMessage.SessionEventsMsg
        assertTrue(missing.events.isEmpty())

        // Ohne requestId oder sessionId ist die Antwort nicht zuzuordnen
        assertNull(parseServerMessage("""{"type":"session.events","sessionId":"s1","events":[]}"""))
        assertNull(parseServerMessage("""{"type":"session.events","requestId":"r3","events":[]}"""))
    }

    /* -------------------- Titel und Archiv -------------------- */

    @Test
    fun `decodes session title and archived flag`() {
        val msg = parseServerMessage(
            """
            {
              "type": "session.list",
              "requestId": "req-t",
              "sessions": [
                {
                  "id": "s1", "repoId": "r1", "adapter": "pi", "provider": "anthropic",
                  "model": "", "mode": "auto", "status": "idle", "branch": "agent/s1",
                  "createdAt": "2026-01-01T10:00:00Z", "lastActiveAt": "2026-01-01T11:00:00Z",
                  "title": "Login-Timeout", "archived": true
                },
                {
                  "id": "s2", "repoId": "r1", "adapter": "pi", "provider": "anthropic",
                  "model": "", "mode": "auto", "status": "idle", "branch": "agent/s2",
                  "createdAt": "2026-01-01T10:00:00Z", "lastActiveAt": "2026-01-01T11:00:00Z"
                }
              ]
            }
            """.trimIndent(),
        )
        val sessions = (msg as ServerMessage.SessionListMsg).sessions
        assertEquals("Login-Timeout", sessions[0].title)
        assertTrue(sessions[0].archived)
        // Alter Server ohne die Felder: kein Titel, nicht archiviert
        assertNull(sessions[1].title)
        assertFalse(sessions[1].archived)
    }

    /* -------------------- Link-Sessions -------------------- */

    @Test
    fun `decodes the linked flag and defaults it to false`() {
        val msg = parseServerMessage(
            """
            {
              "type": "session.list",
              "requestId": "req-l",
              "sessions": [
                {
                  "id": "s1", "repoId": "", "repoFullName": "link:devbox (/work/app)",
                  "adapter": "pi", "provider": "", "model": "",
                  "mode": "ask", "status": "stopped", "branch": "local",
                  "createdAt": "2026-01-01T10:00:00Z", "lastActiveAt": "2026-01-01T11:00:00Z",
                  "linked": true
                },
                {
                  "id": "s2", "repoId": "r1", "adapter": "pi", "provider": "anthropic",
                  "model": "", "mode": "auto", "status": "idle", "branch": "agent/s2",
                  "createdAt": "2026-01-01T10:00:00Z", "lastActiveAt": "2026-01-01T11:00:00Z"
                }
              ]
            }
            """.trimIndent(),
        )
        val sessions = (msg as ServerMessage.SessionListMsg).sessions
        assertTrue(sessions[0].linked)
        // Alter Server ohne das Feld: keine Link-Session
        assertFalse(sessions[1].linked)
    }

    /* -------------------- Neue Client-Nachrichten -------------------- */

    @Test
    fun `encodes session events get with and without limit`() {
        val plain = com.pocketagent.app.data.encodeSessionEventsGet("req-1", "s1")
        assertTrue(plain.contains(""""type":"session.events.get""""))
        assertTrue(plain.contains(""""requestId":"req-1""""))
        assertTrue(plain.contains(""""sessionId":"s1""""))
        // Ohne Limit entscheidet der Server (Vertrag: 200)
        assertFalse(plain.contains("\"limit\""))

        val limited = com.pocketagent.app.data.encodeSessionEventsGet("req-2", "s1", 50)
        assertTrue(limited.contains(""""limit":50"""))
    }

    @Test
    fun `encodes session rename including title removal`() {
        val named = com.pocketagent.app.data.encodeSessionRename("req-3", "s1", "Login-Timeout")
        assertTrue(named.contains(""""type":"session.rename""""))
        assertTrue(named.contains(""""title":"Login-Timeout""""))

        // Leerer Titel ist der Vertragsweg, den Titel zu entfernen — das Feld
        // muss also mitgehen und darf nicht wegoptimiert werden.
        val cleared = com.pocketagent.app.data.encodeSessionRename("req-4", "s1", "")
        assertTrue(cleared.contains(""""title":""""))
    }

    @Test
    fun `encodes session archive both ways`() {
        val on = com.pocketagent.app.data.encodeSessionArchive("req-5", "s1", true)
        assertTrue(on.contains(""""type":"session.archive""""))
        assertTrue(on.contains(""""sessionId":"s1""""))
        assertTrue(on.contains(""""archived":true"""))

        val off = com.pocketagent.app.data.encodeSessionArchive("req-6", "s1", false)
        assertTrue(off.contains(""""archived":false"""))
    }

    /* -------------------- session.prompt (Ack) -------------------- */

    @Test
    fun `encodes session prompt with requestId for the new ack contract`() {
        val withMode = com.pocketagent.app.data.encodeSessionPrompt(
            requestId = "req-p1",
            sessionId = "s1",
            text = "Bau den Login um",
            mode = com.pocketagent.app.data.AgentMode.AUTO,
            messageId = "msg_abc123",
        )
        assertTrue(withMode.contains(""""type":"session.prompt""""))
        assertTrue(withMode.contains(""""sessionId":"s1""""))
        assertTrue(withMode.contains(""""text":"Bau den Login um""""))
        assertTrue(withMode.contains(""""mode":"auto""""))
        assertTrue(withMode.contains(""""requestId":"req-p1""""))
        // Die über den Turn stabile messageId reist mit (Idempotenz, P1).
        assertTrue(withMode.contains(""""messageId":"msg_abc123""""))

        // Ohne Modus bleibt das Feld weg, requestId geht trotzdem mit — ohne
        // sie gäbe es keine Bestätigung, auf die der Client warten könnte.
        // Ohne messageId (alter Aufrufer) bleibt auch dieses Feld weg.
        val withoutMode = com.pocketagent.app.data.encodeSessionPrompt(
            requestId = "req-p2",
            sessionId = "s1",
            text = "weiter",
            mode = null,
        )
        assertFalse(withoutMode.contains("\"mode\""))
        assertFalse(withoutMode.contains("\"messageId\""))
        assertTrue(withoutMode.contains(""""requestId":"req-p2""""))
    }

    @Test
    fun `decodes request ok and error as the ack for session prompt`() {
        val ok = parseServerMessage(
            """{"type":"request.ok","requestId":"req-p1","payload":{"sessionId":"s1"}}""",
        )
        assertTrue(ok is ServerMessage.RequestOk)
        assertEquals("req-p1", (ok as ServerMessage.RequestOk).requestId)

        val error = parseServerMessage(
            """{"type":"error","requestId":"req-p2","sessionId":"s1","message":"Session nicht gefunden"}""",
        )
        assertTrue(error is ServerMessage.ErrorMsg)
        val errorMsg = error as ServerMessage.ErrorMsg
        assertEquals("req-p2", errorMsg.requestId)
        assertEquals("s1", errorMsg.sessionId)
        assertEquals("Session nicht gefunden", errorMsg.message)
    }

    @Test
    fun `returns null for garbage and unknown types`() {
        assertNull(parseServerMessage("not json"))
        assertNull(parseServerMessage("""{"type":"completely.unknown"}"""))
        assertNull(parseServerMessage("""{"noType":true}"""))
    }

    @Test
    fun `returns null for unknown future server message types`() {
        assertNull(parseServerMessage("""{"type":"device.list","requestId":"r1","devices":[]}"""))
        assertNull(parseServerMessage("""{"type":"device.revoke","requestId":"r2","deviceId":"d1"}"""))
        assertNull(parseServerMessage("""{"type":"link.list","requestId":"r3","links":[]}"""))
        assertNull(parseServerMessage("""{"type":"link.revoke","requestId":"r4","linkId":"l1"}"""))
    }

    /* -------------------- Unbekannte Enum-Werte (mode/status) -------------------- */

    @Test
    fun `an unknown session status no longer drops the whole session from session-list`() {
        // Fund: ein neuerer Server kennt einen status-Wert (hier "paused"),
        // den diese App-Version nicht kennt. Vorher warf das Dekodieren der
        // SessionInfo, mapNotNull verwarf die ganze Session — sie fehlte
        // kommentarlos in der Liste.
        val msg = parseServerMessage(
            """
            {
              "type": "session.list",
              "requestId": "req-u1",
              "sessions": [
                {
                  "id": "s1", "repoId": "r1", "adapter": "pi", "provider": "anthropic",
                  "model": "opus", "mode": "auto", "status": "paused", "branch": "agent/s1",
                  "createdAt": "2026-01-01T10:00:00Z", "lastActiveAt": "2026-01-01T11:00:00Z"
                },
                {
                  "id": "s2", "repoId": "r1", "adapter": "pi", "provider": "anthropic",
                  "model": "opus", "mode": "futureMode", "status": "idle", "branch": "agent/s2",
                  "createdAt": "2026-01-01T10:00:00Z", "lastActiveAt": "2026-01-01T11:00:00Z"
                }
              ]
            }
            """.trimIndent(),
        )
        assertTrue(msg is ServerMessage.SessionListMsg)
        val sessions = (msg as ServerMessage.SessionListMsg).sessions
        // Beide Sessions bleiben erhalten — die unbekannten Werte fallen
        // einzeln auf UNKNOWN, statt die Session komplett zu verwerfen.
        assertEquals(2, sessions.size)
        assertEquals("s1", sessions[0].id)
        assertEquals(com.pocketagent.app.data.SessionStatus.UNKNOWN, sessions[0].status)
        assertEquals(com.pocketagent.app.data.AgentMode.AUTO, sessions[0].mode)
        assertEquals("s2", sessions[1].id)
        assertEquals(com.pocketagent.app.data.AgentMode.UNKNOWN, sessions[1].mode)
        assertEquals(com.pocketagent.app.data.SessionStatus.IDLE, sessions[1].status)
    }

    @Test
    fun `an unknown top-level session status is coerced to UNKNOWN instead of dropping the event`() {
        val msg = parseServerMessage(
            """
            {
              "type": "session.status",
              "sessionId": "s1",
              "status": "paused",
              "session": {
                "id": "s1", "repoId": "r1", "adapter": "pi", "provider": "anthropic",
                "model": "opus", "mode": "auto", "status": "paused", "branch": "agent/s1",
                "createdAt": "2026-01-01T10:00:00Z", "lastActiveAt": "2026-01-01T11:00:00Z"
              }
            }
            """.trimIndent(),
        )
        assertTrue(msg is ServerMessage.SessionStatusMsg)
        val status = msg as ServerMessage.SessionStatusMsg
        assertEquals(com.pocketagent.app.data.SessionStatus.UNKNOWN, status.status)
        assertEquals(com.pocketagent.app.data.SessionStatus.UNKNOWN, status.session?.status)
    }

    @Test
    fun `an unknown mode on a live status event keeps the busy update instead of dropping it`() {
        // Fund: "Gleiches Muster beim status-event: unbekannter mode -> return
        // null, das Busy-Update geht verloren." AgentMode.fromRaw fiel vorher
        // sogar für bekannte Werte wie "acceptEdits" auf null zurück (Namens-
        // vergleich ACCEPT_EDITS vs. acceptEdits scheiterte am Unterstrich) —
        // beides wird hier mitgeprüft.
        val msg = parseServerMessage(
            """
            {
              "type": "session.event",
              "sessionId": "s1",
              "event": {
                "type": "status",
                "adapter": "pi",
                "mode": "futureMode",
                "busy": true
              }
            }
            """.trimIndent(),
        )
        assertTrue(msg is ServerMessage.SessionEventMsg)
        val status = (msg as ServerMessage.SessionEventMsg).event as AgentEvent.Status
        assertTrue(status.busy)
        assertEquals(com.pocketagent.app.data.AgentMode.UNKNOWN, status.mode)

        val known = parseServerMessage(
            """
            {
              "type": "session.event",
              "sessionId": "s1",
              "event": { "type": "status", "adapter": "pi", "mode": "acceptEdits", "busy": false }
            }
            """.trimIndent(),
        )
        val knownStatus = (known as ServerMessage.SessionEventMsg).event as AgentEvent.Status
        assertEquals(com.pocketagent.app.data.AgentMode.ACCEPT_EDITS, knownStatus.mode)
    }
}
