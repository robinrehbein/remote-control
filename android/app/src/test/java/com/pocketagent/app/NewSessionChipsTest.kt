package com.pocketagent.app

import com.pocketagent.app.data.ReasoningEffort
import com.pocketagent.app.data.piProviderName
import com.pocketagent.app.ui.screens.modelChipValue
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Was auf den Chips des Anlege-Screens steht. Reine Funktionen, damit die
 * Beschriftung prüfbar ist, ohne eine Oberfläche zu starten.
 */
class NewSessionChipsTest {

    /* ---------------- modelChipValue ---------------- */

    @Test
    fun `an empty model names the default`() {
        assertEquals("Standardmodell", modelChipValue("", null))
        assertEquals("Standardmodell", modelChipValue("   ", null))
    }

    @Test
    fun `a chosen model stands alone without a reasoning level`() {
        assertEquals("glm-4.6", modelChipValue("glm-4.6", null))
    }

    @Test
    fun `a chosen reasoning level rides along behind the model`() {
        assertEquals("glm-4.6 · Hoch", modelChipValue("glm-4.6", ReasoningEffort.HIGH))
        assertEquals("Standardmodell · Niedrig", modelChipValue("", ReasoningEffort.LOW))
    }

    @Test
    fun `the model is trimmed`() {
        assertEquals("glm-5.3", modelChipValue("  glm-5.3  ", null))
    }

    /* ---------------- Zugangsname auf dem Chip ---------------- */

    @Test
    fun `a known provider shows its display name`() {
        assertEquals("Z.AI", piProviderName("zai"))
        assertEquals("Google Gemini", piProviderName("google"))
        assertEquals("Moonshot", piProviderName("moonshot"))
        assertEquals("Kimi", piProviderName("kimi"))
    }

    @Test
    fun `a typed in provider keeps its id`() {
        assertEquals("deepseek", piProviderName("deepseek"))
    }
}
