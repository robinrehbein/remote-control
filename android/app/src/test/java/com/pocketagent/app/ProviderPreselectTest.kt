package com.pocketagent.app

import com.pocketagent.app.data.AdapterDefaults
import com.pocketagent.app.data.AdapterDescriptor
import com.pocketagent.app.data.ProviderDescriptor
import com.pocketagent.app.ui.screens.preselectedProvider
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Welcher Zugang beim Anlegen vorgewählt wird.
 *
 * Der Server spielt nur den Schlüssel des einen gewählten Providers in den
 * Container. Ein Default aus dem Manifest, für den kein Zugang hinterlegt
 * ist, erzeugt deshalb eine Session ohne Schlüssel — auch wenn für einen
 * anderen Provider desselben Agenten längst einer da ist.
 */
class ProviderPreselectTest {

    /** pi: Manifest-Default ist openai, kann aber auch zai und andere. */
    private val pi = AdapterDescriptor(
        id = "pi",
        name = "pi",
        providerEnv = mapOf(
            "openai" to "OPENAI_API_KEY",
            "zai" to "ZAI_API_KEY",
            "anthropic" to "ANTHROPIC_API_KEY",
        ),
        providers = listOf(
            ProviderDescriptor(id = "openai", name = "OpenAI"),
            ProviderDescriptor(id = "zai", name = "Z.AI"),
            ProviderDescriptor(id = "anthropic", name = "Anthropic"),
        ),
        defaults = AdapterDefaults(provider = "openai"),
    )

    @Test
    fun `a stored access beats the manifest default`() {
        // Der gemeldete Fall: Z.AI hinterlegt, Default ist openai. Ohne diese
        // Regel startet der Container ohne ZAI_API_KEY.
        assertEquals("zai", preselectedProvider(pi, setOf("zai")))
    }

    @Test
    fun `the manifest default wins when it has an access itself`() {
        assertEquals("openai", preselectedProvider(pi, setOf("openai", "zai")))
    }

    @Test
    fun `without any access it stays on the manifest default`() {
        // Nichts hinterlegt: die Warnung am Chip ist dann die richtige
        // Antwort, nicht eine willkürlich andere Vorauswahl.
        assertEquals("openai", preselectedProvider(pi, emptySet()))
    }

    @Test
    fun `an unrelated access does not change the choice`() {
        assertEquals("openai", preselectedProvider(pi, setOf("github", "kilo")))
    }

    @Test
    fun `the manifest order decides between several stored accesses`() {
        // zai steht im Manifest vor anthropic, also gewinnt zai — die Wahl
        // soll vorhersagbar sein, nicht von der Reihenfolge der Zugänge
        // abhängen.
        assertEquals("zai", preselectedProvider(pi, setOf("anthropic", "zai")))
    }

    @Test
    fun `an adapter with its own credentials picks the stored kind`() {
        // Claude Code: kein providerEnv, dafür credentials. Liegt nur das
        // Abo-Token vor, darf nicht der API-Zugang vorgewählt sein.
        val claude = AdapterDescriptor(
            id = "claude",
            name = "Claude Code",
            credentials = mapOf(
                "claude_oauth" to listOf("CLAUDE_CODE_OAUTH_TOKEN"),
                "anthropic" to listOf("ANTHROPIC_API_KEY"),
            ),
            providers = listOf(
                ProviderDescriptor(id = "claude_oauth", name = "Claude Abo (Setup-Token)"),
                ProviderDescriptor(id = "anthropic", name = "Anthropic"),
            ),
            defaults = AdapterDefaults(provider = "anthropic"),
        )
        assertEquals("claude_oauth", preselectedProvider(claude, setOf("claude_oauth")))
        assertEquals("anthropic", preselectedProvider(claude, setOf("anthropic", "claude_oauth")))
    }
}
