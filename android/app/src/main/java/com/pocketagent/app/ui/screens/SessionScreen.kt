@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package com.pocketagent.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Difference
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
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
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
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
import androidx.compose.ui.text.input.KeyboardType
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
import com.pocketagent.app.data.WsClient
import com.pocketagent.app.ui.components.MarkdownText
import com.pocketagent.app.ui.theme.CardInset
import com.pocketagent.app.ui.theme.ChipHeight
import com.pocketagent.app.ui.theme.ChipSpacing
import com.pocketagent.app.ui.theme.ChipValueMaxWidth
import com.pocketagent.app.ui.theme.ComposerHeight
import com.pocketagent.app.ui.theme.ContentInset
import com.pocketagent.app.ui.theme.MinTouchTarget
import com.pocketagent.app.ui.theme.MonoMedium
import com.pocketagent.app.ui.theme.MonoSmall
import com.pocketagent.app.ui.theme.MotionMedium
import com.pocketagent.app.ui.theme.MotionShort
import com.pocketagent.app.ui.theme.OneUiEasing
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
/* Timeline: Modell und Reduktion liegen in Timeline.kt                */
/* ------------------------------------------------------------------ */

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

    /** True, solange der gespeicherte Verlauf unterwegs ist. */
    private val _historyLoading = MutableStateFlow(false)
    val historyLoading: StateFlow<Boolean> = _historyLoading

    /**
     * Der letzte Prompt, der die Verbindung nicht mehr erreicht hat. Der Text
     * bleibt im Eingabefeld stehen; das hier ist nur der Hinweis darüber.
     */
    private val _sendFailed = MutableStateFlow(false)
    val sendFailed: StateFlow<Boolean> = _sendFailed

    /** True, während ein Prompt raus ist und auf die Bestätigung wartet. */
    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending

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
        // Beim Öffnen und nach jedem erfolgreichen (Wieder-)Verbinden den
        // gespeicherten Verlauf holen. connState ist ein StateFlow, der
        // aktuelle Wert kommt also sofort — steht die Verbindung schon,
        // lädt das hier direkt; sonst, sobald sie steht.
        viewModelScope.launch {
            repository.connState.collect { state ->
                if (state is WsClient.ConnState.Connected) {
                    _sendFailed.value = false
                    loadHistory()
                }
            }
        }
        viewModelScope.launch { repository.refreshSessions() }
        viewModelScope.launch { if (repository.adapters.value.isEmpty()) repository.refreshAdapters() }
    }

    /* ---------------- Verlauf ---------------- */

    /**
     * Puffer für alles, was hereinkommt, während die Verlaufsanfrage
     * unterwegs ist. Die Timeline bleibt solange stehen — kein Flackern,
     * keine Zeile, die gleich wieder verschwindet.
     */
    private val liveWhileLoading = mutableListOf<AgentEvent>()

    private var historyJob: kotlinx.coroutines.Job? = null

    /**
     * Den gespeicherten Verlauf holen und die Timeline daraus neu aufbauen.
     * Was während der Anfrage live ankam, wird anschließend obendrauf
     * gelegt — dedupliziert über [mergeEvents].
     */
    private fun loadHistory() {
        if (historyJob?.isActive == true) return
        historyJob = viewModelScope.launch {
            _historyLoading.value = true
            liveWhileLoading.clear()
            val result = repository.loadEvents(sessionId)
            val history = result.getOrNull()
            if (history != null) {
                _items.value = buildTimeline(mergeEvents(history, liveWhileLoading.toList()))
            } else {
                // Ohne Verlauf bleibt das Bisherige stehen; die gepufferten
                // Ereignisse dürfen trotzdem nicht verloren gehen.
                _items.value = liveWhileLoading.fold(_items.value, ::reduceTimeline)
            }
            liveWhileLoading.clear()
            _historyLoading.value = false
        }
    }

    private fun applyEvent(event: AgentEvent) {
        applySideEffects(event)
        if (_historyLoading.value) {
            liveWhileLoading += event
            return
        }
        _items.value = reduceTimeline(_items.value, event)
    }

    /**
     * Wirkung eines Ereignisses außerhalb der Timeline: Busy-Anzeige und
     * Startfortschritt. Nur für Live-Ereignisse — ein gespeicherter Verlauf
     * sagt nichts darüber, was gerade läuft.
     */
    private fun applySideEffects(event: AgentEvent) {
        when (event) {
            is AgentEvent.Status -> _busy.value = event.busy

            // Ein Fehler beendet den Start: er wird als Karte gezeigt, die
            // Fortschrittsanzeige hat dann nichts mehr zu melden.
            is AgentEvent.TurnFailed, is AgentEvent.ErrorEvent -> _progress.value = null

            // Mit Phase ist die Notice Fortschritt und ersetzt den vorherigen
            // Stand; ohne Phase bleibt sie eine Systemzeile in der Timeline.
            is AgentEvent.Notice -> when (val phase = StartPhase.fromRaw(event.phase)) {
                null -> Unit
                StartPhase.READY -> _progress.value = null
                else -> _progress.value = StartProgress(
                    message = event.message,
                    phase = phase,
                    detail = event.detail?.takeIf { it.isNotBlank() },
                )
            }

            else -> Unit
        }
    }

    private fun append(item: TimelineItem) {
        _items.value = _items.value + item
    }

    fun updateInput(text: String) {
        _input.value = text
        if (text.isNotBlank()) _sendFailed.value = false
    }

    /**
     * Prompt abschicken und auf die Bestätigung (`request.ok`) warten, bevor
     * das Eingabefeld geleert wird. Kommt keine Bestätigung — keine
     * Verbindung, Timeout oder Server-Fehler —, bleibt der Text stehen und
     * die Timeline bekommt keine Zeile: es ist nichts passiert, also darf
     * auch nichts so aussehen. Während die Anfrage läuft, ist der
     * Senden-Knopf gesperrt (`_sending`), damit derselbe Text nicht doppelt
     * losgeschickt wird.
     *
     * Bewusst weiterhin kein automatisches Nachsenden bei einem Timeout: der
     * bestätigt zwar jetzt den Erfolgsfall sauber, aber ein Timeout heißt nur
     * „unklar, ob der Agent den Auftrag schon hat“ — nicht „gescheitert“.
     * Automatisches Wiederholen könnte dieselbe Aufgabe zweimal anstoßen
     * (zweimal committen, zweimal pushen). Der Text bleibt bereit, ein
     * erneuter Tap schickt ihn los.
     */
    fun sendPrompt() {
        val text = _input.value.trim()
        if (text.isEmpty() || _sending.value) return
        _sending.value = true
        viewModelScope.launch {
            repository.sendPrompt(sessionId, text, null)
                .onSuccess {
                    _sendFailed.value = false
                    _input.value = ""
                    _busy.value = true
                    append(TimelineItem.Chat("user", text))
                }
                .onFailure {
                    _sendFailed.value = true
                }
            _sending.value = false
        }
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
                .onFailure {
                    // Kopfzeile bleibt handlungsleitend; der Servertext – falls
                    // vorhanden – steht nur als Nebensatz dahinter.
                    val cause = it.message?.takeIf { m -> m.isNotBlank() }?.let { m -> " ($m)" }.orEmpty()
                    append(TimelineItem.Error("Änderung konnte nicht übernommen werden – bitte erneut versuchen.$cause"))
                }
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
                // Keine Server-/Exception-Interna vor dem Nutzer — die Karte
                // bietet ohnehin "Erneut versuchen" als Weg nach vorn.
                onFailure = { ModelsState.Failed("Die Modellliste konnte nicht geladen werden.") },
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
    val historyLoading by vm.historyLoading.collectAsState()
    val sendFailed by vm.sendFailed.collectAsState()
    val sending by vm.sending.collectAsState()
    val connState by repository.connState.collectAsState()
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

    // SessionSheet ist ein Enum und damit Serializable — der Standard-Saver
    // trägt es unverändert über Fold/Rotation hinweg.
    var sheet by rememberSaveable { mutableStateOf<SessionSheet?>(null) }

    // Nach dem Laden ans Ende — aber ohne Animation, damit der Verlauf
    // fertig unten steht statt sichtbar durchzurauschen. Erst danach wird
    // jede neue Zeile weich nachgezogen. Ein erneutes Laden (Reconnect)
    // setzt das zurück, damit auch dann nichts springt.
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    var settled by remember { mutableStateOf(false) }
    LaunchedEffect(historyLoading) { if (historyLoading) settled = false }
    LaunchedEffect(items.size, historyLoading) {
        if (items.isEmpty() || historyLoading) return@LaunchedEffect
        if (settled) {
            listState.animateScrollToItem(items.size - 1)
        } else {
            listState.scrollToItem(items.size - 1)
            settled = true
        }
    }

    var menuOpen by rememberSaveable { mutableStateOf(false) }
    var confirmDelete by rememberSaveable { mutableStateOf(false) }

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
                            text = session?.let(::sessionDisplayName) ?: "Session",
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        // One quiet line instead of a badge plus four chips.
                        // Trägt die Session einen Titel, rutscht das Repository
                        // hier hinein — sonst stünde es nirgends mehr.
                        session?.let { s ->
                            StatusLine(
                                session = s,
                                details = listOfNotNull(
                                    sessionSubtitle(s),
                                    adapterLabel(adapters, s.adapter),
                                    modeLabel(s.mode),
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
                            // vm.abort() bricht nur den laufenden Zug ab — die
                            // Beschreibung darf nicht nach "Container anhalten"
                            // klingen, das ist eine andere Aktion im Menü.
                            Icon(Icons.Filled.Stop, contentDescription = "Aktuellen Auftrag abbrechen")
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
                                    text = { Text(sessionActionLabel(SessionAction.RESUME)) },
                                    leadingIcon = { Icon(Icons.Outlined.Check, contentDescription = null) },
                                    onClick = { menuOpen = false; vm.resume() },
                                )
                            } else {
                                DropdownMenuItem(
                                    // Beschriftung aus SessionActions statt hier
                                    // noch einmal getippt: dieselbe Aktion hieß
                                    // in der Liste und hier sonst verschieden.
                                    text = { Text(sessionActionLabel(SessionAction.STOP)) },
                                    leadingIcon = { Icon(Icons.Outlined.Close, contentDescription = null) },
                                    onClick = { menuOpen = false; vm.stop() },
                                )
                            }
                            DropdownMenuItem(
                                // Bewusst nicht sessionActionLabel(DELETE): das
                                // sagt nur „Löschen“. Im Menü einer offenen
                                // Session muss dastehen, was gelöscht wird.
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
            // Dieselbe Lesespalte wie der Verlauf darüber. Dieser Screen baut
            // sein eigenes Scaffold und bekommt sie deshalb nicht von
            // OneUiScaffold — im Vollbild auf einem Tablet liefe der Composer
            // sonst randbreit unter einem schmalen Verlauf.
            CenteredContentWidth {
                Surface(color = MaterialTheme.colorScheme.background, tonalElevation = 0.dp) {
                    Column(modifier = Modifier.navigationBarsPadding().imePadding()) {
                        // Steht die Verbindung nicht, sagt es genau eine Zeile —
                        // mit Restzeit und einem Tap, der den Versuch vorzieht.
                        ConnectionLine(state = connState, onReconnect = { repository.reconnectNow() })
                        // Der Text ist nicht bestätigt und steht noch im Feld.
                        // Bewusst kein automatisches Nachsenden (siehe sendPrompt).
                        if (sendFailed) {
                            Text(
                                text = "Nicht gesendet – keine Verbindung oder keine Bestätigung. " +
                                    "Dein Text bleibt stehen, tippe erneut auf Senden.",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                                modifier = Modifier.padding(
                                    start = ContentInset,
                                    end = ContentInset,
                                    top = 2.dp,
                                    bottom = 2.dp,
                                ),
                            )
                        }
                        // Der Start braucht Minuten — er steht ruhig über dem
                        // Composer statt in der Timeline, wo er wegscrollen würde.
                        startProgressOf(session?.status, progress)?.let { StartProgressCard(it) }
                        AnimatedVisibility(
                            visible = busy,
                            enter = fadeIn(tween(MotionShort, easing = LinearEasing)),
                            exit = fadeOut(tween(MotionShort, easing = LinearEasing)),
                        ) {
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
                                horizontalArrangement = Arrangement.spacedBy(ChipSpacing),
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
                        // Eingabefeld und Senden-Knopf teilen sich ComposerHeight,
                        // damit sie als eine Zeile lesen. Wächst der Text über
                        // mehrere Zeilen, wächst nur die Pille — der Kreis bleibt
                        // unten bündig auf Höhe der letzten Zeile (One UI hängt
                        // die Aktion an das Ende der Eingabe, nicht an ihre Mitte).
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
                                modifier = Modifier
                                    .weight(1f)
                                    .heightIn(min = ComposerHeight),
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
                            // Gesperrt, solange die letzte Anfrage noch auf ihre
                            // Bestätigung wartet — kein Doppel-Senden per Doppeltap.
                            FilledIconButton(
                                onClick = { vm.sendPrompt() },
                                enabled = input.isNotBlank() && !sending,
                                shape = CircleShape,
                                modifier = Modifier.size(ComposerHeight),
                            ) {
                                if (sending) {
                                    CircularProgressIndicator(
                                        strokeWidth = 2.dp,
                                        modifier = Modifier.size(18.dp),
                                        color = MaterialTheme.colorScheme.onPrimary,
                                    )
                                } else {
                                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Senden")
                                }
                            }
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
                // Solange der Verlauf unterwegs ist, wird nicht behauptet,
                // die Session sei leer — sonst blitzt die Einladung auf und
                // wird eine halbe Sekunde später vom Verlauf verdrängt.
                if (historyLoading) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(10.dp))
                        Text(
                            text = "Verlauf wird geladen …",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
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
        OneUiDialog(
            onDismissRequest = { confirmDelete = false },
            title = "Session löschen?",
            // Dieselbe Warnung wie in der Liste: es geht mehr verloren als der Container.
            text = {
                Text(
                    session?.let(::deleteConfirmText)
                        ?: "Container, Volume und der gespeicherte Verlauf werden entfernt. " +
                        "Das lässt sich nicht rückgängig machen.",
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; vm.delete() }) {
                    Text("Löschen", color = MaterialTheme.colorScheme.error)
                }
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
                AnimatedVisibility(
                    visible = expanded,
                    enter = expandVertically(tween(MotionMedium, easing = OneUiEasing)) +
                        fadeIn(tween(MotionShort, easing = LinearEasing)),
                    exit = shrinkVertically(tween(MotionMedium, easing = OneUiEasing)) +
                        fadeOut(tween(MotionShort, easing = LinearEasing)),
                ) {
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
    // Ein neuerer Server kennt einen Modus, den diese App-Version noch nicht kennt.
    AgentMode.UNKNOWN -> "Unbekannt"
}

fun reasoningLabel(effort: ReasoningEffort?): String = when (effort) {
    ReasoningEffort.LOW -> "Niedrig"
    ReasoningEffort.MEDIUM -> "Mittel"
    ReasoningEffort.HIGH -> "Hoch"
    null -> "Standard"
}

/**
 * Kompakter Pill-Chip: Label klein und grau, aktiver Wert darunter/daneben.
 *
 * Beide Screens bauen ihre Chip-Reihe hieraus — die laufende Session und das
 * Anlegen einer neuen. Deshalb liegt der Chip hier öffentlich und nicht in
 * einer zweiten, fast gleichen Fassung im anderen Screen.
 *
 * [tag] ist ein Kennzeichen hinter dem Wert, das eine Eigenschaft des Werts
 * benennt statt eines eigenen Banners — etwa die Herkunft des Zugangs. Mit
 * [tagWarning] wird daraus eine Warnung: derselbe Platz, andere Aussage.
 */
@Composable
fun SettingChip(
    label: String,
    value: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tag: String? = null,
    tagWarning: Boolean = false,
) {
    Surface(
        shape = PillShape,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        onClick = onClick,
        enabled = enabled,
        // Gezeichnet bleibt die Pille bei ChipHeight (34 dp) — die Tippfläche
        // wächst per minimumInteractiveComponentSize() zentriert auf 48 dp,
        // ohne dass die Surface selbst größer gezeichnet wird. Ein Material3-
        // Surface bringt das für einen klickbaren Chip sonst nicht mit.
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .heightIn(min = ChipHeight)
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
                modifier = Modifier.widthIn(max = ChipValueMaxWidth),
            )
            if (tag != null) {
                Spacer(modifier = Modifier.width(6.dp))
                val tagColor = if (tagWarning) {
                    semantic().warning
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                }
                Text(
                    text = tag,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = tagColor,
                    maxLines = 1,
                    modifier = Modifier
                        .background(
                            if (tagWarning) {
                                semantic().warningContainer
                            } else {
                                MaterialTheme.colorScheme.surfaceVariant
                            },
                            PillShape,
                        )
                        .padding(horizontal = 7.dp, vertical = 1.dp),
                )
            }
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
 * Chip ohne Wort: ein Symbol, das ein Sheet öffnet. Für Einstellungen, die
 * selten angefasst werden und deren Name mehr Platz kostet als er einbringt.
 */
@Composable
fun SettingIconChip(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    Surface(
        shape = PillShape,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        onClick = onClick,
        enabled = enabled,
        // minimumInteractiveComponentSize() deckt hier auch die Breite ab —
        // ein reiner Icon-Chip ist von Natur aus schmaler als 48 dp.
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .heightIn(min = ChipHeight)
            .alpha(if (enabled) 1f else 0.4f),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            Icon(
                icon,
                contentDescription = contentDescription,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

/**
 * Gemeinsame Hülle aller Einstell-Sheets: Titel + One-UI-Gruppenkarte.
 * Auch der New-Session-Screen baut sein Modell-Sheet hierauf.
 *
 * Das Sheet öffnet immer ganz — lange Listen und Textfelder brauchen die
 * volle Höhe. Der Inhalt weicht der Tastatur aus (Insets werden vereinigt,
 * damit Navigationsleiste und IME nicht doppelt zählen).
 */
@Composable
fun SettingSheet(
    title: String,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
                // Der Inhalt scrollt. Ohne das ist alles unerreichbar, was
                // unter die Bildschirmkante rutscht — beim Modell-Sheet war
                // das der „Übernehmen“-Knopf, also die einzige Möglichkeit,
                // die Auswahl überhaupt zu bestätigen.
                //
                // Die Listen darin haben ihre eigene Begrenzung per
                // heightIn(max = …). Das ist hier keine Doppelung, sondern
                // Bedingung: eine scrollbare Fläche ohne Höhengrenze in einer
                // scrollbaren Fläche wirft zur Laufzeit.
                .verticalScroll(rememberScrollState())
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
        AgentPickList(
            adapters = adapters,
            picked = picked,
            secretKinds = secretKinds,
            onPick = { picked = it },
        )
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
                .heightIn(min = PrimaryButtonHeight),
        ) {
            Text("Agent wechseln")
        }
    }
}

/**
 * Die Agentenliste, wie sie beide Screens zeigen — beim Wechsel einer
 * laufenden Session und beim Anlegen einer neuen. Eine Liste, damit ein
 * Agent an beiden Stellen gleich heißt und gleich aussieht.
 *
 * [compact] entscheidet, wie viel vom Manifest mitkommt: im Wechsel-Sheet
 * genügt die erste Zeile der Beschreibung, weil der Agent dort schon gewählt
 * war. Beim Anlegen ist es eine echte Erstauswahl — dort steht die ganze
 * Beschreibung und dazu, was der Agent kann.
 */
@Composable
fun AgentPickList(
    adapters: List<AdapterDescriptor>,
    picked: String,
    secretKinds: Set<String>,
    onPick: (String) -> Unit,
    compact: Boolean = true,
) {
    GroupCard {
        Column(
            modifier = Modifier
                .heightIn(max = 320.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            adapters.forEachIndexed { index, descriptor ->
                if (index > 0) ListDivider(RadioRowDividerInset)
                val caps = descriptor.capabilities
                SelectableTile(
                    title = descriptor.name,
                    subtitle = if (compact) {
                        shortDescription(descriptor.description)
                    } else {
                        descriptor.description?.takeIf { it.isNotBlank() }
                    },
                    selected = picked == descriptor.id,
                    onClick = { onPick(descriptor.id) },
                    trailing = if (!adapterKeyPresent(descriptor, secretKinds)) {
                        { DotLabel(color = semantic().warning, label = "Kein Zugang") }
                    } else {
                        null
                    },
                    extra = if (!compact && (caps.approvals || caps.resume || caps.streaming)) {
                        {
                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                if (caps.approvals) InfoChip("Rückfragen")
                                if (caps.resume) InfoChip("Fortsetzen")
                                if (caps.streaming) InfoChip("Streaming")
                            }
                        }
                    } else {
                        null
                    },
                )
            }
        }
    }
}

/** Erste Zeile der Adapter-Beschreibung, auf Sheet-Länge gekürzt. */
private fun shortDescription(raw: String?): String? =
    raw?.takeIf { it.isNotBlank() }
        ?.lineSequence()
        ?.first()
        ?.let { if (it.length > 64) it.take(63).trimEnd() + "…" else it }

/**
 * Die Modusliste. Der Titel ist einstellbar, weil dieselbe Entscheidung in
 * der laufenden Session „Modus“ heißt und beim Anlegen „Autonomie“ — die
 * Einträge sind wortgleich dieselben und sollen es bleiben.
 */
@Composable
fun ModeSheet(
    current: AgentMode?,
    onDismiss: () -> Unit,
    onPick: (AgentMode) -> Unit,
    title: String = "Modus",
) {
    SettingSheet(title = title, onDismiss = onDismiss) {
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

/**
 * Die Reasoning-Stufen als Gruppenliste. Eigene Funktion, weil die laufende
 * Session sie in einem eigenen Sheet zeigt und der Anlege-Screen sie unter
 * das Modell hängt — dieselben drei Stufen mit denselben Worten.
 */
@Composable
fun ReasoningPickList(
    current: ReasoningEffort?,
    onPick: (ReasoningEffort) -> Unit,
    onDefault: (() -> Unit)? = null,
) {
    GroupCard {
        Column {
            // Nur wo „keine Stufe“ ein gültiger Zustand ist, gibt es eine
            // Zeile dafür. In einer laufenden Session hat der Agent immer
            // eine — dort wäre „Standard“ eine Auswahl ohne Wirkung.
            if (onDefault != null) {
                SelectableTile(
                    title = "Standard",
                    subtitle = "Stufe dem Agenten überlassen",
                    selected = current == null,
                    onClick = onDefault,
                )
            }
            val entries = listOf(
                Triple(ReasoningEffort.LOW, "Niedrig", "Schnelle Antworten, wenig Nachdenken"),
                Triple(ReasoningEffort.MEDIUM, "Mittel", "Ausgewogen zwischen Tempo und Tiefe"),
                Triple(ReasoningEffort.HIGH, "Hoch", "Gründliches Nachdenken, langsamer und teurer"),
            )
            entries.forEachIndexed { index, (effort, title, subtitle) ->
                if (index > 0 || onDefault != null) ListDivider(RadioRowDividerInset)
                SelectableTile(
                    title = title,
                    subtitle = subtitle,
                    selected = current == effort,
                    onClick = { onPick(effort) },
                )
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
        ReasoningPickList(current = current, onPick = onPick)
        SectionNote("Gilt ab dem nächsten Prompt dieser Session.")
    }
}

/**
 * Ab so vielen Einträgen lohnt sich das Suchfeld. Darunter wäre es Ballast:
 * drei Modelle sieht man auf einen Blick.
 */
private const val ModelSearchThreshold = 8

/**
 * Passt ein Modell zur Suche? Gesucht wird über Anzeigename *und* Id, ohne
 * auf Groß-/Kleinschreibung zu achten — „5.3“ findet „zai · GLM-5.3“ über
 * die Id `zai/glm-5.3`, „coding“ die Einträge von `zai-coding-cn`.
 * Eine leere Suche passt auf alles.
 */
fun modelMatchesQuery(model: ModelInfo, query: String): Boolean {
    val needle = query.trim()
    if (needle.isEmpty()) return true
    return model.id.contains(needle, ignoreCase = true) ||
        model.name?.contains(needle, ignoreCase = true) == true
}

/** Die gefilterte Liste; leere oder reine Whitespace-Suche gibt alles zurück. */
fun filterModels(models: List<ModelInfo>, query: String): List<ModelInfo> =
    if (query.isBlank()) models else models.filter { modelMatchesQuery(it, query) }

/**
 * Suchfeld über der Modellliste im One-UI-Stil: gefüllte Pille ohne Rand,
 * Lupe links, Kreuz zum Leeren rechts.
 */
@Composable
private fun ModelSearchField(
    query: String,
    onQueryChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = query,
        onValueChange = onQueryChange,
        placeholder = { Text("Modell suchen") },
        leadingIcon = {
            Icon(
                Icons.Filled.Search,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        trailingIcon = if (query.isNotEmpty()) {
            {
                IconButton(onClick = { onQueryChange("") }) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "Suche leeren",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        } else {
            null
        },
        singleLine = true,
        shape = PillShape,
        // One UI: jedes Suchfeld behält Autokorrektur und Vorschläge — anders
        // als das freie Modellfeld weiter unten ist das hier echte Textsuche.
        keyboardOptions = KeyboardOptions(
            imeAction = ImeAction.Search,
        ),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            focusedBorderColor = Color.Transparent,
            unfocusedBorderColor = Color.Transparent,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = ScreenGutter, end = ScreenGutter, bottom = 10.dp),
    )
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
    // Der Suchtext gehört dem geöffneten Sheet: Schließen und erneutes
    // Öffnen beginnt wieder bei der vollen Liste. rememberSaveable, damit
    // ein Fold/Rotation während der Suche sie nicht verwirft.
    var query by rememberSaveable { mutableStateOf("") }
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
                SectionNote("Dieser Agent liefert keine Modellliste – trag dein Modell unten ein.")
            } else {
                val searchable = state.models.size > ModelSearchThreshold
                if (searchable) ModelSearchField(query = query, onQueryChange = { query = it })
                val searching = searchable && query.isNotBlank()
                val visible = if (searchable) filterModels(state.models, query) else state.models
                // Mit offener Tastatur bleibt weniger Platz: die Liste gibt
                // ihn her, damit Suchfeld und Treffer sichtbar bleiben.
                val listMaxHeight = if (WindowInsets.isImeVisible) 200.dp else 320.dp
                if (visible.isEmpty()) {
                    Text(
                        text = "Kein Modell gefunden",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = ContentInset, vertical = 12.dp),
                    )
                } else {
                    GroupCard {
                        Column(
                            modifier = Modifier
                                .heightIn(max = listMaxHeight)
                                .verticalScroll(rememberScrollState()),
                        ) {
                            // Während gesucht wird zeigt die Liste nur
                            // Treffer – der Standard ist keiner davon.
                            if (!searching) {
                                SelectableTile(
                                    title = "Standard des Agenten",
                                    subtitle = "Modellwahl dem Agenten überlassen",
                                    selected = current.isBlank(),
                                    onClick = { onPick("") },
                                )
                            }
                            visible.forEachIndexed { index, model ->
                                if (index > 0 || !searching) ListDivider(RadioRowDividerInset)
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
        }
        // Eigener Zweck, eigene Sektion: hier wird ein Modell gesetzt, das
        // die Liste gar nicht kennt — nicht in ihr gesucht.
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
                keyboardOptions = KeyboardOptions(
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Done,
                ),
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
        SectionNote("Falls dein Modell nicht in der Liste steht.")
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
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(tween(MotionMedium, easing = OneUiEasing)) +
                    fadeIn(tween(MotionShort, easing = LinearEasing)),
                exit = shrinkVertically(tween(MotionMedium, easing = OneUiEasing)) +
                    fadeOut(tween(MotionShort, easing = LinearEasing)),
            ) {
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
                // Ein Button-Stil pro Karte: nur "Erlauben" ist gefüllt, alles
                // andere flacher TextButton. Die Rangfolge kommt aus Position
                // und Farbe, nicht mehr aus drei verschiedenen Hintergründen.
                null -> Column(modifier = Modifier.padding(top = 14.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            shape = PillShape,
                            onClick = { vm.decide(item.permissionId, PermissionDecision.ONCE) },
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = MinTouchTarget),
                        ) {
                            Text("Erlauben")
                        }
                        TextButton(
                            shape = PillShape,
                            onClick = { vm.decide(item.permissionId, PermissionDecision.ALWAYS) },
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = MinTouchTarget),
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
