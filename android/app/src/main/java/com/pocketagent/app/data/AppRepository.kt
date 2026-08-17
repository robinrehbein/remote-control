package com.pocketagent.app.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class SessionEventEnvelope(val sessionId: String, val event: AgentEvent)

/**
 * Ergebnis einer Key-Prüfung. [unverified] heißt: für diese Art gibt es keine
 * Live-Prüfung — [ok] ist dann true, wird aber neutral dargestellt.
 */
data class SecretValidation(
    val ok: Boolean,
    val detail: String? = null,
    val unverified: Boolean = false,
)

class AppRepository(
    private val ws: WsClient,
    private val tokens: TokenStore,
    private val scope: CoroutineScope,
) {
    val connState: StateFlow<WsClient.ConnState> = ws.state

    private val _sessions = MutableStateFlow<List<SessionInfo>>(emptyList())
    val sessions: StateFlow<List<SessionInfo>> = _sessions

    private val _repos = MutableStateFlow<List<RepoInfo>>(emptyList())
    val repos: StateFlow<List<RepoInfo>> = _repos

    private val _adapters = MutableStateFlow<List<AdapterDescriptor>>(emptyList())
    val adapters: StateFlow<List<AdapterDescriptor>> = _adapters

    private val _secrets = MutableStateFlow<List<SecretInfo>>(emptyList())
    val secrets: StateFlow<List<SecretInfo>> = _secrets

    private val _stats = MutableStateFlow<ServerStats?>(null)
    val stats: StateFlow<ServerStats?> = _stats

    private val _sessionEvents = MutableSharedFlow<SessionEventEnvelope>(
        extraBufferCapacity = 512,
        onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
    val sessionEvents: SharedFlow<SessionEventEnvelope> = _sessionEvents

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    private val pending = ConcurrentHashMap<String, CompletableDeferred<ServerMessage>>()

    @Volatile
    private var fcmToken: String? = null

    val tokenStore: TokenStore = tokens

    fun start() {
        scope.launch {
            tokens.setup.collect { setup ->
                if (setup == null) {
                    ws.disconnect()
                } else {
                    val creds = tokens.credentials()
                    if (creds == null) {
                        ws.disconnect()
                    } else {
                        ws.configure(PairingApi.wsUrl(setup.serverUrl), creds)
                        ws.connect()
                    }
                }
            }
        }
        scope.launch {
            ws.messages.collect { msg -> handle(msg) }
        }
        scope.launch {
            ws.state.collect { st ->
                if (st is WsClient.ConnState.Connected) {
                    refreshSessions()
                    refreshRepos()
                    refreshAdapters()
                    fcmToken?.let { ws.send(encodeFcmRegister(it)) }
                }
            }
        }
    }

    private fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.SessionListMsg -> {
                _sessions.value = msg.sessions
                completePending(msg.requestId, msg)
            }

            is ServerMessage.RepoListMsg -> {
                _repos.value = msg.repos
                completePending(msg.requestId, msg)
            }

            is ServerMessage.AdapterListMsg -> {
                _adapters.value = msg.adapters
                completePending(msg.requestId, msg)
            }

            is ServerMessage.SecretListMsg -> {
                _secrets.value = msg.secrets
                completePending(msg.requestId, msg)
            }

            is ServerMessage.SecretSavedMsg -> {
                scope.launch { refreshSecretsQuiet() }
                completePending(msg.requestId, msg)
            }

            is ServerMessage.SecretDeletedMsg -> {
                scope.launch { refreshSecretsQuiet() }
                completePending(msg.requestId, msg)
            }

            is ServerMessage.SecretValidatedMsg -> completePending(msg.requestId, msg)

            is ServerMessage.ServerStatsMsg -> {
                _stats.value = msg.stats
                completePending(msg.requestId, msg)
            }

            is ServerMessage.SessionDiffMsg -> completePending(msg.requestId, msg)

            is ServerMessage.SessionEventsMsg -> completePending(msg.requestId, msg)

            is ServerMessage.SessionModelsMsg -> completePending(msg.requestId, msg)

            is ServerMessage.SessionDeletedMsg -> {
                _sessions.value = _sessions.value.filterNot { it.id == msg.sessionId }
                completePending(msg.requestId, msg)
            }

            is ServerMessage.SessionStatusMsg -> {
                val info = msg.session
                _sessions.value = when {
                    // Eine unbekannte Session (gerade angelegt, auch von einem
                    // anderen Gerät) wird eingefügt statt still ignoriert —
                    // sonst müsste jeder Aufrufer die Liste diffen, um sie zu
                    // finden.
                    info != null && _sessions.value.none { it.id == info.id } -> _sessions.value + info
                    else -> _sessions.value.map { existing ->
                        when {
                            info != null && existing.id == info.id -> info
                            existing.id == msg.sessionId -> existing.copy(status = msg.status)
                            else -> existing
                        }
                    }
                }
            }

            is ServerMessage.RepoAddedMsg -> {
                _repos.value = (_repos.value + msg.repo).distinctBy { it.id }
                completePending(msg.requestId, msg)
            }

            is ServerMessage.SessionEventMsg -> {
                _sessionEvents.tryEmit(SessionEventEnvelope(msg.sessionId, msg.event))
                if (msg.event is AgentEvent.Status) {
                    val st = msg.event
                    _sessions.value = _sessions.value.map {
                        if (it.id == msg.sessionId) {
                            it.copy(status = if (st.busy) SessionStatus.RUNNING else SessionStatus.IDLE)
                        } else it
                    }
                }
            }

            is ServerMessage.ErrorMsg -> {
                _lastError.value = msg.message
                msg.requestId?.let { completePending(it, msg) }
            }

            is ServerMessage.RequestOk -> completePending(msg.requestId, msg)
            is ServerMessage.Welcome -> Unit
        }
    }

    private fun completePending(requestId: String, msg: ServerMessage) {
        pending.remove(requestId)?.complete(msg)
    }

    /* ---------------- request/response ---------------- */

    suspend fun request(
        timeoutMs: Long = REQUEST_TIMEOUT_MS,
        jsonFactory: (requestId: String) -> String,
    ): ServerMessage? {
        val id = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<ServerMessage>()
        pending[id] = deferred
        val sent = ws.send(jsonFactory(id))
        if (!sent) {
            pending.remove(id)
            return null
        }
        return try {
            withTimeoutOrNull(timeoutMs) { deferred.await() }
        } finally {
            pending.remove(id)
        }
    }

    suspend fun refreshSessions() {
        request { id -> encodeSessionList(id) }
    }

    suspend fun refreshRepos() {
        request { id -> encodeRepoList(id) }
    }

    suspend fun refreshAdapters() {
        request { id -> encodeAdapterList(id) }
    }

    suspend fun refreshStats() {
        request { id -> encodeServerStats(id) }
    }

    private suspend fun refreshSecretsQuiet() {
        request { id -> encodeSecretList(id) }
    }

    suspend fun loadSecrets() {
        refreshSecretsQuiet()
    }

    /**
     * Session anlegen. Bei Erfolg trägt das Ergebnis die Id aus der
     * Server-Bestätigung (`request.ok.payload.sessionId`) — der einzige
     * verlässliche Weg, „die gerade angelegte Session“ zu meinen. null heißt:
     * angelegt, aber ein älterer Server nannte die Id nicht (Aufrufer fällt
     * auf den Listen-Diff zurück).
     */
    suspend fun createSession(
        repoId: String,
        adapter: String,
        provider: String,
        model: String,
        mode: AgentMode,
        branch: String?,
        networkPolicy: String? = null,
    ): Result<String?> {
        val response = request { id ->
            encodeSessionCreate(id, repoId, adapter, provider, model, mode, branch, networkPolicy)
        }
        return when (response) {
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            is ServerMessage.RequestOk -> {
                refreshSessions()
                Result.success(ackedSessionId(response))
            }

            else -> {
                refreshSessions()
                Result.success(null)
            }
        }
    }

    /** `sessionId` aus dem Payload einer `request.ok`-Bestätigung, falls vorhanden. */
    private fun ackedSessionId(msg: ServerMessage.RequestOk): String? {
        val payload = msg.payload as? JsonObject ?: return null
        val value = payload["sessionId"] as? JsonPrimitive ?: return null
        return value.takeIf { it !is JsonNull }?.content?.takeIf { it.isNotBlank() }
    }

    /**
     * Der serverseitig gespeicherte Verlauf einer Session, chronologisch mit
     * dem ältesten Ereignis zuerst. Eine leere Liste ist ein gültiges
     * Ergebnis; nur ein Fehler oder eine fehlende Verbindung sind Misserfolg.
     */
    suspend fun loadEvents(sessionId: String, limit: Int? = null): Result<List<AgentEvent>> {
        val response = request { id -> encodeSessionEventsGet(id, sessionId, limit) }
        return when (response) {
            is ServerMessage.SessionEventsMsg -> Result.success(response.events)
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.failure(IllegalStateException("Unerwartete Antwort"))
        }
    }

    /**
     * Titel der Session setzen; leerer String entfernt ihn. Der Server
     * bestätigt mit request.ok und schickt die geänderte Session als
     * session.status — die Liste aktualisiert sich darüber von selbst.
     */
    suspend fun renameSession(sessionId: String, title: String): Result<Unit> {
        val response = request { id -> encodeSessionRename(id, sessionId, title) }
        return when (response) {
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.success(Unit)
        }
    }

    /** Session archivieren oder zurückholen; Antwortweg wie bei [renameSession]. */
    suspend fun setArchived(sessionId: String, archived: Boolean): Result<Unit> {
        val response = request { id -> encodeSessionArchive(id, sessionId, archived) }
        return when (response) {
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.success(Unit)
        }
    }

    suspend fun loadDiff(sessionId: String): Result<List<DiffEntry>> {
        val response = request { id -> encodeSessionDiffGet(id, sessionId) }
        return when (response) {
            is ServerMessage.SessionDiffMsg -> Result.success(response.diff)
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.success(emptyList())
        }
    }

    /**
     * Modus/Modell/Reasoning einer laufenden Session setzen. Der Server
     * antwortet zusätzlich mit session.status an alle Geräte, die Liste
     * aktualisiert sich also über das bestehende Handling.
     * [adapter] wechselt den Agenten; das passiert serverseitig asynchron,
     * der Fortschritt kommt ebenfalls als session.status.
     */
    suspend fun updateSession(
        sessionId: String,
        mode: AgentMode? = null,
        model: String? = null,
        reasoningEffort: ReasoningEffort? = null,
        adapter: String? = null,
    ): Result<Unit> {
        val response = request { id ->
            encodeSessionUpdate(id, sessionId, mode, model, reasoningEffort, adapter)
        }
        return when (response) {
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.success(Unit)
        }
    }

    /** Modellkatalog des Session-Shims; leere Liste ist gültig. */
    suspend fun loadModels(sessionId: String): Result<List<ModelInfo>> {
        val response = request { id -> encodeSessionModelsGet(id, sessionId) }
        return when (response) {
            is ServerMessage.SessionModelsMsg -> Result.success(response.models)
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.success(emptyList())
        }
    }

    suspend fun deleteSession(sessionId: String): Boolean =
        when (val response = request { id -> encodeSessionDelete(id, sessionId) }) {
            is ServerMessage.ErrorMsg -> false
            null -> false
            else -> true
        }

    /**
     * Prompt abschicken und auf die Bestätigung warten (`request.ok`), bevor
     * der Aufrufer den Text als angekommen behandelt. Der Server quittiert
     * jetzt explizit — ein `send()`, das nur „im Sendepuffer" hieß, reichte
     * nicht, um stillen Nachrichtenverlust nach einem Reconnect auszuschließen.
     */
    suspend fun sendPrompt(sessionId: String, text: String, mode: AgentMode?): Result<Unit> {
        val response = request { id -> encodeSessionPrompt(id, sessionId, text, mode) }
        return when (response) {
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.success(Unit)
        }
    }

    fun sendPermission(sessionId: String, permissionId: String, decision: PermissionDecision): Boolean =
        ws.send(encodeSessionPermission(sessionId, permissionId, decision))

    fun sendAbort(sessionId: String): Boolean = ws.send(encodeSessionAbort(sessionId))
    fun sendStop(sessionId: String): Boolean = ws.send(encodeSessionStop(sessionId))
    fun sendResume(sessionId: String): Boolean = ws.send(encodeSessionResume(sessionId))
    fun sendPush(sessionId: String): Boolean = ws.send(encodeSessionPush(sessionId))

    suspend fun addSecret(kind: String, value: String): Result<SecretInfo> {
        val response = request { id -> encodeSecretSet(id, kind, value) }
        return when (response) {
            is ServerMessage.SecretSavedMsg -> Result.success(response.secret)
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.failure(IllegalStateException("Unerwartete Antwort"))
        }
    }

    /**
     * Live-Prüfung eines Keys beim Anbieter. Unabhängig vom Speichern; der
     * Wert wird nur für die Prüfung übertragen und nie zurückgeliefert.
     */
    suspend fun validateSecret(kind: String, value: String): Result<SecretValidation> {
        val response = request { id -> encodeSecretValidate(id, kind, value) }
        return when (response) {
            is ServerMessage.SecretValidatedMsg -> Result.success(
                SecretValidation(
                    ok = response.ok,
                    detail = response.detail,
                    unverified = response.unverified,
                ),
            )

            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.failure(IllegalStateException("Unerwartete Antwort"))
        }
    }

    suspend fun deleteSecret(id: String): Boolean =
        request { requestId -> encodeSecretDelete(requestId, id) } is ServerMessage.SecretDeletedMsg

    suspend fun addRepo(fullName: String, defaultBranch: String): Result<RepoInfo> {
        val response = request { id -> encodeRepoAdd(id, fullName, defaultBranch) }
        return when (response) {
            is ServerMessage.RepoAddedMsg -> Result.success(response.repo)
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.failure(IllegalStateException("Unerwartete Antwort"))
        }
    }

    /** „Jetzt neu verbinden“ — überspringt die laufende Wartezeit. */
    fun reconnectNow() = ws.reconnectNow()

    /** Zeitpunkt der letzten Lebendigkeits-Prüfung — bremst Anstoß-Stürme. */
    @Volatile
    private var lastProbeAt = 0L

    /**
     * Sicherstellen, dass die Verbindung wirklich lebt — nicht nur laut
     * Zustand „Connected". Ein still gestorbener Socket (Netzwechsel, Doze)
     * meldet sich bei OkHttp erst nach bis zu ~20s (Ping 10s + Pong-Wartezeit);
     * bis dahin sieht alles gut aus, obwohl nichts mehr ankommt.
     *
     * Nicht suspend, damit Netz-Callback und Vordergrund-Wechsel sie ohne
     * eigene Coroutine anstoßen können — sie startet ihre Arbeit selbst im
     * [scope]. Debounced über [lastProbeAt]: `registerNetworkCallback` feuert
     * `onAvailable` sofort bei jeder Registrierung, also bei jedem
     * Vordergrund-Wechsel neu — ohne Bremse würde eine gesunde Verbindung
     * dauernd geprobt. Mehr als die Bremse braucht es nicht, die Prüfung
     * selbst ist billig.
     */
    fun ensureAlive() {
        val now = System.currentTimeMillis()
        if (now - lastProbeAt < ENSURE_ALIVE_DEBOUNCE_MS) return
        lastProbeAt = now
        scope.launch {
            if (ws.state.value !is WsClient.ConnState.Connected) {
                ws.reconnectNow()
                return@launch
            }
            // Laut Zustand verbunden — das beweist nicht, dass der Socket
            // noch lebt. Eine billige Anfrage mit kurzem Timeout deckt einen
            // stillen Tod auf; kommt keine Antwort, reisst forceReconnect
            // den toten Socket ab und baut sofort neu auf. Eine erfolgreiche
            // Antwort aktualisiert nebenbei die Sessionliste — erwünscht,
            // nicht nur ein Abfallprodukt der Prüfung.
            val response = request(timeoutMs = ENSURE_ALIVE_TIMEOUT_MS) { id -> encodeSessionList(id) }
            if (response == null) {
                ws.forceReconnect()
            }
        }
    }

    fun onFcmToken(token: String) {
        fcmToken = token
        if (ws.state.value is WsClient.ConnState.Connected) {
            ws.send(encodeFcmRegister(token))
        }
    }

    suspend fun awaitConnected() {
        val deadline = System.currentTimeMillis() + REQUEST_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline &&
            ws.state.value !is WsClient.ConnState.Connected
        ) {
            delay(200)
        }
    }

    suspend fun isPaired(): Boolean = tokens.setup.first() != null

    companion object {
        private const val REQUEST_TIMEOUT_MS = 15_000L

        /** Bremse für [ensureAlive] — s.o., gegen Anstoß-Stürme durch Doppel-Callbacks. */
        private const val ENSURE_ALIVE_DEBOUNCE_MS = 3_000L

        /** Kurzes Timeout der Liveness-Probe — soll schnell ehrlich sein, nicht 15s warten. */
        private const val ENSURE_ALIVE_TIMEOUT_MS = 4_000L
    }
}
