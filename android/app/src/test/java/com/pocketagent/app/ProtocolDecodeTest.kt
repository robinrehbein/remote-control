package com.pocketagent.app

import com.pocketagent.app.data.AgentEvent
import com.pocketagent.app.data.ServerMessage
import com.pocketagent.app.data.parseServerMessage
import org.junit.Assert.assertEquals
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
    fun `returns null for garbage and unknown types`() {
        assertNull(parseServerMessage("not json"))
        assertNull(parseServerMessage("""{"type":"completely.unknown"}"""))
        assertNull(parseServerMessage("""{"noType":true}"""))
    }
}
