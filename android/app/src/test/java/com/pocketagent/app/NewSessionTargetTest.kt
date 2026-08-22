package com.pocketagent.app

import com.pocketagent.app.data.SessionTarget
import com.pocketagent.app.ui.screens.NewSessionViewModel
import com.pocketagent.app.ui.screens.advancedSummary
import com.pocketagent.app.ui.screens.networkPolicyAvailable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Die Zielwahl des Anlege-Screens: reine Funktionen und der Zustands-Default,
 * damit sich prüfen lässt, was angeboten wird, ohne eine Oberfläche zu starten.
 */
class NewSessionTargetTest {

    /* ---------------- Default ---------------- */

    @Test
    fun `new sessions start on the fly target`() {
        // Entscheidung: Fly ist der Default — die produktive, isolierte
        // Cloud-Sandbox. Coolify bleibt fuer Tests, der Heim-PC fuer die
        // eigene Maschine.
        assertEquals(SessionTarget.FLY, NewSessionViewModel.UiState().target)
    }

    /* ---------------- Netzwerk-Policy ---------------- */

    @Test
    fun `the network policy is offered for fly and coolify but not the home pc`() {
        assertTrue(networkPolicyAvailable(SessionTarget.FLY))
        assertTrue(networkPolicyAvailable(SessionTarget.DOCKER))
        // Auf fremder Hardware (dem eigenen Rechner) waere eine Policy nur
        // noch dokumentarisch — die Auswahl bleibt weg.
        assertFalse(networkPolicyAvailable(SessionTarget.LINK))
    }

    @Test
    fun `the advanced summary ignores the policy on the home pc`() {
        // Container-Ziele: eine Abweichung vom Default zeigt sich.
        assertEquals("Angepasst", advancedSummary(SessionTarget.FLY, "open", ""))
        assertEquals("Angepasst", advancedSummary(SessionTarget.DOCKER, "isolated", ""))
        assertEquals("Standard", advancedSummary(SessionTarget.DOCKER, "allowlist", ""))
        // Heim-PC: die Policy zaehlt nicht, nur der Branch hebt ab.
        assertEquals("Standard", advancedSummary(SessionTarget.LINK, "open", ""))
        assertEquals("Angepasst", advancedSummary(SessionTarget.LINK, "allowlist", "dev"))
        // Ein Basis-Branch hebt fuer jedes Ziel ab.
        assertEquals("Angepasst", advancedSummary(SessionTarget.FLY, "allowlist", "dev"))
    }
}
