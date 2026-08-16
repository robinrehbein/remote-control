@file:OptIn(ExperimentalMaterial3Api::class)

package com.pocketagent.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Difference
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AdapterCapabilities
import com.pocketagent.app.data.AdapterDescriptor
import com.pocketagent.app.data.AgentEvent
import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.ModelInfo
import com.pocketagent.app.data.PermissionDecision
import com.pocketagent.app.data.ReasoningEffort
import com.pocketagent.app.data.SessionInfo
import com.pocketagent.app.data.SessionStatus
import com.pocketagent.app.data.StartPhase
import com.pocketagent.app.data.wireName
import com.pocketagent.app.ui.components.MarkdownText
import com.pocketagent.app.ui.theme.CardInset
import com.pocketagent.app.ui.theme.ContentInset
import com.pocketagent.app.ui.theme.MinTouchTarget
import com.pocketagent.app.ui.theme.MonoMedium
import com.pocketagent.app.ui.theme.MonoSmall
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.PrimaryButtonHeight
import com.pocketagent.app.ui.theme.RadioRowDividerInset
import com.pocketagent.app.ui.theme.ScreenGutter
import com.pocketagent.app.ui.theme.semantic
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/* ------------------------------------------------------------------ */
/* Timeline model                                                      */
/* ------------------------------------------------------------------ */

sealed interface TimelineItem {
    data class Chat(
        val role: String,
        val text: String,
    ) : TimelineItem

    data class Tool(
        val id: String,
        val tool: String,
        val title: String?,
        val input: kotlinx.serialization.json.JsonElement?,
        val result: AgentEvent.ToolResult?,
    ) : TimelineItem

    data class Approval(
        val permissionId: String,
        val kind: String,
        val title: String,
        val detail: String?,
        val diff: String?,
        val resolved: PermissionDecision?,
    ) : TimelineItem

    data class TurnEnd(
        val summary: String?,
        val commitSha: String?,
    ) : TimelineItem

    data class Pushed(
        val branch: String,
        val prUrl: String?,
        val auto: Boolean,
    ) : TimelineItem

    data class Error(val message: String) : TimelineItem

    /** Systemhinweis des Servers, z. B. Image-Build oder Agent-Wechsel. */
    data class Notice(val text: String) : TimelineItem
}

/**
 * Was gerade beim Start passiert — immer nur der jüngste Stand, nie ein
 * Verlauf. [phase] ist null, solange der Server noch nichts gemeldet hat.
 */
data class StartProgress(
    val message: String,
    val phase: StartPhase? = null,
    val detail: String? = null,
)

/** Ladezustand des Modellkatalogs (session.models.get). */
sealed interface ModelsState {
    data object Idle : ModelsState
    data object Loading : ModelsState
    data class Loaded(val models: List<ModelInfo>) : ModelsState
    data class Failed(val message: String) : ModelsState
}

class SessionViewModel : ViewModel() {
    lateinit var repository: AppRepository
    var sessionId: String = ""

    private val _items = MutableStateFlow<List<TimelineItem>>(emptyList())
    val items: StateFlow<List<TimelineItem>> = _items

    private val _session = MutableStateFlow<SessionInfo?>(null)
    val session: StateFlow<SessionInfo?> = _session

    private val _input = MutableStateFlow("")
    val input: StateFlow<String> = _input

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    /** Fortschritt des laufenden Starts; null, sobald nichts mehr startet. */
    private val _progress = MutableStateFlow<StartProgress?>(null)
    val progress: StateFlow<StartProgress?> = _progress

    private val _deleted = MutableStateFlow(false)
    val deleted: StateFlow<Boolean> = _deleted

    private val _adapters = MutableStateFlow<List<AdapterDescriptor>>(emptyList())
    val adapters: StateFlow<List<AdapterDescriptor>> = _adapters

    private val _models = MutableStateFlow<ModelsState>(ModelsState.Idle)
    val models: StateFlow<ModelsState> = _models

    /** Capabilities des Adapters dieser Session (leer, solange nichts geladen ist). */
    val capabilities: StateFlow<AdapterCapabilities> =
        combine(_session, _adapters) { session, adapters ->
            adapters.firstOrNull { it.id == session?.adapter }?.capabilities ?: AdapterCapabilities()
        }.stateIn(viewModelScope, SharingStarted.Eagerly, AdapterCapabilities())

    fun bind(id: String, repo: AppRepository) {
        if (sessionId == id) return
        sessionId = id
        repository = repo
        viewModelScope.launch {
            repository.sessions.collect { list ->
                val current = list.firstOrNull { it.id == id }
                _session.value = current
                // Sobald die Session nicht mehr startet, ist der Fortschritt
                // erledigt — ein späterer Start beginnt wieder bei null.
                if (current != null && current.status != SessionStatus.CREATING) _progress.value = null
            }
        }
        viewModelScope.launch {
            repository.sessionEvents.collect { envelope ->
                if (envelope.sessionId == id) applyEvent(envelope.event)
            }
        }
        viewModelScope.launch {
            repository.adapters.collect { list -> _adapters.value = list }
        }
        viewModelScope.launch { repository.refreshSessions() }
        viewModelScope.launch { if (repository.adapters.value.isEmpty()) repository.refreshAdapters() }
    }

    private fun applyEvent(event: AgentEvent) {
        when (event) {
            is AgentEvent.MessageCompleted -> append(TimelineItem.Chat(event.role, event.text))

            is AgentEvent.ToolCall -> append(
                TimelineItem.Tool(
                    id = event.id,
                    tool = event.tool,
                    title = event.title,
                    input = event.input,
                    result = null,
                )
            )

            is AgentEvent.ToolResult -> {
                _items.value = _items.value.map { item ->
                    if (item is TimelineItem.Tool && item.id == event.id) item.copy(result = event) else item
                }
            }

            is AgentEvent.PermissionRequest -> append(
                TimelineItem.Approval(
                    permissionId = event.permissionId,
                    kind = event.kind.name.lowercase(),
                    title = event.title,
                    detail = event.detail,
                    diff = event.diff,
                    resolved = null,
                )
            )

            is AgentEvent.PermissionResolved -> {
                _items.value = _items.value.map { item ->
                    if (item is TimelineItem.Approval && item.permissionId == event.permissionId) {
                        item.copy(resolved = event.decision)
                    } else item
                }
            }

            is AgentEvent.TurnCompleted -> append(TimelineItem.TurnEnd(event.summary, event.commitSha))
            is AgentEvent.Pushed -> append(TimelineItem.Pushed(event.branch, event.prUrl, event.auto))

            // Ein Fehler beendet den Start: er wird als Karte gezeigt, die
            // Fortschrittsanzeige hat dann nichts mehr zu melden.
            is AgentEvent.TurnFailed -> {
                _progress.value = null
                append(TimelineItem.Error("Turn fehlgeschlagen: ${event.error}"))
            }

            is AgentEvent.ErrorEvent -> {
                _progress.value = null
                append(TimelineItem.Error(event.message))
            }

            // Mit Phase ist die Notice Fortschritt und ersetzt den vorherigen
            // Stand; ohne Phase bleibt sie eine Systemzeile in der Timeline.
            is AgentEvent.Notice -> when (val phase = StartPhase.fromRaw(event.phase)) {
                null -> append(TimelineItem.Notice(event.message))
                StartPhase.READY -> _progress.value = null
                else -> _progress.value = StartProgress(
                    message = event.message,
                    phase = phase,
                    detail = event.detail?.takeIf { it.isNotBlank() },
                )
            }

            is AgentEvent.Status -> _busy.value = event.busy
            is AgentEvent.MessageDelta, is AgentEvent.Ping -> Unit
        }
    }

    private fun append(item: TimelineItem) {
        _items.value = _items.value + item
    }

    fun updateInput(text: String) {
        _input.value = text
    }

    fun sendPrompt() {
        val text = _input.value.trim()
        if (text.isEmpty()) return
        repository.sendPrompt(sessionId, text, null)
        _input.value = ""
        _busy.value = true
        append(TimelineItem.Chat("user", text))
    }

    fun decide(permissionId: String, decision: PermissionDecision) {
        repository.sendPermission(sessionId, permissionId, decision)
        _items.value = _items.value.map { item ->
            if (item is TimelineItem.Approval && item.permissionId == permissionId && item.resolved == null) {
                item.copy(resolved = decision)
            } else item
        }
    }

    /* ---------------- Agent / Modus / Modell / Reasoning ---------------- */

    private fun update(
        mode: AgentMode? = null,
        model: String? = null,
        reasoningEffort: ReasoningEffort? = null,
        adapter: String? = null,
    ) {
        viewModelScope.launch {
            // Erfolgsfall aktualisiert die UI über das session.status-Handling
            repository.updateSession(sessionId, mode, model, reasoningEffort, adapter)
                .onFailure { append(TimelineItem.Error("Änderung fehlgeschlagen: ${it.message}")) }
        }
    }

    fun setMode(mode: AgentMode) = update(mode = mode)

    /** Leerer String setzt auf den Adapter-Default zurück. */
    fun setModel(model: String) = update(model = model.trim())

    fun setReasoning(effort: ReasoningEffort) = update(reasoningEffort = effort)

    /**
     * Agent der laufenden Session wechseln. Der Server startet den neuen
     * Agenten asynchron auf dem aktuellen Code-Stand und meldet den
     * Fortschritt als session.status ('starting' → 'idle').
     */
    fun setAdapter(adapterId: String) = update(adapter = adapterId)

    /** Für die Zugangs-Punkte im Agent-Sheet. */
    fun loadSecrets() {
        viewModelScope.launch { repository.loadSecrets() }
    }

    fun loadModels() {
        if (_models.value is ModelsState.Loading) return
        _models.value = ModelsState.Loading
        viewModelScope.launch {
            _models.value = repository.loadModels(sessionId).fold(
                onSuccess = { ModelsState.Loaded(it) },
                onFailure = { ModelsState.Failed(it.message ?: "Unbekannter Fehler") },
            )
        }
    }

    fun abort() = repository.sendAbort(sessionId)
    fun stop() = repository.sendStop(sessionId)
    fun resume() = repository.sendResume(sessionId)
    fun push() = repository.sendPush(sessionId)

    fun delete() {
        viewModelScope.launch {
            if (repository.deleteSession(sessionId)) _deleted.value = true
        }
    }
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

@Composable
fun SessionScreen(
    sessionId: String,
    onBack: () -> Unit,
    onOpenDiff: (String) -> Unit,
) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: SessionViewModel = viewModel(key = "session-$sessionId") {
        SessionViewModel().also { it.bind(sessionId, repository) }
    }
    val items by vm.items.collectAsState()
    val session by vm.session.collectAsState()
    val input by vm.input.collectAsState()
    val busy by vm.busy.collectAsState()
    val progress by vm.progress.collectAsState()
    val deleted by vm.deleted.collectAsState()
    val capabilities by vm.capabilities.collectAsState()
    val models by vm.models.collectAsState()
    val adapters by vm.adapters.collectAsState()
    val secrets by repository.secrets.collectAsState()
    val secretKinds = remember(secrets) { secrets.map { it.kind }.toSet() }

    LaunchedEffect(deleted) { if (deleted) onBack() }

    var sheet by remember { mutableStateOf<SessionSheet?>(null) }

    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    LaunchedEffect(items.size) {
        if (items.isNotEmpty()) listState.animateScrollToItem(items.size - 1)
    }

    var menuOpen by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                    scrolledContainerColor = MaterialTheme.colorScheme.background,
                ),
                title = {
                    Column {
                        Text(
                            text = session?.repoFullName ?: "Session",
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        // One quiet line instead of a badge plus four chips.
                        session?.let { s ->
                            StatusLine(
                                status = s.status,
                                details = listOfNotNull(
                                    adapterLabel(adapters, s.adapter),
                                    s.mode.wireName(),
                                    s.networkPolicy?.takeIf { it != "allowlist" }?.let(::networkPolicyLabel),
                                ),
                                modifier = Modifier.padding(top = 2.dp),
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück")
                    }
                },
                actions = {
                    if (busy || session?.status == SessionStatus.RUNNING) {
                        IconButton(onClick = { vm.abort() }) {
                            Icon(Icons.Filled.Stop, contentDescription = "Agent anhalten")
                        }
                    }
                    IconButton(onClick = { onOpenDiff(sessionId) }) {
                        Icon(Icons.Filled.Difference, contentDescription = "Änderungen ansehen")
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "Weitere Aktionen")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            if (session?.mode != com.pocketagent.app.data.AgentMode.YOLO) {
                                DropdownMenuItem(
                                    text = { Text("Pushen & Draft-PR") },
                                    leadingIcon = { Icon(Icons.Filled.CloudUpload, contentDescription = null) },
                                    onClick = { menuOpen = false; vm.push() },
                                )
                            }
                            if (session?.status == SessionStatus.STOPPED) {
                                DropdownMenuItem(
                                    text = { Text("Fortsetzen") },
                                    leadingIcon = { Icon(Icons.Outlined.Check, contentDescription = null) },
                                    onClick = { menuOpen = false; vm.resume() },
                                )
                            } else {
                                DropdownMenuItem(
                                    text = { Text("Container anhalten") },
                                    leadingIcon = { Icon(Icons.Outlined.Close, contentDescription = null) },
                                    onClick = { menuOpen = false; vm.stop() },
                                )
                            }
                            DropdownMenuItem(
                                text = { Text("Session löschen") },
                                leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null) },
                                onClick = { menuOpen = false; confirmDelete = true },
                            )
                        }
                    }
                },
            )
        },
        bottomBar = {
            Surface(color = MaterialTheme.colorScheme.background, tonalElevation = 0.dp) {
                Column(modifier = Modifier.navigationBarsPadding().imePadding()) {
                    // Der Start braucht Minuten — er steht ruhig über dem
                    // Composer statt in der Timeline, wo er wegscrollen würde.
                    startProgressOf(session?.status, progress)?.let { StartProgressCard(it) }
                    AnimatedVisibility(visible = busy, enter = fadeIn(), exit = fadeOut()) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(start = ContentInset, top = 6.dp, bottom = 2.dp),
                        ) {
                            PulsingDot(
                                color = MaterialTheme.colorScheme.primary,
                                pulse = true,
                                size = 6.dp,
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = "Agent arbeitet …",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    // Kompakte Chip-Reihe: Agent und Modus immer, Modell und
                    // Reasoning nur, wenn der Adapter sie wirklich unterstützt.
                    // Während der Agent hochfährt ist nichts davon einstellbar.
                    session?.let { s ->
                        val chipsEnabled = s.status != SessionStatus.CREATING
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState())
                                .padding(start = ScreenGutter, end = ScreenGutter, top = 2.dp, bottom = 4.dp),
                        ) {
                            SettingChip(
                                label = "Agent",
                                value = adapterLabel(adapters, s.adapter),
                                enabled = chipsEnabled,
                                onClick = {
                                    sheet = SessionSheet.AGENT
                                    vm.loadSecrets()
                                },
                            )
                            SettingChip(
                                label = "Modus",
                                value = modeLabel(s.mode),
                                enabled = chipsEnabled,
                                onClick = { sheet = SessionSheet.MODE },
                            )
                            if (capabilities.modelSwitch) {
                                SettingChip(
                                    label = "Modell",
                                    value = s.model.ifBlank { "Standard" },
                                    enabled = chipsEnabled,
                                    onClick = {
                                        sheet = SessionSheet.MODEL
                                        vm.loadModels()
                                    },
                                )
                            }
                            if (capabilities.reasoning) {
                                SettingChip(
                                    label = "Reasoning",
                                    value = reasoningLabel(ReasoningEffort.fromRaw(s.reasoningEffort)),
                                    enabled = chipsEnabled,
                                    onClick = { sheet = SessionSheet.REASONING },
                                )
                            }
                        }
                    }
                    Row(
                        verticalAlignment = Alignment.Bottom,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = ScreenGutter, end = ScreenGutter, top = 4.dp, bottom = 8.dp),
                    ) {
                        OutlinedTextField(
                            value = input,
                            onValueChange = vm::updateInput,
                            placeholder = { Text("Aufgabe oder Rückfrage …") },
                            modifier = Modifier.weight(1f),
                            maxLines = 5,
                            shape = PillShape,
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
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        // Filled circle when there is something to send: the
                        // primary action of this screen should look like one.
                        FilledIconButton(
                            onClick = { vm.sendPrompt() },
                            enabled = input.isNotBlank(),
                            shape = CircleShape,
                            modifier = Modifier
                                .padding(bottom = 4.dp)
                                .size(MinTouchTarget),
                        ) {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Senden")
                        }
                    }
                }
            }
        },
    ) { padding ->
        if (items.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.padding(horizontal = 40.dp),
                ) {
                    Text(
                        text = "Woran soll gearbeitet werden?",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = "Beschreibe die Aufgabe unten – zum Beispiel „Fixe den Login-Timeout und " +
                            "schreib einen Test dafür“.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(
                    start = ScreenGutter,
                    end = ScreenGutter,
                    top = 10.dp,
                    bottom = 16.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(items) { item -> TimelineItemView(item, vm) }
            }
        }
    }

    when (sheet) {
        SessionSheet.AGENT -> AgentSheet(
            adapters = adapters,
            current = session?.adapter.orEmpty(),
            secretKinds = secretKinds,
            onDismiss = { sheet = null },
            onSwitch = { adapterId -> sheet = null; vm.setAdapter(adapterId) },
        )

        SessionSheet.MODE -> ModeSheet(
            current = session?.mode,
            onDismiss = { sheet = null },
            onPick = { mode -> sheet = null; vm.setMode(mode) },
        )

        SessionSheet.MODEL -> ModelSheet(
            current = session?.model.orEmpty(),
            state = models,
            onDismiss = { sheet = null },
            onRetry = { vm.loadModels() },
            onPick = { model -> sheet = null; vm.setModel(model) },
        )

        SessionSheet.REASONING -> ReasoningSheet(
            current = ReasoningEffort.fromRaw(session?.reasoningEffort),
            onDismiss = { sheet = null },
            onPick = { effort -> sheet = null; vm.setReasoning(effort) },
        )

        null -> Unit
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Session löschen?") },
            text = { Text("Container und Volume werden entfernt. Das kann nicht rückgängig gemacht werden.") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; vm.delete() }) { Text("Löschen") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("Abbrechen") }
            },
        )
    }
}

/* ------------------------------------------------------------------ */
/* Startfortschritt                                                    */
/* ------------------------------------------------------------------ */

/**
 * Was während des Starts über dem Composer steht. Der Status entscheidet,
 * ob überhaupt etwas läuft; sobald der Server meldet, tritt seine Meldung
 * an die Stelle des neutralen Texts — eine leere Wartefläche gibt es nie.
 */
private fun startProgressOf(status: SessionStatus?, progress: StartProgress?): StartProgress? = when (status) {
    SessionStatus.CREATING -> progress ?: StartProgress("Session wird vorbereitet …")
    // Session noch nicht geladen: melden darf trotzdem, wer schon etwas weiß.
    null -> progress
    else -> null
}

/**
 * Eine Karte, ein Vorgang: Spinner, was gerade passiert, und darunter der
 * gekürzte Log. Antippen zeigt den ganzen Auszug. Kein Verlauf — jede neue
 * Meldung ersetzt die vorige.
 */
@Composable
private fun StartProgressCard(progress: StartProgress) {
    var expanded by remember { mutableStateOf(false) }
    // Neue Phase heißt neuer Log: der alte Aufklapp-Zustand gilt nicht mehr.
    LaunchedEffect(progress.phase) { expanded = false }
    val detail = progress.detail
    ScreenCard(modifier = Modifier.padding(bottom = 8.dp)) {
        Column(
            modifier = Modifier
                .let { if (detail != null) it.clickable { expanded = !expanded } else it }
                .padding(horizontal = CardInset, vertical = 14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                Text(
                    text = progress.message,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 12.dp),
                )
                if (detail != null) {
                    Icon(
                        if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                        contentDescription = if (expanded) "Log einklappen" else "Log ausklappen",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            if (progress.phase == StartPhase.IMAGE_BUILD) {
                Text(
                    text = "Der erste Start eines Agenten dauert einige Minuten – sein Image wird einmalig gebaut.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            if (detail != null) {
                if (!expanded) {
                    Text(
                        text = detail,
                        style = MonoSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                AnimatedVisibility(visible = expanded) {
                    Text(
                        text = detail,
                        style = MonoSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .padding(top = 8.dp)
                            .heightIn(max = 220.dp)
                            .verticalScroll(rememberScrollState()),
                    )
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* Agent / Modus / Modell / Reasoning — Chips + Bottom Sheets          */
/* ------------------------------------------------------------------ */

enum class SessionSheet { AGENT, MODE, MODEL, REASONING }

/** Anzeigename des Adapters; ohne Manifest bleibt die rohe Id stehen. */
fun adapterLabel(adapters: List<AdapterDescriptor>, id: String): String =
    adapters.firstOrNull { it.id == id }?.name ?: id

fun modeLabel(mode: AgentMode): String = when (mode) {
    AgentMode.ASK -> "Ask"
    AgentMode.ACCEPT_EDITS -> "Accept Edits"
    AgentMode.AUTO -> "Auto"
    AgentMode.YOLO -> "Yolo"
}

fun reasoningLabel(effort: ReasoningEffort?): String = when (effort) {
    ReasoningEffort.LOW -> "Niedrig"
    ReasoningEffort.MEDIUM -> "Mittel"
    ReasoningEffort.HIGH -> "Hoch"
    null -> "Standard"
}

/** Kompakter Pill-Chip: Label klein und grau, aktiver Wert darunter/daneben. */
@Composable
private fun SettingChip(
    label: String,
    value: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    Surface(
        shape = PillShape,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .heightIn(min = 34.dp)
            .alpha(if (enabled) 1f else 0.4f),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 12.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 160.dp),
            )
            Icon(
                Icons.Filled.ExpandMore,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/**
 * Gemeinsame Hülle aller Einstell-Sheets: Titel + One-UI-Gruppenkarte.
 * Auch der New-Session-Screen baut sein Modell-Sheet hierauf.
 */
@Composable
fun SettingSheet(
    title: String,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = 12.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(start = ContentInset, end = ContentInset, bottom = 12.dp),
            )
            content()
        }
    }
}

/**
 * Agent der laufenden Session wechseln. Die Liste ist dieselbe wie beim
 * Anlegen einer Session; der Hinweis darunter sagt, was der Wechsel kostet.
 */
@Composable
private fun AgentSheet(
    adapters: List<AdapterDescriptor>,
    current: String,
    secretKinds: Set<String>,
    onDismiss: () -> Unit,
    onSwitch: (String) -> Unit,
) {
    var picked by remember(current) { mutableStateOf(current) }
    SettingSheet(title = "Agent", onDismiss = onDismiss) {
        GroupCard {
            Column(
                modifier = Modifier
                    .heightIn(max = 320.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                adapters.forEachIndexed { index, descriptor ->
                    if (index > 0) ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = descriptor.name,
                        subtitle = shortDescription(descriptor.description),
                        selected = picked == descriptor.id,
                        onClick = { picked = descriptor.id },
                        trailing = if (!adapterKeyPresent(descriptor, secretKinds)) {
                            { DotLabel(color = semantic().warning, label = "Kein Zugang") }
                        } else {
                            null
                        },
                    )
                }
            }
        }
        SectionNote(
            "Der neue Agent startet frisch auf dem aktuellen Code-Stand dieser Session. " +
                "Der bisherige Gesprächskontext des Agenten geht verloren; der Verlauf hier " +
                "bleibt sichtbar.",
        )
        Button(
            onClick = { onSwitch(picked) },
            enabled = picked.isNotBlank() && picked != current,
            shape = PillShape,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = ScreenGutter, vertical = 10.dp)
                .height(PrimaryButtonHeight),
        ) {
            Text("Agent wechseln")
        }
    }
}

/** Erste Zeile der Adapter-Beschreibung, auf Sheet-Länge gekürzt. */
private fun shortDescription(raw: String?): String? =
    raw?.takeIf { it.isNotBlank() }
        ?.lineSequence()
        ?.first()
        ?.let { if (it.length > 64) it.take(63).trimEnd() + "…" else it }

@Composable
private fun ModeSheet(
    current: AgentMode?,
    onDismiss: () -> Unit,
    onPick: (AgentMode) -> Unit,
) {
    SettingSheet(title = "Modus", onDismiss = onDismiss) {
        GroupCard {
            Column {
                val entries = listOf(
                    Triple(AgentMode.ASK, "Ask", "Jede Aktion wird vorher bestätigt"),
                    Triple(AgentMode.ACCEPT_EDITS, "Accept Edits", "Datei-Änderungen laufen durch, alles andere wird gefragt"),
                    Triple(AgentMode.AUTO, "Auto", "Agent entscheidet selbst, Push nur manuell"),
                    Triple(AgentMode.YOLO, "Yolo", "Vollautomatisch inklusive Push und Draft-PR"),
                )
                entries.forEachIndexed { index, (mode, title, subtitle) ->
                    if (index > 0) ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = title,
                        subtitle = subtitle,
                        selected = current == mode,
                        titleColor = if (mode == AgentMode.YOLO && current == mode) {
                            MaterialTheme.colorScheme.error
                        } else {
                            Color.Unspecified
                        },
                        onClick = { onPick(mode) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ReasoningSheet(
    current: ReasoningEffort?,
    onDismiss: () -> Unit,
    onPick: (ReasoningEffort) -> Unit,
) {
    SettingSheet(title = "Reasoning", onDismiss = onDismiss) {
        GroupCard {
            Column {
                val entries = listOf(
                    Triple(ReasoningEffort.LOW, "Niedrig", "Schnelle Antworten, wenig Nachdenken"),
                    Triple(ReasoningEffort.MEDIUM, "Mittel", "Ausgewogen zwischen Tempo und Tiefe"),
                    Triple(ReasoningEffort.HIGH, "Hoch", "Gründliches Nachdenken, langsamer und teurer"),
                )
                entries.forEachIndexed { index, (effort, title, subtitle) ->
                    if (index > 0) ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = title,
                        subtitle = subtitle,
                        selected = current == effort,
                        onClick = { onPick(effort) },
                    )
                }
            }
        }
        SectionNote("Gilt ab dem nächsten Prompt dieser Session.")
    }
}

@Composable
private fun ModelSheet(
    current: String,
    state: ModelsState,
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
    onPick: (String) -> Unit,
) {
    var custom by remember(current) { mutableStateOf(current) }
    SettingSheet(title = "Modell", onDismiss = onDismiss) {
        when (state) {
            is ModelsState.Loading, ModelsState.Idle -> Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = ContentInset, vertical = 12.dp),
            ) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(10.dp))
                Text(
                    text = "Modelle werden geladen …",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            is ModelsState.Failed -> Column {
                SectionError(state.message)
                TextButton(
                    onClick = onRetry,
                    shape = PillShape,
                    modifier = Modifier
                        .padding(start = ScreenGutter, top = 4.dp)
                        .heightIn(min = MinTouchTarget),
                ) {
                    Text("Erneut versuchen")
                }
            }

            is ModelsState.Loaded -> if (state.models.isEmpty()) {
                SectionNote("Dieser Adapter liefert keine Modellliste – Modell unten frei eintragen.")
            } else {
                GroupCard {
                    Column(modifier = Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
                        SelectableTile(
                            title = "Adapter-Standard",
                            subtitle = "Modellwahl dem Adapter überlassen",
                            selected = current.isBlank(),
                            onClick = { onPick("") },
                        )
                        state.models.forEach { model ->
                            ListDivider(RadioRowDividerInset)
                            SelectableTile(
                                title = model.name ?: model.id,
                                subtitle = model.id,
                                selected = current == model.id,
                                onClick = { onPick(model.id) },
                            )
                        }
                    }
                }
            }
        }
        SectionHeader("Eigenes Modell")
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = ScreenGutter),
        ) {
            OutlinedTextField(
                value = custom,
                onValueChange = { custom = it },
                placeholder = { Text("z. B. anbieter/modell") },
                singleLine = true,
                shape = PillShape,
                modifier = Modifier.weight(1f),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Button(
                onClick = { onPick(custom) },
                shape = PillShape,
                enabled = custom.trim() != current,
                modifier = Modifier.heightIn(min = MinTouchTarget),
            ) {
                Text("Setzen")
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* Timeline item views                                                 */
/* ------------------------------------------------------------------ */

@Composable
private fun TimelineItemView(item: TimelineItem, vm: SessionViewModel) {
    when (item) {
        is TimelineItem.Chat -> ChatBubble(item)
        is TimelineItem.Tool -> ToolCard(item)
        is TimelineItem.Approval -> ApprovalCard(item, vm)
        is TimelineItem.TurnEnd -> SystemLine(
            text = listOfNotNull("Fertig", item.commitSha?.take(7)).joinToString(" · "),
            icon = Icons.Outlined.Check,
        )

        is TimelineItem.Notice -> SystemLine(text = item.text)
        is TimelineItem.Pushed -> PushCard(item)
        is TimelineItem.Error -> ErrorCard(item)
    }
}

@Composable
private fun ChatBubble(item: TimelineItem.Chat) {
    val isUser = item.role == "user"
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (isUser) Spacer(modifier = Modifier.width(40.dp))
        Surface(
            shape = RoundedCornerShape(
                topStart = 20.dp,
                topEnd = 20.dp,
                bottomStart = if (isUser) 20.dp else 6.dp,
                bottomEnd = if (isUser) 6.dp else 20.dp,
            ),
            color = if (isUser) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surfaceContainer
            },
            modifier = Modifier.weight(1f),
        ) {
            if (isUser) {
                Text(
                    text = item.text,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                )
            } else {
                MarkdownText(
                    text = item.text,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
        }
        if (!isUser) Spacer(modifier = Modifier.width(40.dp))
    }
}

@Composable
private fun ToolCard(item: TimelineItem.Tool) {
    var expanded by remember { mutableStateOf(false) }
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = CardInset, end = 4.dp, top = 4.dp, bottom = 4.dp),
            ) {
                val s = semantic()
                val (dotColor, statusText) = when {
                    item.result == null -> MaterialTheme.colorScheme.primary to "läuft"
                    item.result.isError == true -> MaterialTheme.colorScheme.error to "Fehler"
                    else -> s.success to "ok"
                }
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .background(dotColor.copy(alpha = 0.14f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    if (item.result == null) {
                        CircularProgressIndicator(
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(13.dp),
                        )
                    } else {
                        Box(modifier = Modifier.size(8.dp).background(dotColor, CircleShape))
                    }
                }
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 10.dp, top = 8.dp, bottom = 8.dp)
                ) {
                    Text(
                        text = item.title ?: item.tool,
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                    )
                    Text(
                        text = "${item.tool} · $statusText",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = { expanded = !expanded }) {
                    Icon(
                        if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                        contentDescription = if (expanded) "Einklappen" else "Ausklappen",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            AnimatedVisibility(visible = expanded) {
                Column(
                    Modifier
                        .padding(horizontal = 14.dp, vertical = 4.dp)
                        .padding(bottom = 10.dp)
                ) {
                    item.input?.let { input ->
                        Text(
                            text = input.toString().take(4000),
                            style = MonoMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    item.result?.let { result ->
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceContainerHighest,
                            shape = MaterialTheme.shapes.small,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 6.dp),
                        ) {
                            Text(
                                text = result.output.take(4000),
                                style = MonoMedium,
                                color = if (result.isError == true) {
                                    MaterialTheme.colorScheme.error
                                } else {
                                    MaterialTheme.colorScheme.onSurface
                                },
                                modifier = Modifier
                                    .heightIn(max = 260.dp)
                                    .verticalScroll(rememberScrollState())
                                    .padding(10.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ApprovalCard(item: TimelineItem.Approval, vm: SessionViewModel) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(
                text = "Bestätigung erforderlich",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = item.title,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = 2.dp),
            )
            item.detail?.let { detail ->
                Text(
                    text = detail.take(2000),
                    style = MonoMedium,
                    modifier = Modifier
                        .padding(top = 8.dp)
                        .heightIn(max = 200.dp)
                        .verticalScroll(rememberScrollState()),
                )
            }
            item.diff?.let { diff ->
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerHighest,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                ) {
                    DiffBody(
                        lines = diff.lines(),
                        style = MonoMedium,
                        modifier = Modifier
                            .heightIn(max = 300.dp)
                            .verticalScroll(rememberScrollState())
                            .padding(vertical = 6.dp),
                    )
                }
            }
            when (item.resolved) {
                // Same button heights, same pill shape, one accent: the
                // safe default is filled, the wider grant is tonal, the
                // refusal is quiet text.
                null -> Column(modifier = Modifier.padding(top = 14.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            shape = PillShape,
                            onClick = { vm.decide(item.permissionId, PermissionDecision.ONCE) },
                            modifier = Modifier
                                .weight(1f)
                                .height(MinTouchTarget),
                        ) {
                            Text("Erlauben")
                        }
                        FilledTonalButton(
                            shape = PillShape,
                            onClick = { vm.decide(item.permissionId, PermissionDecision.ALWAYS) },
                            modifier = Modifier
                                .weight(1f)
                                .height(MinTouchTarget),
                        ) {
                            Text("Immer")
                        }
                    }
                    TextButton(
                        shape = PillShape,
                        onClick = { vm.decide(item.permissionId, PermissionDecision.REJECT) },
                        modifier = Modifier
                            .padding(top = 4.dp)
                            .heightIn(min = MinTouchTarget),
                    ) {
                        Text("Ablehnen")
                    }
                }

                PermissionDecision.ONCE -> ResolvedLabel("Erlaubt")
                PermissionDecision.ALWAYS -> ResolvedLabel("Immer erlaubt")
                PermissionDecision.REJECT -> ResolvedLabel("Abgelehnt")
            }
        }
    }
}

@Composable
private fun ResolvedLabel(label: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(top = 10.dp),
    ) {
        Icon(
            Icons.Outlined.DoneAll,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(15.dp),
        )
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

/**
 * Die eine ruhige Systemzeile der Timeline: zentriert, grau, optional mit
 * Icon. Turn-Ende und Server-Hinweise teilen sie sich.
 */
@Composable
private fun SystemLine(text: String, icon: ImageVector? = null) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 6.dp),
    ) {
        icon?.let {
            Icon(
                it,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(14.dp),
            )
        }
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun PushCard(item: TimelineItem.Pushed) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.primaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.CloudUpload,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(20.dp),
                )
                Text(
                    text = listOfNotNull(
                        if (item.auto) "Automatisch gepusht" else "Gepusht",
                        item.prUrl?.let { "Draft-PR erstellt" },
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
            Text(
                text = item.branch,
                style = MonoMedium,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun ErrorCard(item: TimelineItem.Error) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.errorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = item.message,
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(14.dp),
        )
    }
}
