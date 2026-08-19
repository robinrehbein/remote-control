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
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.ModelInfo
import com.pocketagent.app.data.PI_DEFAULT_PROVIDER
import com.pocketagent.app.data.PI_PROVIDERS
import com.pocketagent.app.data.ReasoningEffort
import com.pocketagent.app.data.RepoInfo
import com.pocketagent.app.data.WsClient
import com.pocketagent.app.data.piProviderName
import com.pocketagent.app.ui.sheetPickListMaxHeight
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
        val provider: String = PI_DEFAULT_PROVIDER,
        /**
         * Hat der Nutzer den Zugang selbst gewählt? Nur dann darf die
         * Vorauswahl ihn nicht mehr überschreiben, wenn Zugänge nachladen.
         */
        val providerTouched: Boolean = false,
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

    /**
     * Nachziehen der Vorauswahl.
     *
     * Die Zugänge kommen asynchron nach. Solange der Nutzer selbst keinen
     * gewählt hat, darf die Vorauswahl sich noch korrigieren — sonst bliebe
     * ein Provider ohne Zugang stehen, nur weil die Liste der Zugänge einen
     * Wimpernschlag später eintraf.
     */
    fun syncProviderDefault(secretKinds: Set<String>) {
        val s = _state.value
        if (s.providerTouched || s.provider in secretKinds) return
        val better = preselectedProvider(secretKinds)
        if (better != s.provider) _state.value = s.copy(provider = better)
    }

    /** Ergebnis des Modell-Sheets: Zugang, Modell und Stufe in einem Schritt. */
    fun onModelPicked(provider: String, model: String, reasoning: ReasoningEffort?) {
        _state.value = _state.value.copy(
            provider = provider.trim(),
            providerTouched = true,
            model = model.trim(),
            reasoning = reasoning,
        )
    }


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
            // Vorher merken, was es schon gibt: Fällt die Id aus der
            // Bestätigung weg (alter Server), ist die neue Session die, die
            // vorher nicht da war — und nicht irgendeine mit demselben Repo.
            val known = repository.sessions.value.map { it.id }.toSet()
            val result = repository.createSession(
                repoId = repoId,
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
            // Der reguläre Weg: die Bestätigung nennt die Id der neuen Session.
            result.getOrNull()?.let { sessionId ->
                finish(sessionId)
                return@launch
            }
            val matching = repository.sessions.value.filter { sess -> sess.repoId == repoId }
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
/* Zugänge                                                             */
/* ------------------------------------------------------------------ */

/**
 * Welcher Zugang beim Anlegen vorgewählt wird.
 *
 * Der Server spielt nur den Schlüssel des **einen** gewählten Providers in
 * den Container. Ein Provider, für den kein Zugang hinterlegt ist, führt
 * damit zu einer Session, die ohne Schlüssel startet — auch wenn für einen
 * anderen längst einer da ist. Genau das passierte bei pi: die Tabelle nennt
 * `openai` als Standard, hinterlegt war aber Z.AI, und im Container fehlte
 * `ZAI_API_KEY`.
 *
 * Ein vorhandener Zugang schlägt deshalb den Standard. Die Reihenfolge
 * bleibt sonst die der Tabelle, damit die Wahl vorhersagbar ist; gibt es
 * nirgends einen Zugang, bleibt es beim Standard.
 */
fun preselectedProvider(secretKinds: Set<String>): String =
    PI_PROVIDERS.map { it.id }.firstOrNull { it in secretKinds } ?: PI_DEFAULT_PROVIDER

/* ------------------------------------------------------------------ */
/* Was auf den Chips steht                                             */
/* ------------------------------------------------------------------ */

/**
 * Was auf dem Modell-Chip steht: das Modell und — wenn eine Reasoning-Stufe
 * gewählt ist — die Stufe dahinter. Ohne Wahl bleibt es beim Modell allein;
 * „Standard“ dazuzuschreiben sagt nichts.
 */
fun modelChipValue(model: String, reasoning: ReasoningEffort?): String {
    val name = model.trim().ifBlank { "Standardmodell" }
    return if (reasoning != null) "$name · ${reasoningLabel(reasoning)}" else name
}

/** Welches Sheet gerade über dem Anlege-Screen liegt. */
enum class NewSessionSheet { MODEL, MODE, ADVANCED }

/**
 * Was auf dem "Erweitert"-Chip steht: "Standard", solange Netzwerk und
 * Basis-Branch beim jeweiligen Default liegen, sonst "Angepasst" — derselbe
 * Grundsatz wie bei der Session-Karte, die eine Netzwerk-Abweichung nur
 * zeigt, wenn es wirklich eine gibt (Fund: Netzwerk als Dauerpräsenz).
 */
fun advancedSummary(networkPolicy: String, branch: String): String =
    if (networkPolicy == "allowlist" && branch.isBlank()) "Standard" else "Angepasst"

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
    val secrets by repository.secrets.collectAsState()
    val knownModels by repository.knownModels.collectAsState()
    val connState by repository.connState.collectAsState()

    // Ohne Verbindung kann der Startknopf sein Versprechen nicht halten —
    // „Session starten“, das dann nach 15 Sekunden in „Keine Verbindung“
    // endet, ist schlechter als ein ehrlich deaktivierter Knopf plus die
    // Verbindungszeile, die sagt, was gerade los ist (und neu verbindet).
    val connected = connState is WsClient.ConnState.Connected

    // Halb getippter Repo-Name oder ein offenes Sheet darf ein Falten/Drehen
    // nicht verlieren — genau der Fall, den die One-UI-Foldable-Richtlinie
    // nennt.
    var showAddRepo by rememberSaveable { mutableStateOf(false) }
    var sheet by rememberSaveable(stateSaver = NewSessionSheetSaver) { mutableStateOf<NewSessionSheet?>(null) }

    // Vor den Effekten: die Vorauswahl des Zugangs hängt davon ab, welche
    // Zugänge es gibt, und die laden asynchron nach.
    val secretKinds = remember(secrets) { secrets.map { it.kind }.toSet() }

    LaunchedEffect(Unit) {
        repository.refreshRepos()
        repository.refreshSessions()
        repository.loadSecrets()
    }
    LaunchedEffect(secretKinds) { vm.syncProviderDefault(secretKinds) }
    LaunchedEffect(state.createdSessionId) { state.createdSessionId?.let { onCreated(it) } }
    LaunchedEffect(repos) {
        if (repos.isNotEmpty() && state.repoId == null && repos.none { it.id == state.repoId }) {
            vm.update { it.copy(repoId = repos.first().id) }
        }
    }

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
                        enabled = !state.busy && state.repoId != null && connected,
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
                                !connected -> "Warte auf Verbindung …"
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
            // Dieselbe ehrliche Verbindungszeile wie auf der Liste — hier
            // steht sie direkt über dem, was sie betrifft: den Startknopf.
            AnimatedVisibility(
                visible = !connected,
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                ConnectionLine(state = connState, onReconnect = { repository.reconnectNow() })
            }

            /* -------- Chip-Zeile -------- */
            // Jede Einstellung ist ein Chip: der Wert steht drauf, die Auswahl
            // steckt im Sheet. Drei Listen werden so zu einer Zeile, ohne dass
            // ein einziger Wert unsichtbar wird.
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(ChipSpacing),
                verticalArrangement = Arrangement.spacedBy(ChipSpacing),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = ScreenGutter, end = ScreenGutter, top = 4.dp),
            ) {
                SettingChip(
                    label = "Modell",
                    value = modelChipValue(model = state.model, reasoning = state.reasoning),
                    // Fehlt der Zugang, sagt das Kennzeichen es hier — ein
                    // eigenes Banner sagt nichts, was hier nicht schon steht.
                    tag = if (accessMissing) "Kein Zugang" else piProviderName(state.provider),
                    tagWarning = accessMissing,
                    onClick = { sheet = NewSessionSheet.MODEL },
                )
                SettingChip(
                    label = "Autonomie",
                    value = modeLabel(state.mode),
                    onClick = { sheet = NewSessionSheet.MODE },
                )
                // Netzwerk und Basis-Branch sind sicherheitsrelevant, aber
                // ihr Default ist der empfohlene Fall — sie stehen darum
                // nicht mehr gleichrangig neben Modell/Autonomie,
                // sondern hinter einem benannten Chip statt einem anonymen
                // Zahnrad (Fund: "'Erweitert' hinter anonymem Icon-Chip").
                // Weicht die Wahl vom Default ab, sagt der Wert das.
                SettingChip(
                    label = "Erweitert",
                    value = advancedSummary(state.networkPolicy, state.branch),
                    onClick = { sheet = NewSessionSheet.ADVANCED },
                )
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

        NewSessionSheet.MODEL -> ModelAccessSheet(
            provider = state.provider,
            model = state.model,
            reasoning = state.reasoning,
            secretKinds = secretKinds,
            knownModels = knownModels,
            onDismiss = { sheet = null },
            onOpenSettings = onOpenSettings,
            onApply = { provider, model, reasoning ->
                vm.onModelPicked(provider, model, reasoning)
                sheet = null
            },
        )

        NewSessionSheet.MODE -> ModeSheet(
            current = state.mode,
            onDismiss = { sheet = null },
            onPick = { mode -> sheet = null; vm.update { it.copy(mode = mode) } },
        )

        NewSessionSheet.ADVANCED -> AdvancedSheet(
            branch = state.branch,
            defaultBranch = repos.firstOrNull { it.id == state.repoId }?.defaultBranch.orEmpty(),
            onBranchChange = { v -> vm.update { it.copy(branch = v) } },
            networkPolicy = state.networkPolicy,
            onNetworkChange = { policy -> vm.update { it.copy(networkPolicy = policy) } },
            onDismiss = { sheet = null },
        )
    }
}

/* ------------------------------------------------------------------ */
/* Modell + Zugang — eine Zeile, ein Sheet                             */
/* ------------------------------------------------------------------ */

/**
 * Zugang, Modell und Reasoning-Stufe: alles, was am Modell hängt, in einem
 * Sheet. Für dieselbe Entscheidung soll es keine zweite Stelle geben.
 *
 * Der echte Modell-Katalog kommt erst über `session.models.get` aus dem
 * laufenden Runner, und der existiert vor dem Anlegen noch nicht —
 * [knownModels] ist darum kein vollständiger, garantiert aktueller Katalog,
 * sondern ein Cache aus der letzten Session (Fund: "Modell beim Anlegen nur
 * Freitext mit Format-Raten"). Gibt es noch keinen (erster Start überhaupt),
 * bleibt es beim Freitext — bewusst ohne eine konkrete Modell-Id als
 * Beispiel, die im nächsten pi-Release schon veraltet wäre.
 */
@Composable
private fun ModelAccessSheet(
    provider: String,
    model: String,
    reasoning: ReasoningEffort?,
    secretKinds: Set<String>,
    knownModels: List<ModelInfo>,
    onDismiss: () -> Unit,
    onOpenSettings: () -> Unit,
    onApply: (provider: String, model: String, reasoning: ReasoningEffort?) -> Unit,
) {
    val known = remember { PI_PROVIDERS.map { it.id } }
    // „Anderer …“ ist gewählt, sobald der Provider nicht aus der Tabelle kommt.
    var custom by remember(provider) { mutableStateOf(provider.isNotBlank() && provider !in known) }
    var picked by remember(provider) { mutableStateOf(provider.takeIf { it in known }.orEmpty()) }
    var typed by remember(provider) { mutableStateOf(if (provider in known) "" else provider) }
    var modelInput by remember(model) { mutableStateOf(model) }
    // "Eigenes Modell" ist gewählt, sobald der aktuelle Wert nicht aus dem
    // Cache stammt — genau wie beim Zugang oben (custom/picked/typed).
    var modelCustom by remember(model, knownModels) {
        mutableStateOf(model.isNotBlank() && knownModels.none { it.id == model })
    }
    var effort by remember(reasoning) { mutableStateOf(reasoning) }

    val effectiveProvider = (if (custom) typed else picked).trim()
    val keyMissing = effectiveProvider.isBlank() || effectiveProvider !in secretKinds

    SettingSheet(
        title = "Modell",
        onDismiss = onDismiss,
        // „Übernehmen" schließt das Sheet und ist damit die einzige Aktion,
        // ohne die die Eingaben verfallen. Sie gehört an den festen Rand, nicht
        // ans Ende einer Scrollfläche unter zwei Listen und zwei Textfeldern.
        actions = {
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
        },
    ) {
        GroupCard {
            Column(
                modifier = Modifier
                    .heightIn(max = sheetPickListMaxHeight())
                    .verticalScroll(rememberScrollState()),
            ) {
                PI_PROVIDERS.forEach { entry ->
                    val key = entry.id
                    SelectableTile(
                        title = entry.name,
                        subtitle = entry.hint,
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
        SectionHeader("Modell")
        if (knownModels.isNotEmpty()) {
            GroupCard {
                Column(
                    // Etwas knapper als die Provider-Liste darüber: zwei
                    // Listen mit voller Höhe im selben Sheet ließen für den
                    // Rest nichts übrig.
                    modifier = Modifier
                        .heightIn(max = sheetPickListMaxHeight(preferred = 260.dp))
                        .verticalScroll(rememberScrollState()),
                ) {
                    SelectableTile(
                        title = "Standard des Agenten",
                        subtitle = "Modellwahl dem Agenten überlassen",
                        selected = !modelCustom && modelInput.isBlank(),
                        onClick = { modelCustom = false; modelInput = "" },
                    )
                    knownModels.forEach { m ->
                        ListDivider(RadioRowDividerInset)
                        SelectableTile(
                            title = m.name ?: m.id,
                            subtitle = m.id,
                            selected = !modelCustom && modelInput == m.id,
                            onClick = { modelCustom = false; modelInput = m.id },
                        )
                    }
                    ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = "Eigenes Modell …",
                        subtitle = null,
                        selected = modelCustom,
                        onClick = { modelCustom = true },
                    )
                }
            }
            SectionNote(
                "Vorschläge aus einer früheren Session – nicht zwingend vollständig oder aktuell.",
            )
        } else {
            SectionNote(
                "Noch keine Modell-Vorschläge – sie erscheinen nach der ersten Session. " +
                    "Leer lassen für den Standard des Agenten.",
            )
        }
        AnimatedVisibility(
            visible = modelCustom || knownModels.isEmpty(),
            enter = expandVertically(tween(MotionMedium, easing = OneUiEasing)) +
                fadeIn(tween(MotionShort, easing = LinearEasing)),
            exit = shrinkVertically(tween(MotionMedium, easing = OneUiEasing)) +
                fadeOut(tween(MotionShort, easing = LinearEasing)),
        ) {
            Column {
                OutlinedTextField(
                    value = modelInput,
                    onValueChange = { modelInput = it },
                    label = { Text("Eigenes Modell") },
                    // Bewusst keine konkrete Modell-Id als Beispiel (Fund:
                    // "keine Modell-IDs hart in den Code schreiben") — die
                    // Vorschlagsliste oben zeigt echte, wenn welche da sind.
                    placeholder = { Text("z. B. anbieter/modell") },
                    singleLine = true,
                    shape = MaterialTheme.shapes.small,
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                        imeAction = ImeAction.Done,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = ScreenGutter, vertical = 4.dp),
                )
                SectionNote("Leer lassen für den Standard. Format je nach Agent unterschiedlich.")
            }
        }

        SectionHeader("Reasoning")
        ReasoningPickList(
            current = effort,
            onPick = { effort = it },
            onDefault = { effort = null },
        )
        SectionNote("Wird gesetzt, sobald die Session steht.")

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
    }
}

/* ------------------------------------------------------------------ */
/* Netzwerk und Erweitert                                              */
/* ------------------------------------------------------------------ */

/**
 * Was selten anders sein soll als der Standard: Netzwerk und Basis-Branch,
 * seit diesem Fund gemeinsam hinter „Erweitert" statt Netzwerk gleichrangig
 * neben Agent/Modell/Autonomie zu zeigen (Fund: „Netzwerk als
 * Dauerpräsenz"). Beide wirken sofort, keine Bestätigung nötig — der
 * Erweitert-Chip selbst sagt schon, ob von einem Default abgewichen wurde
 * (siehe [advancedSummary]).
 */
@Composable
private fun AdvancedSheet(
    branch: String,
    defaultBranch: String,
    onBranchChange: (String) -> Unit,
    networkPolicy: String,
    onNetworkChange: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    SettingSheet(title = "Erweitert", onDismiss = onDismiss) {
        SectionHeader("Netzwerk")
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
                        selected = networkPolicy == policy,
                        onClick = { onNetworkChange(policy) },
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(SectionSpacing))
        SectionHeader("Basis-Branch")
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
    // Bottom Sheet statt Dropdown (Fund: "Repository-Auswahl als DropdownMenu
    // bricht das Sheet-Idiom") — dasselbe Muster wie jede andere Auswahl der
    // App (Agent, Modell, Autonomie, Netzwerk): GroupCard + SelectableTile,
    // auf großen Displays erreichbar statt als schmales Menü am oberen Rand.
    var sheetOpen by rememberSaveable { mutableStateOf(false) }
    val selected = repos.firstOrNull { it.id == selectedId }

    GroupCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { sheetOpen = true }
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

    if (sheetOpen) {
        SettingSheet(title = "Repository", onDismiss = { sheetOpen = false }) {
            GroupCard {
                Column(
                    modifier = Modifier
                        .heightIn(max = sheetPickListMaxHeight())
                        .verticalScroll(rememberScrollState()),
                ) {
                    if (repos.isEmpty()) {
                        Text(
                            text = "Noch keine Repositories",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = CardInset, vertical = 12.dp),
                        )
                        ListDivider(RadioRowDividerInset)
                    }
                    repos.forEachIndexed { index, repo ->
                        if (index > 0) ListDivider(RadioRowDividerInset)
                        SelectableTile(
                            title = repo.fullName,
                            subtitle = "Basis: ${repo.defaultBranch}",
                            selected = repo.id == selectedId,
                            onClick = { onSelect(repo.id); sheetOpen = false },
                        )
                    }
                    // Repository hinzufügen als AddRow im Sheet, statt als
                    // letzter Menüpunkt eines Dropdowns.
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { sheetOpen = false; onAddRepo() }
                            .heightIn(min = TileMinHeight)
                            .padding(start = CardInset, end = CardInset),
                    ) {
                        Icon(
                            Icons.Filled.Add,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(modifier = Modifier.width(14.dp))
                        Text(
                            text = "Repository hinzufügen",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
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
