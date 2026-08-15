package com.pocketagent.app

import com.pocketagent.app.data.PairingApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PairingDecodeTest {

    @Test
    fun `parses pairing confirm response`() {
        val raw = """
            {
              "ok": true,
              "deviceId": "dev-123",
              "deviceToken": "tok-abc",
              "futureField": "ignored"
            }
        """.trimIndent()

        val response = PairingApi.parseResponse(raw)
        assertNotNull(response)
        assertEquals(true, response!!.ok)
        assertEquals("dev-123", response.deviceId)
        assertEquals("tok-abc", response.deviceToken)
    }

    @Test
    fun `rejects response without token`() {
        assertNull(PairingApi.parseResponse("""{"ok": true, "deviceId": "x", "deviceToken": ""}"""))
        assertNull(PairingApi.parseResponse("""{"ok": false}"""))
        assertNull(PairingApi.parseResponse("garbage"))
    }

    @Test
    fun `normalizes and derives ws url`() {
        assertEquals("https://example.com", PairingApi.normalizeUrl("example.com"))
        assertEquals("http://localhost:3000", PairingApi.normalizeUrl("http://localhost:3000/"))
        assertEquals("wss://example.com/ws", PairingApi.wsUrl("https://example.com/"))
        assertEquals("ws://localhost:3000/ws", PairingApi.wsUrl("http://localhost:3000"))
    }
}
