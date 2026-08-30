package com.pocketagent.app.data

/**
 * Ein Zugang, den pi kennen kann. [id] ist zugleich die Secret-Art im
 * Server-Vault und der `provider`-Wert im Protokoll; [envVar] ist nur
 * dokumentarisch (der Server baut die Umgebung selbst).
 */
data class PiProvider(
    val id: String,
    val name: String,
    val envVar: String,
    val keyUrl: String,
    val hint: String,
)

/**
 * Die feste Provider-Tabelle von pi — dieselbe Quelle, aus der der Server
 * seine Umgebung baut (`shims/pi/adapter.json` in v1, ab v2 eine geteilte
 * Konstante). Sie kommt bewusst nicht mehr vom Server: es gibt nur noch
 * einen Agenten, und eine Liste, die zur Laufzeit nachlädt, hieße nur, dass
 * jeder Screen einen Ladezustand für etwas Unveränderliches braucht.
 *
 * Die Reihenfolge ist die Anzeigereihenfolge; der erste Eintrag ist der
 * Standard-Zugang ([PI_DEFAULT_PROVIDER]).
 */
val PI_PROVIDERS: List<PiProvider> = listOf(
    PiProvider(
        id = "openai",
        name = "OpenAI",
        envVar = "OPENAI_API_KEY",
        keyUrl = "https://platform.openai.com/api-keys",
        hint = "API-Key von platform.openai.com (sk-…)",
    ),
    PiProvider(
        id = "zai",
        name = "Z.AI",
        envVar = "ZAI_API_KEY",
        keyUrl = "https://z.ai/manage-apikey/apikey-list",
        hint = "API-Key aus dem Z.AI-Dashboard",
    ),
    PiProvider(
        id = "moonshot",
        name = "Moonshot",
        envVar = "KIMI_API_KEY",
        keyUrl = "https://platform.moonshot.ai/console/api-keys",
        hint = "API-Key von platform.moonshot.ai",
    ),
    // Eigener Eintrag trotz derselben Umgebungsvariable wie Moonshot: der
    // Server spielt den Schlüssel der *gewählten* Provider-Id in den
    // Container. Würden beide Ids hier zu einer Zeile verschmelzen, startete
    // eine Session mit Provider "kimi" ohne Schlüssel, obwohl unter
    // "moonshot" längst einer liegt.
    PiProvider(
        id = "kimi",
        name = "Kimi",
        envVar = "KIMI_API_KEY",
        keyUrl = "https://platform.moonshot.ai/console/api-keys",
        hint = "API-Key von platform.moonshot.ai (gleicher Key wie Moonshot)",
    ),
    PiProvider(
        id = "anthropic",
        name = "Anthropic",
        envVar = "ANTHROPIC_API_KEY",
        keyUrl = "https://console.anthropic.com/settings/keys",
        hint = "API-Key von console.anthropic.com (sk-ant-…)",
    ),
    PiProvider(
        id = "google",
        name = "Google Gemini",
        envVar = "GEMINI_API_KEY",
        keyUrl = "https://aistudio.google.com/apikey",
        hint = "API-Key aus Google AI Studio",
    ),
)

/** Vorauswahl, solange kein Zugang hinterlegt ist (`defaults.provider` von pi). */
val PI_DEFAULT_PROVIDER: String = PI_PROVIDERS.first().id

fun piProvider(id: String): PiProvider? = PI_PROVIDERS.firstOrNull { it.id == id.trim() }

/** Anzeigename eines Zugangs; ein frei eingetippter behält seine Id. */
fun piProviderName(id: String): String = piProvider(id)?.name ?: id
