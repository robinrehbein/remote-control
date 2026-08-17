package com.pocketagent.app

import com.pocketagent.app.data.ServerMessage
import com.pocketagent.app.data.encodeAuthCallback
import com.pocketagent.app.data.encodeAuthStart
import com.pocketagent.app.data.loopbackHttpResponse
import com.pocketagent.app.data.parseLoopbackCallback
import com.pocketagent.app.data.parseServerMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reine Logik des In-App-Codex-Logins (CODEX-OAUTH.md): das Zerlegen des
 * Loopback-Redirects, die Browser-Erfolgsseite und das Kodieren/Dekodieren der
 * auth.*-Nachrichten — alles ohne Android-Framework oder echte Sockets.
 */
class CodexOAuthTest {

    @Test
    fun `parses code and state from the loopback callback request line`() {
        val cb = parseLoopbackCallback("GET /auth/callback?code=abc123&state=xyz789 HTTP/1.1")
        assertNotNull(cb)
        assertEquals("abc123", cb!!.code)
        assertEquals("xyz789", cb.state)
    }

    @Test
    fun `url-decodes callback parameters`() {
        val cb = parseLoopbackCallback("GET /auth/callback?code=a%2Bb%2Fc&state=s%20t HTTP/1.1")
        assertNotNull(cb)
        assertEquals("a+b/c", cb!!.code)
        assertEquals("s t", cb.state)
    }

    @Test
    fun `rejects a callback missing state or on a foreign path`() {
        assertNull(parseLoopbackCallback("GET /auth/callback?code=only HTTP/1.1"))
        assertNull(parseLoopbackCallback("GET /favicon.ico?code=a&state=b HTTP/1.1"))
        assertNull(parseLoopbackCallback("GET /auth/callback HTTP/1.1"))
        assertNull(parseLoopbackCallback("garbage"))
    }

    @Test
    fun `success response is a well-formed http reply`() {
        val res = loopbackHttpResponse(ok = true)
        assertTrue(res.startsWith("HTTP/1.1 200 OK"))
        assertTrue(res.contains("Content-Length:"))
        assertTrue(res.contains("Connection: close"))
        assertTrue(res.contains("Angemeldet"))
    }

    @Test
    fun `encodes auth start and callback`() {
        assertTrue(encodeAuthStart("req1", "codex", "oauth-loopback").contains("\"type\":\"auth.start\""))
        assertTrue(encodeAuthStart("req1", "codex", "oauth-loopback").contains("\"flow\":\"oauth-loopback\""))
        val cb = encodeAuthCallback("req1", "the-code", "the-state")
        assertTrue(cb.contains("\"type\":\"auth.callback\""))
        assertTrue(cb.contains("\"code\":\"the-code\""))
        assertTrue(cb.contains("\"state\":\"the-state\""))
    }

    @Test
    fun `decodes auth url and auth done`() {
        val url = parseServerMessage(
            """{"type":"auth.url","requestId":"r1","url":"https://auth.openai.com/x","port":1455,"flow":"oauth-loopback"}""",
        )
        assertTrue(url is ServerMessage.AuthUrlMsg)
        url as ServerMessage.AuthUrlMsg
        assertEquals("https://auth.openai.com/x", url.url)
        assertEquals(1455, url.port)

        val done = parseServerMessage(
            """{"type":"auth.done","requestId":"r1","ok":true,"account":"ChatGPT Plus, a@b.c"}""",
        )
        assertTrue(done is ServerMessage.AuthDoneMsg)
        done as ServerMessage.AuthDoneMsg
        assertTrue(done.ok)
        assertEquals("ChatGPT Plus, a@b.c", done.account)
    }

    @Test
    fun `decodes adapter descriptor with authFlows`() {
        val msg = parseServerMessage(
            """
            {"type":"adapter.list","requestId":"r1","adapters":[
              {"id":"codex","name":"OpenAI Codex","authFlows":[
                {"type":"oauth-loopback","ports":[1455,1457]},
                {"type":"device-code"}
              ]}
            ]}
            """.trimIndent(),
        )
        assertTrue(msg is ServerMessage.AdapterListMsg)
        msg as ServerMessage.AdapterListMsg
        val codex = msg.adapters.first { it.id == "codex" }
        assertEquals(2, codex.authFlows.size)
        assertEquals("oauth-loopback", codex.authFlows[0].type)
        assertEquals(listOf(1455, 1457), codex.authFlows[0].ports)
    }
}
