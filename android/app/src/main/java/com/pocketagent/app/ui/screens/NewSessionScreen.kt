@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package com.pocketagent.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AdapterDescriptor
import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.ReasoningEffort
import com.pocketagent.app.data.RepoInfo
import com.pocketagent.app.ui.theme.CardInset
import com.pocketagent.app.ui.theme.ChipSpacing
import com.pocketagent.app.ui.theme.ComposerHeight
import com.pocketagent.app.ui.theme.ListItemTitle
import com.pocketagent.app.ui.theme.MinTouchTarget
import com.pocketagent.app.ui.theme.MotionMedium
import com.pocketagent.app.ui.theme.MotionShort
import com.pocketagent.app.ui.theme.OneUiEasing
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.PrimaryButtonHeight
import com.pocketagent.app.ui.theme.PrimaryButtonTextSize
import com.pocketagent.app.ui.theme.RadioRowDividerInset
import com.pocketagent.app.ui.theme.ScreenGutter
import com.pocketagent.app.ui.theme.SectionSpacing
import com.pocketagent.app.ui.theme.TileMinHeight
import com.pocketagent.app.ui.theme.semantic
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class NewSessionViewModel : ViewModel() {
    lateinit var repository: AppRepository

    data class UiState(
        val repoId: String? = null,
        val adapter: String = "",
        val provider: String = "",
        val model: String = "",
        val reasoning: ReasoningEffort? = null,
        val mode: AgentMode = AgentMode.AUTO,
        val branch: String = "",
        val networkPolicy: String = "allowlist",
        /** Optionaler erster Auftrag; leer heißt: nur die Session anlegen. */
        val prompt: String = "",
        val busy: Boolean = false,
        val error: String? = null,
        val createdSessionId: String? = null,
        /**
         * Die Session steht bereits, ihr erster Auftrag ging aber nicht raus.
         * Solange das gesetzt ist, legt der Knopf keine zweite Session an,
         * sondern schickt denselben Text noch einmal.
         */
        val pendingSessionId: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    fun update(transform: (UiState) -> UiState) {
        _state.value = transform(_state.value)
    }

    fun updatePrompt(text: String) {
        _state.value = _state.value.copy(prompt = text)
    }

    fun syncAdapterDefaults(adapters: List<AdapterDescriptor>) {
        val s = _state.value
        if (s.adapter.isBlank() && adapters.isNotEmpty()) {
            val first = adapters.first()
            _state.value = s.copy(adapter = first.id, provider = defaultProviderFor(first))
        }
    }

    /** Agentwechsel setzt Zugang und Modell auf den Standard des Adapters zurück. */
    fun onAdapterSelected(adapter: AdapterDescriptor) {
        _state.value = _state.value.copy(
            adapter = adapter.id,
            provider = defaultProviderFor(adapter),
            model = "",
            // Kann der neue Agent kein Reasoning, ist eine gewählte Stufe
            // gegenstandslos — sie darf nicht unsichtbar weiterwirken.
            reasoning = _state.value.reasoning.takeIf { adapter.capabilities.reasoning },
        )
    }

    /** Ergebnis des Modell-Sheets: Zugang, Modell und Stufe in einem Schritt. */
    fun onModelPicked(provider: String, model: String, reasoning: ReasoningEffort?) {
        _state.value = _state.value.copy(
            provider = provider.trim(),
            model = model.trim(),
            reasoning = reasoning,
        )
    }

    private fun defaultProviderFor(adapter: AdapterDescriptor): String =
        adapter.defaults.provider.ifBlank { adapter.providerEnv.keys.firstOrNull().orEmpty() }

    fun addRepo(fullName: String, defaultBranch: String) {
        viewModelScope.launch {
            repository.addRepo(fullName, defaultBranch).fold(
                onSuccess = { repo ->
                    _state.value = _state.value.copy(repoId = repo.id, error = null)
                },
                onFailure = { t -> _state.value = _state.value.copy(error = t.message) },
            )
        }
    }

    /**
     * Session anlegen und, wenn ein Auftrag im Feld steht, ihn gleich als
     * ersten Prompt hinterherschicken — denselben Weg, den auch der
     * SessionScreen geht. Der Vertrag bleibt unangetastet: erst
     * `session.create`, dann `session.prompt`.
     *
     * Geht der Prompt nicht raus, bleibt der Text stehen und der Screen sagt
     * es. Die Session existiert dann schon, deshalb merkt sich [UiState]
     * ihre Id: der nächste Tap wiederholt den Auftrag, statt eine zweite
     * Session anzulegen.
     */
    fun create() {
        val s = _state.value
        if (s.busy) return

        // Zweiter Anlauf für eine Session, die bereits steht.
        s.pendingSessionId?.let { sessionId ->
            _state.value = s.copy(busy = true, error = null)
            viewModelScope.launch { finish(sessionId) }
            return
        }

        val repoId = s.repoId ?: run {
            _state.value = s.copy(error = "Bitte ein Repository wählen")
            return
        }
        _state.value = s.copy(busy = true, error = null)
        viewModelScope.launch {
            // Vorher merken, was es schon gibt: so ist die neue Session die,
            // die vorher nicht da war — und nicht irgendeine mit demselben
            // Repo und Agenten.
            val known = repository.sessions.value.map { it.id }.toSet()
            val result = repository.createSession(
                repoId = repoId,
                adapter = s.adapter,
                provider = s.provider.trim(),
                model = s.model.trim(),
                mode = s.mode,
                branch = s.branch.trim().ifBlank { null },
                networkPolicy = s.networkPolicy,
            )
            val failure = result.exceptionOrNull()
            if (failure != null) {
                _state.value = _state.value.copy(busy = false, error = failure.message ?: "Fehler")
                return@launch
            }
            val matching = repository.sessions.value.filter { sess ->
                sess.repoId == repoId && sess.adapter == s.adapter
            }
            val created = matching.firstOrNull { it.id !in known } ?: matching.firstOrNull()
            if (created == null) {
                _state.value = _state.value.copy(
                    busy = false,
                    error = "Die Session wurde angelegt, ist aber noch nicht in der Liste. " +
                        "Sie erscheint gleich auf dem Startbildschirm.",
                )
                return@launch
            }
            finish(created.id)
        }
    }

    /**
     * Alles, was nach `session.create` noch zur Session gehört: die
     * Reasoning-Stufe, die der Anlege-Vertrag nicht kennt, und der optionale
     * erste Auftrag. Erst wenn beides steht, geht es weiter zur Session.
     */
    private suspend fun finish(sessionId: String) {
        val s = _state.value
        if (s.reasoning != null) {
            val failure = repository.updateSession(sessionId, reasoningEffort = s.reasoning)
                .exceptionOrNull()
            if (failure != null) {
                hold(
                    sessionId,
                    "Die Session läuft, die Reasoning-Stufe wurde nicht übernommen: " +
                        "${failure.message}.",
                )
                return
            }
        }
        val text = s.prompt.trim()
        if (text.isNotEmpty()) {
            // `session.prompt` wird inzwischen bestätigt: eine ausbleibende
            // Bestätigung zählt wie ein Fehlschlag, damit kein Auftrag still
            // verschwindet.
            val failure = repository.sendPrompt(sessionId, text, null).exceptionOrNull()
            if (failure != null) {
                hold(
                    sessionId,
                    "Die Session läuft, der Auftrag wurde nicht bestätigt: " +
                        "${failure.message}. Dein Text bleibt stehen, tippe erneut.",
                )
                return
            }
        }
        _state.value = _state.value.copy(
            busy = false,
            pendingSessionId = null,
            error = null,
            createdSessionId = sessionId,
        )
    }

    /**
     * Die Session steht, der Rest nicht. Hier bleiben und es sagen — ein
     * zweiter Tap darf keine zweite Session anlegen, also merkt sich der
     * Zustand die vorhandene.
     */
    private fun hold(sessionId: String, message: String) {
        _state.value = _state.value.copy(
            busy = false,
            pendingSessionId = sessionId,
            error = message,
        )
    }
}

/* ------------------------------------------------------------------ */
/* Provider display names                                              */
/* ------------------------------------------------------------------ */

/**
 * Anzeigenamen kommen aus dem Adapter-Manifest (`providers`). Die Tabelle
 * hier greift nur noch bei Adaptern ohne dieses Feld (ältere Server) und bei
 * frei eingetippten Providern.
 */
private fun fallbackProviderName(key: String): String = when (key) {
    "openai" -> "OpenAI"
    "anthropic" -> "Anthropic"
    "zai" -> "Z.AI"
    "moonshot" -> "Moonshot/Kimi"
    "kimi" -> "Kimi"
    "google" -> "Google Gemini"
    "groq" -> "Groq"
    "openrouter" -> "OpenRouter"
    "xai" -> "xAI"
    else -> key
}

private fun providerDisplayName(key: String, descriptor: AdapterDescriptor?): String =
    descriptor?.providers?.firstOrNull { it.id == key }?.name ?: fallbackProviderName(key)

/**
 * Provider keys in display order: default provider first, then the rest.
 * Quelle ist das Manifest (`providers`), sonst die Env-Tabelle.
 */
private fun orderedProviderKeys(descriptor: AdapterDescriptor): List<String> {
    val keys = descriptor.providers.map { it.id }
        .ifEmpty { descriptor.providerEnv.keys.toList() }
        .ifEmpty { descriptor.credentials.keys.toList() }
    val def = descriptor.defaults.provider
    return if (def.isNotBlank() && def in keys) {
        listOf(def) + keys.filterNot { it == def }
    } else {
        keys
    }
}

/**
 * True when a usable secret for this adapter exists (card-level status).
 * Auch der Agent-Wechsel im SessionScreen fragt hierüber.
 */
fun adapterKeyPresent(descriptor: AdapterDescriptor, secretKinds: Set<String>): Boolean = when {
    descriptor.credentials.isNotEmpty() -> descriptor.credentials.keys.any { it in secretKinds }
    descriptor.providerEnv.isNotEmpty() -> descriptor.providerEnv.keys.any { it in secretKinds }
    else -> true
}

/* ------------------------------------------------------------------ */
/* Was auf den Chips steht                                             */
/* ------------------------------------------------------------------ */

/**
 * Kurzkennzeichen der Zugangsart, wie es der Modell-Chip trägt: „Abo“ für
 * ein Abo-Token, „API“ für einen Schlüssel.
 *
 * Die Unterscheidung steht im Manifest in keinem eigenen Feld — nur die
 * Namen der Umgebungsvariablen verraten sie (`CLAUDE_CODE_OAUTH_TOKEN`
 * gegen `ANTHROPIC_API_KEY`). Also werden die gelesen, statt aus der
 * Provider-Id geraten zu werden.
 *
 * null heißt: diesen Zugang kennt der Adapter nicht (frei eingetippt) —
 * dann trägt der Chip kein Kennzeichen, statt eines zu erfinden.
 */
fun accessLabel(descriptor: AdapterDescriptor, provider: String): String? {
    val key = provider.trim()
    if (key.isBlank()) return null
    val envNames = descriptor.credentials[key]
        ?: descriptor.providerEnv[key]?.let { listOf(it) }
        ?: return null
    return if (envNames.any { it.contains("OAUTH", ignoreCase = true) }) "Abo" else "API"
}

/**
 * Was auf dem Modell-Chip steht: das Modell und — wenn der Agent Reasoning
 * kann und eine Stufe gewählt ist — die Stufe dahinter. Ohne Wahl bleibt es
 * beim Modell allein; „Standard“ dazuzuschreiben sagt nichts.
 */
fun modelChipValue(model: String, reasoning: ReasoningEffort?, canReason: Boolean): String {
    val name = model.trim().ifBlank { "Standardmodell" }
    return if (canReason && reasoning != null) {
        "$name · ${reasoningLabel(reasoning)}"
    } else {
        name
    }
}

/** Welches Sheet gerade über dem Anlege-Screen liegt. */
enum class NewSessionSheet { AGENT, MODEL, MODE, NETWORK, ADVANCED }

/**
 * Sichert das offene Sheet als seinen Namen statt als Enum-Wert — ein
 * Bundle kann kein `NewSessionSheet?` von sich aus tragen, ein leerer
 * String steht für „kein Sheet offen".
 */
private val NewSessionSheetSaver = Saver<NewSessionSheet?, String>(
    save = { it?.name.orEmpty() },
    restore = { name -> name.takeIf { it.isNotEmpty() }?.let(NewSessionSheet::valueOf) },
)

@Composable
fun NewSessionScreen(
    onCreated: (String) -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: NewSessionViewModel = viewModel { NewSessionViewModel().also { it.repository = repository } }
    val state by vm.state.collectAsState()
    val repos by repository.repos.collectAsState()
    val adapters by repository.adapters.collectAsState()
    val secrets by repository.secrets.collectAsState()

    // Halb getippter Repo-Name oder ein offenes Sheet darf ein Falten/Drehen
    // nicht verlieren — genau der Fall, den die One-UI-Foldable-Richtlinie
    // nennt.
    var showAddRepo by rememberSaveable { mutableStateOf(false) }
    var sheet by rememberSaveable(stateSaver = NewSessionSheetSaver) { mutableStateOf<NewSessionSheet?>(null) }

    LaunchedEffect(Unit) {
        repository.refreshRepos()
        repository.refreshSessions()
        repository.refreshAdapters()
        repository.loadSecrets()
    }
    LaunchedEffect(adapters) { vm.syncAdapterDefaults(adapters) }
    LaunchedEffect(state.createdSessionId) { state.createdSessionId?.let { onCreated(it) } }
    LaunchedEffect(repos) {
        if (repos.isNotEmpty() && state.repoId == null && repos.none { it.id == state.repoId }) {
            vm.update { it.copy(repoId = repos.first().id) }
        }
    }

    val secretKinds = remember(secrets) { secrets.map { it.kind }.toSet() }
    val selectedDescriptor = adapters.firstOrNull { it.id == state.adapter }
    val accessMissing = state.provider.trim().let { it.isNotBlank() && it !in secretKinds }

    OneUiScaffold(
        title = "Neue Session",
        onBack = onBack,
        bottomBar = {
            // Auftragsfeld und Startknopf sind ein Block: die Eingabe und die
            // Handlung, die sie auslöst, gehören zusammen und liegen beide im
            // Daumenbereich. Die Höhe kommt aus ComposerHeight, damit der
            // Block wie der Composer im SessionScreen liest.
            Surface(color = MaterialTheme.colorScheme.background, tonalElevation = 0.dp) {
                Column(modifier = Modifier.navigationBarsPadding().imePadding()) {
                    state.error?.let { SectionError(it) }
                    OutlinedTextField(
                        value = state.prompt,
                        onValueChange = vm::updatePrompt,
                        placeholder = { Text("Was soll gemacht werden? (optional)") },
                        maxLines = 4,
                        // Kein Pill: über mehrere Zeilen liest die weiche
                        // Ecke der Karten besser als ein langer Halbkreis.
                        shape = MaterialTheme.shapes.medium,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Sentences,
                            imeAction = ImeAction.Default,
                        ),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                            disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                            focusedBorderColor = Color.Transparent,
                            unfocusedBorderColor = Color.Transparent,
                            disabledBorderColor = Color.Transparent,
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = ScreenGutter)
                            .heightIn(min = ComposerHeight),
                    )
                    Button(
                        onClick = { vm.create() },
                        enabled = !state.busy && state.repoId != null,
                        shape = PillShape,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = ScreenGutter, end = ScreenGutter, top = 6.dp, bottom = 10.dp)
                            // min statt fest: bei 200% Textgröße darf der
                            // Button wachsen, statt die Beschriftung
                            // abzuschneiden.
                            .heightIn(min = PrimaryButtonHeight),
                    ) {
                        if (state.busy) {
                            CircularProgressIndicator(
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                        }
                        Text(
                            text = when {
                                state.busy -> "Session startet …"
                                // Die Session steht schon; ein zweiter Tap
                                // holt nur nach, was nicht durchkam.
                                state.pendingSessionId != null -> "Erneut versuchen"
                                else -> "Session starten"
                            },
                            fontSize = PrimaryButtonTextSize,
                        )
                    }
                }
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            /* -------- Chip-Zeile -------- */
            // Jede Einstellung ist ein Chip: der Wert steht drauf, die Auswahl
            // steckt im Sheet. Vier Listen à sechs Zeilen werden so zu zwei
            // Zeilen, ohne dass ein einziger Wert unsichtbar wird.
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(ChipSpacing),
                verticalArrangement = Arrangement.spacedBy(ChipSpacing),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = ScreenGutter, end = ScreenGutter, top = 4.dp),
            ) {
                SettingChip(
                    label = "Agent",
                    value = if (adapters.isEmpty()) {
                        "Lädt …"
                    } else {
                        adapterLabel(adapters, state.adapter)
                    },
                    enabled = adapters.isNotEmpty(),
                    onClick = { sheet = NewSessionSheet.AGENT },
                )
                selectedDescriptor?.let { descriptor ->
                    SettingChip(
                        label = "Modell",
                        value = modelChipValue(
                            model = state.model,
                            reasoning = state.reasoning,
                            canReason = descriptor.capabilities.reasoning,
                        ),
                        // Fehlt der Zugang, wird das Kennzeichen zur Warnung
                        // — ein eigenes Banner sagt nichts, was hier nicht
                        // schon steht.
                        tag = if (accessMissing) {
                            "Kein Zugang"
                        } else {
                            accessLabel(descriptor, state.provider)
                        },
                        tagWarning = accessMissing,
                        onClick = { sheet = NewSessionSheet.MODEL },
                    )
                }
                SettingChip(
                    label = "Autonomie",
                    value = modeLabel(state.mode),
                    onClick = { sheet = NewSessionSheet.MODE },
                )
                SettingChip(
                    label = "Netzwerk",
                    value = networkLabel(state.networkPolicy),
                    onClick = { sheet = NewSessionSheet.NETWORK },
                )
                SettingIconChip(
                    icon = Icons.Filled.Settings,
                    contentDescription = "Erweitert",
                    onClick = { sheet = NewSessionSheet.ADVANCED },
                )
            }

            // Der einzige Hinweis, der auf dem Screen bleibt: er gilt nicht
            // für einen Wert, sondern für die Kombination aus Agent und
            // Modus — und die sieht man nur hier zusammen.
            selectedDescriptor?.let { selected ->
                if (!selected.capabilities.approvals && state.mode != AgentMode.YOLO) {
                    SectionNote(
                        "${selected.name} kann nicht remote nachfragen – Ask und Accept Edits " +
                            "laufen bei diesem Agenten ohne Rückfragen durch.",
                    )
                }
            }

            /* -------- Repository -------- */
            SectionHeader("Repository")
            RepoSelector(
                repos = repos,
                selectedId = state.repoId,
                branchOverride = state.branch,
                onSelect = { id -> vm.update { it.copy(repoId = id) } },
                onAddRepo = { showAddRepo = true },
            )
            Spacer(modifier = Modifier.height(SectionSpacing))
        }
    }

    if (showAddRepo) {
        AddRepoDialog(
            onDismiss = { showAddRepo = false },
            onSave = { fullName, branch ->
                vm.addRepo(fullName, branch)
                showAddRepo = false
            },
        )
    }

    when (sheet) {
        null -> Unit

        NewSessionSheet.AGENT -> SettingSheet(title = "Agent", onDismiss = { sheet = null }) {
            // Erstauswahl statt Wechsel: hier gibt es noch keinen laufenden
            // Agenten, dessen Kontext verloren gehen könnte. Ein Tipp
            // genügt, deshalb kein Bestätigungsknopf.
            AgentPickList(
                adapters = adapters,
                picked = state.adapter,
                secretKinds = secretKinds,
                compact = false,
                onPick = { id ->
                    adapters.firstOrNull { it.id == id }?.let { vm.onAdapterSelected(it) }
                    sheet = null
                },
            )
        }

        NewSessionSheet.MODEL -> selectedDescriptor?.let { descriptor ->
            ModelAccessSheet(
                descriptor = descriptor,
                provider = state.provider,
                model = state.model,
                reasoning = state.reasoning,
                secretKinds = secretKinds,
                onDismiss = { sheet = null },
                onOpenSettings = onOpenSettings,
                onApply = { provider, model, reasoning ->
                    vm.onModelPicked(provider, model, reasoning)
                    sheet = null
                },
            )
        }

        NewSessionSheet.MODE -> ModeSheet(
            current = state.mode,
            title = "Autonomie",
            onDismiss = { sheet = null },
            onPick = { mode -> sheet = null; vm.update { it.copy(mode = mode) } },
        )

        NewSessionSheet.NETWORK -> NetworkSheet(
            current = state.networkPolicy,
            onDismiss = { sheet = null },
            onPick = { policy -> sheet = null; vm.update { it.copy(networkPolicy = policy) } },
        )

        NewSessionSheet.ADVANCED -> AdvancedSheet(
            branch = state.branch,
            defaultBranch = repos.firstOrNull { it.id == state.repoId }?.defaultBranch.orEmpty(),
            onBranchChange = { v -> vm.update { it.copy(branch = v) } },
            onDismiss = { sheet = null },
        )
    }
}

private fun networkLabel(policy: String): String = when (policy) {
    "isolated" -> "Isoliert"
    "open" -> "Offen"
    else -> "Allowlist"
}

/* ------------------------------------------------------------------ */
/* Modell + Zugang — eine Zeile, ein Sheet                             */
/* ------------------------------------------------------------------ */

/**
 * Zugang, Modell und — wo der Agent es kann — die Reasoning-Stufe: alles,
 * was am Modell hängt, in einem Sheet. Für dieselbe Entscheidung soll es
 * keine zweite Stelle geben.
 *
 * Eine durchsuchbare Modell-Liste gibt es hier bewusst nicht: der Katalog
 * kommt über `session.models.get` aus dem laufenden Shim, und der existiert
 * vor dem Anlegen noch nicht. Gesucht wird im Modell-Sheet der Session.
 */
@Composable
private fun ModelAccessSheet(
    descriptor: AdapterDescriptor,
    provider: String,
    model: String,
    reasoning: ReasoningEffort?,
    secretKinds: Set<String>,
    onDismiss: () -> Unit,
    onOpenSettings: () -> Unit,
    onApply: (provider: String, model: String, reasoning: ReasoningEffort?) -> Unit,
) {
    val known = remember(descriptor) { orderedProviderKeys(descriptor) }
    // „Anderer …“ ist gewählt, sobald der Provider nicht aus dem Manifest kommt.
    var custom by remember(provider) { mutableStateOf(provider.isNotBlank() && provider !in known) }
    var picked by remember(provider) { mutableStateOf(provider.takeIf { it in known }.orEmpty()) }
    var typed by remember(provider) { mutableStateOf(if (provider in known) "" else provider) }
    var modelInput by remember(model) { mutableStateOf(model) }
    var effort by remember(reasoning) { mutableStateOf(reasoning) }

    val effectiveProvider = (if (custom) typed else picked).trim()
    val keyMissing = effectiveProvider.isBlank() || effectiveProvider !in secretKinds

    SettingSheet(title = "Modell", onDismiss = onDismiss) {
        GroupCard {
            Column(
                modifier = Modifier
                    .heightIn(max = 320.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                known.forEach { key ->
                    SelectableTile(
                        title = providerDisplayName(key, descriptor),
                        subtitle = accessLabel(descriptor, key),
                        selected = !custom && picked == key,
                        onClick = { custom = false; picked = key },
                        trailing = if (key !in secretKinds) {
                            { DotLabel(color = semantic().warning, label = "Kein Zugang") }
                        } else {
                            null
                        },
                    )
                    ListDivider(RadioRowDividerInset)
                }
                SelectableTile(
                    title = "Anderer …",
                    subtitle = null,
                    selected = custom,
                    onClick = { custom = true },
                )
                AnimatedVisibility(
                    visible = custom,
                    // Explizite Spec statt der ungebremsten Spring-Vorgabe:
                    // Ortswechsel in MotionMedium, Ein-/Ausblenden in
                    // MotionShort, beide mit der One-UI-Kurve.
                    enter = expandVertically(tween(MotionMedium, easing = OneUiEasing)) +
                        fadeIn(tween(MotionShort, easing = LinearEasing)),
                    exit = shrinkVertically(tween(MotionMedium, easing = OneUiEasing)) +
                        fadeOut(tween(MotionShort, easing = LinearEasing)),
                ) {
                    OutlinedTextField(
                        value = typed,
                        onValueChange = { typed = it },
                        label = { Text("Provider-Id") },
                        placeholder = { Text("deepseek") },
                        singleLine = true,
                        shape = MaterialTheme.shapes.small,
                        keyboardOptions = KeyboardOptions(
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Ascii,
                            imeAction = ImeAction.Next,
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = CardInset, end = CardInset, bottom = 14.dp),
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(SectionSpacing))
        OutlinedTextField(
            value = modelInput,
            onValueChange = { modelInput = it },
            label = { Text("Modell (optional)") },
            placeholder = { Text("Standard des Agenten") },
            supportingText = {
                Text("Leer lassen für den Standard. Format je nach Agent, z. B. zai-coding/glm-5.3")
            },
            singleLine = true,
            shape = MaterialTheme.shapes.small,
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Done,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = ScreenGutter),
        )

        if (descriptor.capabilities.reasoning) {
            SectionHeader("Reasoning")
            ReasoningPickList(
                current = effort,
                onPick = { effort = it },
                onDefault = { effort = null },
            )
            SectionNote("Wird gesetzt, sobald die Session steht.")
        }

        if (keyMissing && effectiveProvider.isNotBlank()) {
            // Auswahl vorher übernehmen, damit sie den Abstecher überlebt.
            TextButton(
                onClick = { onApply(effectiveProvider, modelInput, effort); onOpenSettings() },
                shape = PillShape,
                modifier = Modifier
                    .padding(start = ScreenGutter)
                    .heightIn(min = MinTouchTarget),
            ) {
                Text("Zugang in Einstellungen hinterlegen")
            }
        }

        Button(
            onClick = { onApply(effectiveProvider, modelInput, effort) },
            enabled = effectiveProvider.isNotBlank(),
            shape = PillShape,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = ScreenGutter, vertical = 10.dp)
                .heightIn(min = PrimaryButtonHeight),
        ) {
            Text("Übernehmen")
        }
    }
}

/* ------------------------------------------------------------------ */
/* Netzwerk und Erweitert                                              */
/* ------------------------------------------------------------------ */

/**
 * Dieselben drei Regeln wie bisher auf dem Screen, Wort für Wort. Sie sind
 * sicherheitsrelevant, deshalb steht der gewählte Wert weiter sichtbar auf
 * einem Chip und nicht hinter dem Zahnrad.
 */
@Composable
private fun NetworkSheet(
    current: String,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    SettingSheet(title = "Netzwerk", onDismiss = onDismiss) {
        GroupCard {
            Column {
                val entries = listOf(
                    Triple("allowlist", "Allowlist", "Nur GitHub, KI-Anbieter und Paket-Registries (empfohlen)"),
                    Triple("isolated", "Isoliert", "Kein Internetzugriff – nur für lokale Aufgaben"),
                    Triple("open", "Offen", "Vollständiger Netzwerkzugriff wie lokal"),
                )
                entries.forEachIndexed { index, (policy, title, subtitle) ->
                    if (index > 0) ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = title,
                        subtitle = subtitle,
                        selected = current == policy,
                        onClick = { onPick(policy) },
                    )
                }
            }
        }
    }
}

/**
 * Was selten anders sein soll als der Standard. Der Branch wirkt sofort —
 * am Repository-Feld steht er als Untertitel, also braucht es hier keine
 * Bestätigung, die man auch vergessen könnte.
 */
@Composable
private fun AdvancedSheet(
    branch: String,
    defaultBranch: String,
    onBranchChange: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    SettingSheet(title = "Erweitert", onDismiss = onDismiss) {
        OutlinedTextField(
            value = branch,
            onValueChange = onBranchChange,
            label = { Text("Basis-Branch") },
            placeholder = { Text(defaultBranch.ifBlank { "Default-Branch des Repos" }) },
            singleLine = true,
            shape = MaterialTheme.shapes.small,
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Done,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = ScreenGutter),
        )
        SectionNote("Leer lassen für den Default-Branch des Repositories.")
    }
}

/* ------------------------------------------------------------------ */
/* Repos                                                               */
/* ------------------------------------------------------------------ */

@Composable
private fun RepoSelector(
    repos: List<RepoInfo>,
    selectedId: String?,
    branchOverride: String,
    onSelect: (String) -> Unit,
    onAddRepo: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = repos.firstOrNull { it.id == selectedId }

    Box {
        GroupCard {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = true }
                    .heightIn(min = TileMinHeight)
                    .padding(start = CardInset, end = 10.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = selected?.fullName ?: "Repository wählen",
                        style = ListItemTitle,
                        color = if (selected == null) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    selected?.let {
                        // Der Basis-Branch steht hier und nur hier. Wer ihn
                        // unter „Erweitert“ überschreibt, muss das Ergebnis
                        // sehen — sonst wäre die Eingabe unsichtbar.
                        Text(
                            text = "Basis: ${branchOverride.trim().ifBlank { it.defaultBranch }}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            if (repos.isEmpty()) {
                DropdownMenuItem(
                    text = { Text("Noch keine Repositories") },
                    enabled = false,
                    onClick = {},
                )
            }
            repos.forEach { repo ->
                DropdownMenuItem(
                    text = { Text(repo.fullName) },
                    onClick = { onSelect(repo.id); expanded = false },
                )
            }
            DropdownMenuItem(
                text = { Text("Repository hinzufügen", color = MaterialTheme.colorScheme.primary) },
                leadingIcon = {
                    Icon(
                        Icons.Filled.Add,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                },
                onClick = { expanded = false; onAddRepo() },
            )
        }
    }
}

/** Shared add-repository dialog. */
@Composable
fun AddRepoDialog(
    onDismiss: () -> Unit,
    onSave: (fullName: String, defaultBranch: String) -> Unit,
) {
    // Ein halb getippter Repo-Name darf ein Falten/Drehen überleben — das ist
    // der Fall, den die One-UI-Foldable-Richtlinie ausdrücklich nennt.
    var fullName by rememberSaveable { mutableStateOf("") }
    var branch by rememberSaveable { mutableStateOf("") }
    val valid = Regex("^[\\w.-]+/[\\w.-]+$").matches(fullName.trim())
    val effectiveBranch = branch.trim().ifEmpty { "main" }

    // Wahl- und Bestätigungsdialoge sitzen bei One UI unten, nicht in der
    // Bildmitte (one-ui/comp/dialog).
    OneUiDialog(
        onDismissRequest = onDismiss,
        title = "Repository hinzufügen",
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = fullName,
                    onValueChange = { fullName = it },
                    label = { Text("owner/repo") },
                    placeholder = { Text("robinrehbein/remote-control") },
                    singleLine = true,
                    shape = MaterialTheme.shapes.small,
                    isError = fullName.isNotBlank() && !valid,
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                        imeAction = ImeAction.Next,
                    ),
                    supportingText = if (fullName.isNotBlank() && !valid) {
                        { Text("Format: owner/repo") }
                    } else {
                        null
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = branch,
                    onValueChange = { branch = it },
                    label = { Text("Basis-Branch") },
                    placeholder = { Text("main") },
                    singleLine = true,
                    shape = MaterialTheme.shapes.small,
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                        imeAction = ImeAction.Done,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Private Repos brauchen zusätzlich einen GitHub-Zugang in den Einstellungen.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(fullName.trim(), effectiveBranch) }, enabled = valid) {
                Text("Hinzufügen")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}
