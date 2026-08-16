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
                  "adapter": "opencode",
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
        assertEquals("opencode", session.adapter)
        assertEquals(com.pocketagent.app.data.AgentMode.ACCEPT_EDITS, session.mode)
        assertEquals(com.pocketagent.app.data.SessionStatus.RUNNING, session.status)
    }

    @Test
    fun `decodes adapter list with plugin adapter and capabilities`() {
        val raw = """
            {
              "type": "adapter.list",
              "requestId": "req-adp",
              "adapters": [
                {
                  "id": "kilo",
                  "name": "Kilo Code",
                  "description": "Kilo CLI fork",
                  "capabilities": { "approvals": true, "resume": true, "streaming": true, "autoPush": true },
                  "credentials": { "kilo": ["KILO_AUTH_CONTENT"] },
                  "providerEnv": { "zai": "ZAI_API_KEY" },
                  "defaults": { "provider": "zai", "model": "" },
                  "unknownExtra": "ignored"
                }
              ]
            }
        """.trimIndent()

        val msg = parseServerMessage(raw)
        assertTrue(msg is ServerMessage.AdapterListMsg)
        val adapters = (msg as ServerMessage.AdapterListMsg).adapters
        assertEquals(1, adapters.size)
        val kilo = adapters.first()
        assertEquals("kilo", kilo.id)
        assertEquals("Kilo Code", kilo.name)
        assertTrue(kilo.capabilities.approvals)
        assertEquals(listOf("KILO_AUTH_CONTENT"), kilo.credentials["kilo"])
        assertEquals("ZAI_API_KEY", kilo.providerEnv["zai"])
        assertEquals("zai", kilo.defaults.provider)
    }

    @Test
    fun `decodes session models and capability flags for switchers`() {
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

        val adapters = parseServerMessage(
            """
            {
              "type": "adapter.list",
              "requestId": "req-caps",
              "adapters": [
                {
                  "id": "claude",
                  "name": "Claude Code",
                  "capabilities": { "approvals": true, "reasoning": true, "modelSwitch": true },
                  "defaults": { "provider": "anthropic" }
                },
                {
                  "id": "junie",
                  "name": "Junie",
                  "capabilities": { "autoPush": true },
                  "defaults": { "provider": "openai" }
                }
              ]
            }
            """.trimIndent(),
        )
        val caps = (adapters as ServerMessage.AdapterListMsg).adapters
        assertTrue(caps[0].capabilities.reasoning)
        assertTrue(caps[0].capabilities.modelSwitch)
        // fehlende Flags bleiben false (abwaertskompatibel zu alten Servern)
        assertFalse(caps[1].capabilities.reasoning)
        assertFalse(caps[1].capabilities.modelSwitch)
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
                "id": "s1", "repoId": "r1", "adapter": "claude", "provider": "anthropic",
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
    fun `decodes provider metadata and stays empty without it`() {
        val msg = parseServerMessage(
            """
            {
              "type": "adapter.list",
              "requestId": "req-prov",
              "adapters": [
                {
                  "id": "claude",
                  "name": "Claude Code",
                  "capabilities": {},
                  "credentials": { "claude_oauth": ["CLAUDE_CODE_OAUTH_TOKEN"] },
                  "providers": [
                    { "id": "claude_oauth", "name": "Claude Abo (Setup-Token)", "hint": "claude setup-token" },
                    { "id": "anthropic", "name": "Anthropic", "keyUrl": "https://console.anthropic.com/settings/keys" }
                  ],
                  "defaults": { "provider": "anthropic" }
                },
                {
                  "id": "legacy",
                  "name": "Alter Adapter",
                  "capabilities": {},
                  "defaults": { "provider": "openai" }
                }
              ]
            }
            """.trimIndent(),
        )
        val adapters = (msg as ServerMessage.AdapterListMsg).adapters
        val claude = adapters.first()
        assertEquals(2, claude.providers.size)
        assertEquals("Claude Abo (Setup-Token)", claude.providers[0].name)
        assertNull(claude.providers[0].keyUrl)
        assertEquals("https://console.anthropic.com/settings/keys", claude.providers[1].keyUrl)
        // Server ohne das Feld -> leere Liste, App faellt auf ihre Tabelle zurueck
        assertTrue(adapters[1].providers.isEmpty())
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
            """{"type":"secret.validated","requestId":"v3","kind":"kilo","ok":true,"unverified":true}""",
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
                "message": "Agent gewechselt: kilo → claude …",
                "futureField": 1
              }
            }
            """.trimIndent(),
        )
        assertTrue(msg is ServerMessage.SessionEventMsg)
        val notice = (msg as ServerMessage.SessionEventMsg).event as AgentEvent.Notice
        assertEquals("Agent gewechselt: kilo → claude …", notice.message)
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
                "id": "s1", "repoId": "r1", "adapter": "claude", "provider": "anthropic",
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
        assertEquals("claude", status.session?.adapter)
    }

    @Test
    fun `encodes session update with adapter switch`() {
        val switch = com.pocketagent.app.data.encodeSessionUpdate(
            requestId = "req-1",
            sessionId = "s1",
            adapter = "claude",
        )
        assertTrue(switch.contains(""""type":"session.update""""))
        assertTrue(switch.contains(""""adapter":"claude""""))
        assertFalse(switch.contains("\"mode\""))
        assertFalse(switch.contains("\"model\""))

        // Ohne Adapter bleibt das Feld weg — der Server ändert dann nichts daran.
        val modeOnly = com.pocketagent.app.data.encodeSessionUpdate(
            requestId = "req-2",
            sessionId = "s1",
            mode = com.pocketagent.app.data.AgentMode.ACCEPT_EDITS,
        )
        assertTrue(modeOnly.contains(""""mode":"acceptEdits""""))
        assertFalse(modeOnly.contains("\"adapter\""))
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
}
