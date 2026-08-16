package com.pocketagent.app

import com.pocketagent.app.data.isUnauthorizedClose
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
}
