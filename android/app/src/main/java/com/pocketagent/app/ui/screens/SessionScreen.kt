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
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Difference
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.automirrored.filled.OpenInNew
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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.minimumInteractiveComponentSize
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
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
import com.pocketagent.app.ui.sheetPickListMaxHeight
import com.pocketagent.app.ui.theme.CardInset
import com.pocketagent.app.ui.theme.ChipHeight
import com.pocketagent.app.ui.theme.ChipSpacing
import com.pocketagent.app.ui.theme.ChipValueMaxWidth
import com.pocketagent.app.ui.theme.ComposerHeight
import com.pocketagent.app.ui.theme.ContentInset
import com.pocketagent.app.ui.theme.EmptyStateInset
import com.pocketagent.app.ui.theme.MinTouchTarget
import com.pocketagent.app.ui.theme.MonoMedium
import com.pocketagent.app.ui.theme.MonoSmall
import com.pocketagent.app.ui.theme.MotionMedium
import com.pocketagent.app.ui.theme.MotionShort
import com.pocketagent.app.ui.theme.OneUiEasing
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.RadioRowDividerInset
import com.pocketagent.app.ui.theme.ScreenGutter
import com.pocketagent.app.ui.theme.semantic
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/* ------------------------------------------------------------------ */
/* Timeline: Modell und Reduktion liegen in Timeline.kt                */
/* ------------------------------------------------------------------ */

/**
 * Textmarke des Runner-Image-Baus in den Fortschrittsmeldungen des Servers
 * („Runner-Image wird gebaut …", „Image wird gebaut (Schritt 7/14)" —
 * server/src/progress.ts: BUILD_MESSAGE). Der Bau hat in v2 keine eigene Phase
 * mehr, läuft aber weiterhin minutenlang; daran hängt der Geduldshinweis.
 */
private const val IMAGE_BUILD_MARKER = "Image wird gebaut"

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

    private val _models = MutableStateFlow<ModelsState>(ModelsState.Idle)
    val models: StateFlow<ModelsState> = _models

    /** Der laufende, live wachsende Assistententext (message.delta), noch nicht bestätigt. */
    data class StreamingMessage(val role: String, val text: String)

    private val _streaming = MutableStateFlow<StreamingMessage?>(null)
    val streaming: StateFlow<StreamingMessage?> = _streaming

    /**
     * Über den Turn stabile Nachrichten-Id des zuletzt gesendeten Prompts plus
     * der Text, zu dem sie gehört. Ein erneutes Senden desselben Textes benutzt
     * dieselbe Id (Idempotenz — kein zweiter Agent-Turn). Erst die Bestätigung
     * (request.ok) oder ein bestätigender turn.status verwirft sie.
     */
    private var pendingMessageId: String? = null
    private var pendingText: String? = null

    /**
     * Kollektoren dieser Bindung. Ein einziges SessionViewModel wird über den
     * Auswahlwechsel im Zwei-Spalten-Layout hinweg wiederverwendet (Fund:
     * ViewModel-Leak — pro je geöffneter Session ein VM samt Kollektoren am nie
     * gepoppten MAIN-Entry). Beim Rebind werden sie abgebrochen und neu gestartet.
     */
    private val bindJobs = mutableListOf<kotlinx.coroutines.Job>()
    private var bound = false

    fun bind(id: String, repo: AppRepository) {
        if (bound && sessionId == id) return
        // Alte Bindung sauber lösen, bevor die neue startet — sonst sammeln
        // sich Kollektoren an.
        bindJobs.forEach { it.cancel() }
        bindJobs.clear()
        historyJob?.cancel()
        liveWhileLoading.clear()
        // Zustand der vorigen Session zurücksetzen, damit ihr Verlauf/Busy nicht
        // in die neue durchschlägt.
        _items.value = emptyList()
        _streaming.value = null
        _busy.value = false
        _progress.value = null
        _session.value = null
        _sendFailed.value = false
        _sending.value = false
        _historyLoading.value = false
        _input.value = ""
        _deleted.value = false
        _models.value = ModelsState.Idle
        pendingMessageId = null
        pendingText = null

        sessionId = id
        repository = repo
        bound = true
        bindJobs += viewModelScope.launch {
            repository.sessions.collect { list ->
                val current = list.firstOrNull { it.id == id }
                _session.value = current
                if (current != null) {
                    // Sobald die Session nicht mehr startet, ist der Fortschritt
                    // erledigt — ein späterer Start beginnt wieder bei null.
                    if (current.status != SessionStatus.CREATING) _progress.value = null
                    // Busy aus dem (auch persistierten) Status ableiten (DoD 5):
                    // nach einem Prozess-Tod/Reconnect mitten im Turn hat diese
                    // App-Instanz das auslösende Live-`status`-Event nie gesehen —
                    // RUNNING heißt aber, ein Turn läuft, also Stop-Knopf +
                    // „Agent arbeitet …" zeigen. Bewusst nur EINSCHALTEN: das
                    // Ausschalten überlassen wir den maßgeblichen Live-Signalen
                    // (Status busy=false, turn.status terminal), sonst würde eine
                    // noch-IDLE-Statusmeldung kurz nach dem optimistischen Senden
                    // den „arbeitet"-Zustand fälschlich sofort wieder löschen.
                    if (current.status == SessionStatus.RUNNING) _busy.value = true
                }
            }
        }
        bindJobs += viewModelScope.launch {
            repository.sessionEvents.collect { envelope ->
                if (envelope.sessionId == id) applyEvent(envelope.event)
            }
        }
        // turn.status konsumieren: den Busy-Zustand tragen und den optimistisch
        // gesendeten Prompt mit dem bestätigten Turn abgleichen (messageId-Echo).
        bindJobs += viewModelScope.launch {
            repository.turnStatus.collect { envelope ->
                if (envelope.sessionId != id) return@collect
                val turn = envelope.turn
                _busy.value = turn.state.active
                if (turn.messageId != null && turn.messageId == pendingMessageId) {
                    // Der Server hat den Prompt als Turn angenommen — der
                    // Idempotenz-Zustand ist damit erledigt.
                    pendingMessageId = null
                    pendingText = null
                    _sendFailed.value = false
                }
            }
        }
        // Beim Öffnen und nach jedem erfolgreichen (Wieder-)Verbinden den
        // gespeicherten Verlauf holen. connState ist ein StateFlow, der
        // aktuelle Wert kommt also sofort — steht die Verbindung schon,
        // lädt das hier direkt; sonst, sobald sie steht.
        bindJobs += viewModelScope.launch {
            repository.connState.collect { state ->
                if (state is WsClient.ConnState.Connected) {
                    _sendFailed.value = false
                    loadHistory()
                }
            }
        }
        bindJobs += viewModelScope.launch { repository.refreshSessions() }
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
            // Beim Neuaufbau aus dem Verlauf einen ggf. stehengebliebenen
            // Streaming-Puffer verwerfen — der fertige Text steckt bereits als
            // message.completed im geladenen Verlauf. So entsteht nach einem
            // Reconnect kein Doppeltext (halber Live-Text + vollständige Historie).
            _streaming.value = null
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
        // Live-Streaming: Deltas des laufenden Turns akkumulieren und als ein
        // wachsendes Chat-Item unter der Timeline zeigen. Sie landen NIE in der
        // Timeline-Liste selbst (reduceTimeline lässt sie fallen) — der fertige
        // Text kommt gleich als message.completed und wird dort zur Chat-Karte,
        // während der Streaming-Puffer geleert wird.
        when (event) {
            is AgentEvent.MessageDelta -> {
                // Während der Verlauf lädt, keinen Live-Teiltext zeigen: der
                // Merge baut die Timeline gleich sauber neu auf.
                if (!_historyLoading.value) {
                    val current = _streaming.value
                    val base = if (current?.role == event.role) current.text else ""
                    _streaming.value = StreamingMessage(event.role, base + event.delta)
                }
                return
            }

            is AgentEvent.MessageCompleted -> _streaming.value = null

            else -> Unit
        }
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

            // Ein Fehler oder Abbruch beendet den Start: er wird als Zeile
            // gezeigt, die Fortschrittsanzeige hat dann nichts mehr zu melden.
            is AgentEvent.TurnFailed, is AgentEvent.ErrorEvent, is AgentEvent.TurnInterrupted ->
                _progress.value = null

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
        // Über den Turn stabile Id (Idempotenz, Tier 1): ein Retry DESSELBEN
        // Textes benutzt dieselbe [messageId] — der Server nimmt sie genau
        // einmal an und startet keinen zweiten Agent-Turn (kein doppeltes
        // Committen/Pushen). Ein geänderter Text ist ein neuer Turn mit neuer Id.
        val messageId = pendingMessageId?.takeIf { pendingText == text }
            ?: com.pocketagent.app.data.newMessageId().also {
                pendingMessageId = it
                pendingText = text
            }
        viewModelScope.launch {
            repository.sendPrompt(sessionId, text, null, messageId)
                .onSuccess {
                    // Bestätigt: Idempotenz-Zustand verwerfen.
                    pendingMessageId = null
                    pendingText = null
                    _sendFailed.value = false
                    _input.value = ""
                    _busy.value = true
                    append(TimelineItem.Chat("user", text))
                }
                .onFailure {
                    // Id + Text bleiben stehen (unklare Annahme): der nächste
                    // Tap wiederholt denselben Turn idempotent, statt einen
                    // zweiten anzustoßen.
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

    /* ---------------- Modus / Modell / Reasoning ---------------- */

    private fun update(
        mode: AgentMode? = null,
        model: String? = null,
        reasoningEffort: ReasoningEffort? = null,
    ) {
        viewModelScope.launch {
            // Erfolgsfall aktualisiert die UI über das session.status-Handling
            repository.updateSession(sessionId, mode, model, reasoningEffort)
                .onFailure {
                    // Kopfzeile bleibt handlungsleitend; der Servertext – falls
                    // vorhanden – steht nur als Nebensatz dahinter.
                    val cause = it.message?.takeIf { m -> m.isNotBlank() }?.let { m -> " ($m)" }.orEmpty()
                    append(TimelineItem.Error("Änderung konnte nicht übernommen werden – bitte erneut versuchen.$cause"))
                }
        }
    }

    fun setMode(mode: AgentMode) = update(mode = mode)

    /** Leerer String setzt auf den Standard des Agenten zurück. */
    fun setModel(model: String) = update(model = model.trim())

    fun setReasoning(effort: ReasoningEffort) = update(reasoningEffort = effort)

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
    // KEIN key mehr: ein einziges Session-VM je NavBackStackEntry. Im
    // Zwei-Spalten-Layout (SessionScreen liegt im nie gepoppten MAIN-Entry)
    // hielt der frühere key="session-$id" pro je geöffneter Session ein eigenes
    // VM samt drei Kollektoren + Timeline am Leben — jeder Reconnect feuerte
    // N× session.events.get (Fund: ViewModel-Leak). Jetzt bindet dasselbe VM
    // beim Auswahlwechsel um (bind bricht die alten Kollektoren ab). Im
    // Compact-Fall bekommt jede SESSION-Route ohnehin ihren eigenen
    // ViewModelStore, das VM stirbt also weiter mit ihrem Entry.
    val vm: SessionViewModel = viewModel { SessionViewModel().also { it.bind(sessionId, repository) } }
    LaunchedEffect(sessionId) { vm.bind(sessionId, repository) }
    val items by vm.items.collectAsState()
    val streaming by vm.streaming.collectAsState()
    val historyLoading by vm.historyLoading.collectAsState()
    val sendFailed by vm.sendFailed.collectAsState()
    val sending by vm.sending.collectAsState()
    val connState by repository.connState.collectAsState()
    val session by vm.session.collectAsState()
    val input by vm.input.collectAsState()
    val busy by vm.busy.collectAsState()
    val progress by vm.progress.collectAsState()
    val deleted by vm.deleted.collectAsState()
    val models by vm.models.collectAsState()

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
    // Der live wachsende Streaming-Text zählt als zusätzliches letztes Item.
    val totalCount = items.size + if (streaming != null) 1 else 0
    LaunchedEffect(totalCount, streaming?.text, historyLoading) {
        if (totalCount == 0 || historyLoading) return@LaunchedEffect
        val target = totalCount - 1
        if (!settled) {
            // Erstes Ansteuern ohne Animation: der Verlauf steht fertig unten.
            listState.scrollToItem(target)
            settled = true
        } else if (isNearListBottom(listState)) {
            // Nur nachziehen, wenn der Leser ohnehin (fast) am Ende steht —
            // sonst reißt jeder neue Delta/Event ihn aus dem Hochgescrollten
            // (Fund: Auto-Scroll reißt den Leser ans Ende).
            listState.animateScrollToItem(target)
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
                            // Autonomie, Modell und Reasoning stehen als Chips
                            // unten, dort auch änderbar (Fund: dieselbe
                            // Einstellung doppelt sichtbar) — die StatusLine
                            // trägt nur noch, was die Chips nicht tragen:
                            // Repository und eine Abweichung vom sicheren
                            // Netzwerk-Default.
                            StatusLine(
                                session = s,
                                details = listOfNotNull(
                                    sessionSubtitle(s),
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
                    // Der Turn-Abbruch lag früher hier oben als zweites Stop-
                    // Symbol neben „Session pausieren" im Menü — zwei Aktionen,
                    // die beide „etwas anhalten". Er sitzt jetzt im Composer: der
                    // runde Knopf wird zum Stop-Knopf, solange ein Auftrag läuft
                    // (siehe [composerButton]). Oben bleibt nur Diff + Menü.
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
                            // Der Pulsier-Punkt zeigt nur „arbeitet, noch kein
                            // Text". Sobald Deltas fließen, trägt der live
                            // wachsende Text selbst die Aussage und der Punkt weicht.
                            visible = busy && streaming == null,
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
                        // Kompakte Chip-Reihe: Autonomie, Modell, Reasoning.
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
                                    // Derselbe Begriff wie beim Anlegen einer
                                    // Session (Fund: "Autonomie" vs. "Modus"
                                    // heißen dieselbe Einstellung anders).
                                    label = "Autonomie",
                                    value = modeLabel(s.mode),
                                    enabled = chipsEnabled,
                                    onClick = { sheet = SessionSheet.MODE },
                                )
                                SettingChip(
                                    label = "Modell",
                                    value = s.model.ifBlank { "Standard" },
                                    enabled = chipsEnabled,
                                    onClick = {
                                        sheet = SessionSheet.MODEL
                                        vm.loadModels()
                                    },
                                )
                                SettingChip(
                                    label = "Reasoning",
                                    value = reasoningLabel(ReasoningEffort.fromRaw(s.reasoningEffort)),
                                    enabled = chipsEnabled,
                                    onClick = { sheet = SessionSheet.REASONING },
                                )
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
                            // Ein Knopf, drei Gestalten (siehe [composerButton]):
                            // läuft ein Auftrag, ist er der Stop-Knopf und bricht
                            // den laufenden Zug ab — das einzige Stop-Konzept für
                            // den Turn, im Daumenbereich, eindeutig „bricht das
                            // Laufende ab". Sonst sendet er (gefüllt, wenn es etwas
                            // zu senden gibt); solange die letzte Anfrage noch auf
                            // ihre Bestätigung wartet, dreht er und ist gesperrt —
                            // kein Doppel-Senden per Doppeltap.
                            val composer = composerButton(busy = busy, sending = sending)
                            FilledIconButton(
                                onClick = {
                                    when (composer) {
                                        ComposerButton.STOP -> vm.abort()
                                        ComposerButton.SEND -> vm.sendPrompt()
                                        ComposerButton.SENDING -> Unit
                                    }
                                },
                                enabled = when (composer) {
                                    ComposerButton.STOP -> true
                                    ComposerButton.SEND -> input.isNotBlank()
                                    ComposerButton.SENDING -> false
                                },
                                shape = CircleShape,
                                modifier = Modifier.size(ComposerHeight),
                            ) {
                                when (composer) {
                                    ComposerButton.STOP ->
                                        Icon(Icons.Filled.Stop, contentDescription = "Auftrag abbrechen")
                                    ComposerButton.SENDING -> CircularProgressIndicator(
                                        strokeWidth = 2.dp,
                                        modifier = Modifier.size(18.dp),
                                        color = MaterialTheme.colorScheme.onPrimary,
                                    )
                                    ComposerButton.SEND ->
                                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Senden")
                                }
                            }
                        }
                    }
                }
            }
        },
    ) { padding ->
        if (items.isEmpty() && streaming == null) {
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
                        modifier = Modifier.padding(horizontal = EmptyStateInset),
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
                // Der laufende, live wachsende Assistententext. Er ersetzt den
                // Pulsier-Punkt, sobald wirklich Text fließt; beim finalen
                // message.completed wird er geleert und derselbe Text erscheint
                // als reguläre Chat-Karte oben.
                streaming?.let { s ->
                    item(key = "streaming") { StreamingBubble(s) }
                }
            }
        }
    }

    when (sheet) {
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
            // v1 hatte für den Image-Bau eine eigene Phase; v2 meldet ihn als
            // 'container-start' (der Server baut das eine Runner-Image beim
            // ersten Session-Start selbst, server/src/docker.ts). Der Hinweis
            // hing an der alten Phase und war damit unerreichbar geworden —
            // deshalb hier zusätzlich an der Meldung erkannt.
            if (progress.phase == StartPhase.IMAGE_BUILD || progress.message.contains(IMAGE_BUILD_MARKER)) {
                Text(
                    text = "Der erste Start dauert einige Minuten – das Image wird einmalig gebaut.",
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
/* Modus / Modell / Reasoning — Chips + Bottom Sheets                  */
/* ------------------------------------------------------------------ */

enum class SessionSheet { MODE, MODEL, REASONING }

/**
 * Deutsche Labels statt englischem Jargon ('Yolo', 'Ask', 'Accept Edits') in
 * einer sonst komplett deutschen Oberfläche — die Namen tragen jetzt selbst
 * die Tragweite der Wahl, nicht nur die Untertitel im [ModeSheet]. Nur die
 * technischen Wire-Werte (`AgentMode.wireName()`) bleiben unverändert.
 */
fun modeLabel(mode: AgentMode): String = when (mode) {
    AgentMode.ASK -> "Nachfragen"
    AgentMode.ACCEPT_EDITS -> "Edits frei"
    AgentMode.AUTO -> "Automatisch"
    AgentMode.YOLO -> "Vollautomatisch"
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
 * Die Autonomieliste — dieselbe Einstellung, dieselbe Beschriftung an beiden
 * Stellen, die sie anbieten (laufende Session und Anlegen). Der Titel ist
 * bewusst kein Parameter mehr (Fund: "Autonomie" vs. "Modus" hießen dieselbe
 * Sache verschieden) — ohne ihn kann kein Aufrufer mehr abweichen.
 */
@Composable
fun ModeSheet(
    current: AgentMode?,
    onDismiss: () -> Unit,
    onPick: (AgentMode) -> Unit,
) {
    SettingSheet(title = "Autonomie", onDismiss = onDismiss) {
        GroupCard {
            Column {
                val entries = listOf(
                    Pair(AgentMode.ASK, "Jede Aktion wird vorher bestätigt"),
                    Pair(AgentMode.ACCEPT_EDITS, "Datei-Änderungen laufen durch, alles andere wird gefragt"),
                    Pair(AgentMode.AUTO, "Agent entscheidet selbst, Push nur manuell"),
                    Pair(AgentMode.YOLO, "Vollautomatisch inklusive Push und Draft-PR"),
                )
                entries.forEachIndexed { index, (mode, subtitle) ->
                    if (index > 0) ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        // Dasselbe deutsche Label wie auf Chips und Karten
                        // (modeLabel) — sonst hieße derselbe Modus im Sheet
                        // anders als dort, wo er ausgewählt wird.
                        title = modeLabel(mode),
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
                val listMaxHeight = sheetPickListMaxHeight()
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

// internal statt private: der Render-Test (TimelineRenderTest) baut über
// genau diesen Einstiegspunkt jede Timeline-Karte wirklich auf — die
// Endlos-Rekursion im Markdown-Renderer überlebte jahrelang, weil kein
// Test je die Compose-UI gerendert hat. Die einzelnen Karten bleiben
// private; [vm] wird nur in Klick-Handlern angefasst, ein unge-bundenes
// SessionViewModel() reicht dem Test darum aus.
@Composable
internal fun TimelineItemView(item: TimelineItem, vm: SessionViewModel) {
    when (item) {
        is TimelineItem.Chat -> ChatBubble(item)
        is TimelineItem.Tool -> ToolCard(item)
        is TimelineItem.Approval -> ApprovalCard(item, vm)
        is TimelineItem.TurnEnd -> if (item.interrupted) {
            // Abgebrochener Turn (Stop/Neustart): eigener Wortlaut und Icon,
            // damit „unterbrochen" nicht wie ein regulärer Abschluss aussieht.
            SystemLine(
                text = listOfNotNull(
                    "Unterbrochen",
                    item.summary?.takeIf { it.isNotBlank() },
                ).joinToString(" · "),
                icon = Icons.Outlined.Close,
            )
        } else {
            SystemLine(
                // summary wird jetzt mit angezeigt statt still verworfen (Tier 6):
                // „Fertig · <sha> · <summary>".
                text = listOfNotNull(
                    "Fertig",
                    item.commitSha?.take(7),
                    item.summary?.takeIf { it.isNotBlank() },
                ).joinToString(" · "),
                icon = Icons.Outlined.Check,
            )
        }

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

/**
 * Die live wachsende Assistenten-Blase (message.delta). Dieselbe Gestalt wie
 * eine fertige Assistenten-Chat-Karte, nur mit einem kleinen Pulsier-Punkt als
 * Zeichen, dass der Text noch fließt. Sie verschwindet beim finalen
 * message.completed und weicht der regulären Chat-Karte.
 */
@Composable
private fun StreamingBubble(message: SessionViewModel.StreamingMessage) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Surface(
            shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 6.dp, bottomEnd = 20.dp),
            color = MaterialTheme.colorScheme.surfaceContainer,
            modifier = Modifier.weight(1f),
        ) {
            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                MarkdownText(text = message.text)
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(top = 4.dp),
                ) {
                    PulsingDot(color = MaterialTheme.colorScheme.primary, pulse = true, size = 6.dp)
                }
            }
        }
        Spacer(modifier = Modifier.width(40.dp))
    }
}

/**
 * Steht der Leser (fast) am Ende der Liste? Nur dann darf ein neues Ereignis
 * automatisch nachziehen. „Fast" heißt: das letzte oder vorletzte Item ist
 * sichtbar — so folgt der Verlauf beim Mitlesen, reißt aber niemanden aus einer
 * hochgescrollten Stelle.
 */
private fun isNearListBottom(state: androidx.compose.foundation.lazy.LazyListState): Boolean {
    val layout = state.layoutInfo
    val last = layout.visibleItemsInfo.lastOrNull() ?: return true
    return last.index >= layout.totalItemsCount - 2
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
                        // Ohne eigenen Titel steht der Toolname schon in der
                        // Zeile darüber (Fund: ToolCard nennt das Tool
                        // doppelt) — die Unterzeile trägt dann nur den Status.
                        text = if (item.title == null) statusText else "${item.tool} · $statusText",
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
                // Rangfolge statt Gleichrang (Fund: "Immer" so groß wie
                // "Erlauben", "Ablehnen" unauffällig darunter): "Erlauben"
                // ist die gefüllte Hauptaktion, "Ablehnen" die sichere
                // Alternative auf gleicher Höhe daneben — beide ein Tap.
                // "Immer erlauben" ist die weitreichendste Entscheidung der
                // Karte (gilt für alle künftigen gleichen Aktionen) und
                // steht darum kleiner darunter: ein bewusster Zweit-Tap,
                // kein bequemer Nachbar der Einmal-Erlaubnis.
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
                        OutlinedButton(
                            shape = PillShape,
                            onClick = { vm.decide(item.permissionId, PermissionDecision.REJECT) },
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = MinTouchTarget),
                        ) {
                            Text("Ablehnen")
                        }
                    }
                    TextButton(
                        shape = PillShape,
                        onClick = { vm.decide(item.permissionId, PermissionDecision.ALWAYS) },
                        contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                        modifier = Modifier
                            .padding(top = 6.dp)
                            .heightIn(min = MinTouchTarget),
                    ) {
                        Text("Immer erlauben", style = MaterialTheme.typography.labelMedium)
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
    val uriHandler = LocalUriHandler.current
    val prUrl = item.prUrl?.takeIf { it.isNotBlank() }
    // Der Höhepunkt des Flusses ist kein toter Steckbrief: liegt ein PR vor,
    // öffnet ein Tap auf die Karte ihn im Browser — der Erfolg ist ein
    // handlungsfähiger Zustand, keine reine Meldung. Ohne PR gibt es kein
    // Ziel, dann bleibt die Karte eine ruhige Bestätigung.
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.primaryContainer,
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (prUrl != null) {
                    Modifier.clickable(
                        onClickLabel = "Pull Request öffnen",
                        role = Role.Button,
                        onClick = { uriHandler.openUri(prUrl) },
                    )
                } else {
                    Modifier
                },
            ),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(14.dp),
        ) {
            Column(modifier = Modifier.weight(1f)) {
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
                            prUrl?.let { "Draft-PR erstellt" },
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
                if (prUrl != null) {
                    Text(
                        text = "Pull Request öffnen",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
            if (prUrl != null) {
                Spacer(modifier = Modifier.width(10.dp))
                Icon(
                    Icons.AutoMirrored.Filled.OpenInNew,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(20.dp),
                )
            }
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
