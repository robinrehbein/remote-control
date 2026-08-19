package com.pocketagent.app

import com.pocketagent.app.data.PI_DEFAULT_PROVIDER
import com.pocketagent.app.data.PI_PROVIDERS
import com.pocketagent.app.ui.screens.preselectedProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Welcher Zugang beim Anlegen vorgewählt wird.
 *
 * Der Server spielt nur den Schlüssel des einen gewählten Providers in den
 * Container. Ein Standard, für den kein Zugang hinterlegt ist, erzeugt
 * deshalb eine Session ohne Schlüssel — auch wenn für einen anderen längst
 * einer da ist.
 */
class ProviderPreselectTest {

    @Test
    fun `a stored access beats the default`() {
        // Der gemeldete Fall: Z.AI hinterlegt, Standard ist openai. Ohne diese
        // Regel startet der Container ohne ZAI_API_KEY.
        assertEquals("zai", preselectedProvider(setOf("zai")))
    }

    @Test
    fun `the default wins when it has an access itself`() {
        assertEquals("openai", preselectedProvider(setOf("openai", "zai")))
    }

    @Test
    fun `without any access it stays on the default`() {
        // Nichts hinterlegt: die Warnung am Chip ist dann die richtige
        // Antwort, nicht eine willkürlich andere Vorauswahl.
        assertEquals(PI_DEFAULT_PROVIDER, preselectedProvider(emptySet()))
        assertEquals("openai", PI_DEFAULT_PROVIDER)
    }

    @Test
    fun `an unrelated access does not change the choice`() {
        assertEquals("openai", preselectedProvider(setOf("github")))
    }

    @Test
    fun `the table order decides between several stored accesses`() {
        // zai steht in der pi-Tabelle vor anthropic, also gewinnt zai — die
        // Wahl soll vorhersagbar sein, nicht von der Reihenfolge der
        // hinterlegten Zugänge abhängen.
        assertEquals("zai", preselectedProvider(setOf("anthropic", "zai")))
    }

    /**
     * Die Tabelle ist die von pi (`shims/pi/adapter.json` in v1): sechs
     * Zugänge, openai zuerst. Moonshot und Kimi bleiben zwei Einträge —
     * serverseitig sind es zwei Provider-Ids, auch wenn beide auf dieselbe
     * Umgebungsvariable zeigen.
     */
    @Test
    fun `the provider table is the pi table`() {
        assertEquals(
            listOf("openai", "zai", "moonshot", "kimi", "anthropic", "google"),
            PI_PROVIDERS.map { it.id },
        )
        assertEquals("Google Gemini", PI_PROVIDERS.last().name)
        assertEquals("KIMI_API_KEY", PI_PROVIDERS.first { it.id == "kimi" }.envVar)
        assertTrue(PI_PROVIDERS.all { it.keyUrl.startsWith("https://") && it.hint.isNotBlank() })
    }
}
