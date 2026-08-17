package com.pocketagent.app

import com.pocketagent.app.data.DeviceCredentials
import com.pocketagent.app.data.WsClient
import com.pocketagent.app.data.isUnauthorizedClose
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [isUnauthorizedClose] ist als reine Funktion ausgelagert, damit sie ohne
 * Android-Framework/OkHttp testbar ist — Fix 3: Auth-Ablehnung darf nicht
 * als gewöhnliches Netzflackern im Retry-Loop landen.
 */
class WsClientTest {

    @Test
    fun `recognizes both unauthorized reasons on code 4001`() {
        assertTrue(isUnauthorizedClose(4001, "unauthorized"))
        assertTrue(isUnauthorizedClose(4001, "revoked"))
    }

    @Test
    fun `does not treat the connection limit close as unauthorized`() {
        // Das LIMIT läuft serverseitig über 4002 — das bleibt ein normaler,
        // weiter zu wiederholender Verbindungsabbruch.
        assertFalse(isUnauthorizedClose(4002, "unauthorized"))
        assertFalse(isUnauthorizedClose(4002, "limit"))
    }

    @Test
    fun `does not misfire on an unrelated close with a similar reason`() {
        assertFalse(isUnauthorizedClose(1000, "unauthorized"))
        assertFalse(isUnauthorizedClose(4001, "server shutting down"))
        assertFalse(isUnauthorizedClose(4001, ""))
    }

    /* --------------------------------------------------------------
     * onClosing: OkHttp ruft für einen server-initiierten Close (genau
     * der 4001-Fall) nur onClosing auf, niemals onClosed — solange der
     * Listener onClosing nicht überschreibt und den Handshake bestätigt,
     * bleibt die ganze Unauthorized-Erkennung toter Code. Diese Tests
     * rufen den privaten Listener direkt auf (per Reflection), damit sie
     * genau dieses OkHttp-Verhalten nachstellen können, ohne eine echte
     * Netzwerkverbindung zu brauchen.
     * -------------------------------------------------------------- */

    private class RecordingWebSocket : WebSocket {
        var closedWith: Pair<Int, String?>? = null
        override fun request(): Request = Request.Builder().url("http://localhost/ws").build()
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = true
        override fun send(bytes: ByteString): Boolean = true
        override fun close(code: Int, reason: String?): Boolean {
            closedWith = code to reason
            return true
        }

        override fun cancel() = Unit
    }

    /** Liest ein privates Feld von [WsClient] — kein Mocking-Framework im Projekt verfügbar. */
    private fun <T> WsClient.privateField(name: String): T {
        val field = WsClient::class.java.getDeclaredField(name)
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(this) as T
    }

    private fun clientWithFakeSocket(): Pair<WsClient, RecordingWebSocket> {
        val ws = WsClient(OkHttpClient())
        ws.configure("wss://example.test/ws", DeviceCredentials("device-1", "token-1"))
        val fake = RecordingWebSocket()
        val socketField = WsClient::class.java.getDeclaredField("socket")
        socketField.isAccessible = true
        socketField.set(ws, fake)
        return ws to fake
    }

    @Test
    fun `onClosing on a 4001 unauthorized close moves the state to Unauthorized`() {
        val (ws, fake) = clientWithFakeSocket()
        val listener = ws.privateField<WebSocketListener>("listener")

        listener.onClosing(fake, 4001, "revoked")

        assertTrue(ws.state.value is WsClient.ConnState.Unauthorized)
        // Ohne diese Bestätigung bliebe der Close-Handshake offen — genau der
        // Fund: onClosing war unimplementiert, also lief die Verbindung erst
        // in den Ping-Timeout statt sauber abzuschliessen.
        assertEquals(4001, fake.closedWith?.first)
    }

    @Test
    fun `onClosing on an ordinary close still acks the handshake without going Unauthorized`() {
        val (ws, fake) = clientWithFakeSocket()
        val listener = ws.privateField<WebSocketListener>("listener")

        listener.onClosing(fake, 1001, "going away")

        assertFalse(ws.state.value is WsClient.ConnState.Unauthorized)
        assertEquals(1001, fake.closedWith?.first)
    }

    @Test
    fun `does not auto-reconnect out of Unauthorized on a network or foreground trigger`() {
        // Fund 7: die Unauthorized-Dokumentation verspricht keinen
        // automatischen Reconnect — nur ein bewusster Tap darf es
        // versuchen. onNetworkAvailable ist automatisch verdrahtet.
        val ws = WsClient(OkHttpClient())
        ws.configure("wss://example.test/ws", DeviceCredentials("device-1", "token-1"))
        val stateField = WsClient::class.java.getDeclaredField("_state")
        stateField.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val state = stateField.get(ws) as MutableStateFlow<WsClient.ConnState>
        state.value = WsClient.ConnState.Unauthorized

        ws.onNetworkAvailable()

        assertTrue(ws.state.value is WsClient.ConnState.Unauthorized)
    }
}
