package com.pocketagent.app

import com.pocketagent.app.connection.ConnectionServiceAction
import com.pocketagent.app.connection.connectionServiceAction
import com.pocketagent.app.data.WsClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [connectionServiceAction] ist als reine Funktion ausgelagert, damit sie
 * ohne Android-Framework testbar ist (kein Mocking-Framework im Projekt —
 * gleiche Begründung wie WsClientTest für isUnauthorizedClose).
 */
class ConnectionServiceActionTest {

    private fun announced(state: WsClient.ConnState): String {
        val action = connectionServiceAction(state)
        assertTrue("erwartet Announce für $state", action is ConnectionServiceAction.Announce)
        return (action as ConnectionServiceAction.Announce).text
    }

    @Test
    fun `connected announces the live connection`() {
        assertEquals("Mit dem Server verbunden", announced(WsClient.ConnState.Connected(null)))
        // Server-Version als Beleg, dass es wirklich dieser Server ist
        assertTrue(announced(WsClient.ConnState.Connected("1.2.3")).contains("1.2.3"))
    }

    @Test
    fun `waiting announces the visible countdown`() {
        val text = announced(WsClient.ConnState.Waiting(7, "Verbindung abgebrochen"))
        assertTrue(text.contains("7"))
        // Der Grund hat in der Notification nichts verloren — der Countdown
        // ist die Aussage, nicht die Fehlerursache.
        assertTrue(!text.contains("abgebrochen"))
    }

    @Test
    fun `disconnected passes the honest reason through`() {
        assertEquals("Kein Netz", announced(WsClient.ConnState.Disconnected("Kein Netz")))
    }

    @Test
    fun `unauthorized stops the service instead of a hollow notification`() {
        assertEquals(ConnectionServiceAction.Stop, connectionServiceAction(WsClient.ConnState.Unauthorized))
    }

    @Test
    fun `idle announces instead of stopping - it is transient after a sticky restart`() {
        // Nach einem Sticky-Neustart ist der Zustand erst mal Idle, bis
        // repository.start()s Collector connect() aufgerufen hat — ein Stop
        // hier würde den Dienst in diesem Fenster sofort wieder einfahren.
        // Abgemeldet wird über den tokenStore.setup-Collector erkannt.
        assertEquals(
            "Verbindung wird aufgebaut …",
            announced(WsClient.ConnState.Idle),
        )
    }
}
