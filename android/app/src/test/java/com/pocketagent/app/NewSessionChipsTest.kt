package com.pocketagent.app

import com.pocketagent.app.data.AdapterCapabilities
import com.pocketagent.app.data.AdapterDescriptor
import com.pocketagent.app.data.ReasoningEffort
import com.pocketagent.app.ui.screens.accessLabel
import com.pocketagent.app.ui.screens.modelChipValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Was auf den Chips des Anlege-Screens steht. Beides sind reine Funktionen,
 * damit die Beschriftung prüfbar ist, ohne eine Oberfläche zu starten.
 */
class NewSessionChipsTest {

    /** Zugangsdaten im Adapter selbst — wie Claude Code. */
    private val claude = AdapterDescriptor(
        id = "claude",
        name = "Claude Code",
        capabilities = AdapterCapabilities(reasoning = true, modelSwitch = true),
        credentials = mapOf(
            "claude_oauth" to listOf("CLAUDE_CODE_OAUTH_TOKEN"),
            "anthropic" to listOf("ANTHROPIC_API_KEY"),
        ),
    )

    /** Zugang über Provider-Umgebungsvariablen — wie Kilo (OpenCode-Fork). */
    private val kilo = AdapterDescriptor(
        id = "kilo",
        name = "Kilo Code",
        providerEnv = mapOf("openai" to "OPENAI_API_KEY", "zai" to "ZHIPU_API_KEY"),
    )

    /* ---------------- accessLabel ---------------- */

    @Test
    fun `an oauth token reads as a subscription`() {
        assertEquals("Abo", accessLabel(claude, "claude_oauth"))
    }

    @Test
    fun `an api key reads as api`() {
        assertEquals("API", accessLabel(claude, "anthropic"))
        assertEquals("API", accessLabel(kilo, "openai"))
        assertEquals("API", accessLabel(kilo, "zai"))
    }

    @Test
    fun `an unknown provider carries no label`() {
        assertNull(accessLabel(claude, "deepseek"))
        assertNull(accessLabel(kilo, "claude_oauth"))
    }

    @Test
    fun `a blank provider carries no label`() {
        assertNull(accessLabel(claude, ""))
        assertNull(accessLabel(claude, "   "))
    }

    @Test
    fun `the provider is trimmed before it is looked up`() {
        assertEquals("Abo", accessLabel(claude, "  claude_oauth "))
    }

    /* ---------------- modelChipValue ---------------- */

    @Test
    fun `an empty model names the adapter default`() {
        assertEquals("Standardmodell", modelChipValue("", null, canReason = false))
        assertEquals("Standardmodell", modelChipValue("   ", null, canReason = true))
    }

    @Test
    fun `a chosen model stands alone without a reasoning level`() {
        assertEquals("Sonnet 5", modelChipValue("Sonnet 5", null, canReason = true))
    }

    @Test
    fun `a chosen reasoning level rides along behind the model`() {
        assertEquals(
            "Sonnet 5 · Hoch",
            modelChipValue("Sonnet 5", ReasoningEffort.HIGH, canReason = true),
        )
        assertEquals(
            "Standardmodell · Niedrig",
            modelChipValue("", ReasoningEffort.LOW, canReason = true),
        )
    }

    @Test
    fun `an agent without reasoning never shows a level`() {
        assertEquals(
            "Sonnet 5",
            modelChipValue("Sonnet 5", ReasoningEffort.HIGH, canReason = false),
        )
    }

    @Test
    fun `the model is trimmed`() {
        assertEquals("glm-5.3", modelChipValue("  glm-5.3  ", null, canReason = false))
    }
}
