package com.pocketagent.app

import com.pocketagent.app.data.WsClient
import com.pocketagent.app.data.awaitConnected
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [awaitConnected] ist als reine, von [com.pocketagent.app.data.AppRepository]
 * entkoppelte Funktion ausgelagert, damit sie ohne Android-Framework/Mocking
 * testbar ist (kein Mocking-Framework im Projekt verfügbar, s. WsClientTest).
 * Sie trägt den Notification-Action-Antwortpfad
 * (`AppRepository.respondToPermission`, W3.3): Erlauben/Ablehnen aus einer
 * Notification muss auch dann zustellbar sein, wenn die App gerade erst
 * durch den Tap gestartet wurde und die WS-Verbindung noch nicht steht.
 */
class AwaitConnectedTest {

    @Test
    fun `already connected returns immediately without reconnecting`() = runBlocking {
        val state = MutableStateFlow<WsClient.ConnState>(WsClient.ConnState.Connected(null))
        var reconnectCalls = 0

        val result = awaitConnected(state, timeoutMs = 50, pollMs = 5) { reconnectCalls++ }

        assertTrue(result)
        assertEquals(0, reconnectCalls)
    }

    @Test
    fun `reconnects once and waits until the state flips to connected`() = runBlocking {
        val state = MutableStateFlow<WsClient.ConnState>(WsClient.ConnState.Waiting(5))
        var reconnectCalls = 0

        val flip = launch {
            // Simuliert den echten Verbindungsaufbau, der asynchron
            // irgendwann Connected setzt.
            kotlinx.coroutines.delay(15)
            state.value = WsClient.ConnState.Connected("1.0")
        }

        val result = awaitConnected(state, timeoutMs = 500, pollMs = 5) { reconnectCalls++ }
        flip.join()

        assertTrue(result)
        assertEquals(1, reconnectCalls)
    }

    @Test
    fun `gives up honestly after the timeout instead of waiting forever`() = runBlocking {
        val state = MutableStateFlow<WsClient.ConnState>(WsClient.ConnState.Disconnected("Kein Netz"))

        val result = awaitConnected(state, timeoutMs = 30, pollMs = 5) {}

        assertFalse(result)
    }
}
