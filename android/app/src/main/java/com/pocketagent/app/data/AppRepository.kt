package com.pocketagent.app.data

import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
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

/** Ein Turn-Zustandswechsel (`turn.status`), gemünzt auf genau eine Session. */
data class TurnStatusEnvelope(val sessionId: String, val turn: TurnInfo)

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

    /**
     * True, sobald die erste `session.list`-Antwort da war — auch eine leere
     * zählt. Unterscheidet „noch nicht geladen" von „wirklich leer" (Fund:
     * falscher Leer-Zustand beim Kaltstart der Session-Liste): ohne dieses
     * Flag zeigt die Liste beim App-Start kurz „Noch keine Session" samt CTA,
     * selbst wenn zehn Sessions unterwegs sind. Bleibt danach für die
     * Laufzeit der App true — ein Reconnect ist kein Kaltstart mehr.
     */
    private val _sessionsLoaded = MutableStateFlow(false)
    val sessionsLoaded: StateFlow<Boolean> = _sessionsLoaded

    private val _repos = MutableStateFlow<List<RepoInfo>>(emptyList())
    val repos: StateFlow<List<RepoInfo>> = _repos

    private val _secrets = MutableStateFlow<List<SecretInfo>>(emptyList())
    val secrets: StateFlow<List<SecretInfo>> = _secrets

    /**
     * Zuletzt gesehener Modellkatalog, aus früheren `session.models.get`-
     * Antworten gesammelt. Vor dem Anlegen einer Session existiert noch kein
     * Runner, der einen Katalog liefern könnte (`session.models.get` braucht
     * eine `sessionId`) — dieser Cache ist die einzige Quelle, aus der der
     * Anlege-Screen echte Modellnamen statt Freitext-Raten anbieten kann
     * (Fund: "Modell beim Anlegen nur Freitext mit Format-Raten"). Nur ein
     * Vorschlag aus einer früheren Session — kein vollständiger, garantiert
     * aktueller Katalog.
     */
    private val _knownModels = MutableStateFlow<List<ModelInfo>>(emptyList())
    val knownModels: StateFlow<List<ModelInfo>> = _knownModels

    private val _stats = MutableStateFlow<ServerStats?>(null)
    val stats: StateFlow<ServerStats?> = _stats

    private val _sessionEvents = MutableSharedFlow<SessionEventEnvelope>(
        extraBufferCapacity = 512,
        onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
    val sessionEvents: SharedFlow<SessionEventEnvelope> = _sessionEvents

    /**
     * Live-Turn-Zustandswechsel (`turn.status`). Getrennt von [sessionEvents],
     * weil ein Turn kein Timeline-Eintrag ist, sondern den Busy-Zustand und den
     * Idempotenz-Abgleich (messageId-Echo) einer Session trägt.
     */
    private val _turnStatus = MutableSharedFlow<TurnStatusEnvelope>(
        extraBufferCapacity = 128,
        onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
    val turnStatus: SharedFlow<TurnStatusEnvelope> = _turnStatus

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    private val pending = ConcurrentHashMap<String, CompletableDeferred<ServerMessage>>()

    @Volatile
    private var fcmToken: String? = null

    val tokenStore: TokenStore = tokens

    fun start() {
        fetchFcmToken()
        scope.launch {
            tokens.setup.collect { setup ->
                if (setup == null) {
                    // Abgemeldet: Verbindung kappen UND den Cache leeren. Ohne
                    // das trüge ein späteres Re-Pairing (evtl. anderer Server)
                    // noch die Sessions/Secrets/Repos des alten Kontos, bis die
                    // erste Antwort sie überschreibt — und die MainActivity, die
                    // `setup` jetzt als Flow beobachtet, zeigt sofort wieder den
                    // Pairing-Screen (Fund: Logout führt nicht zum Pairing zurück).
                    ws.disconnect()
                    _sessions.value = emptyList()
                    _sessionsLoaded.value = false
                    _secrets.value = emptyList()
                    _repos.value = emptyList()
                    _stats.value = null
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
                    fcmToken?.let { ws.send(encodeFcmRegister(it)) }
                }
            }
        }
    }

    private fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.SessionListMsg -> {
                _sessions.value = msg.sessions
                _sessionsLoaded.value = true
                completePending(msg.requestId, msg)
            }

            is ServerMessage.RepoListMsg -> {
                _repos.value = msg.repos
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

            is ServerMessage.TurnStatusMsg -> {
                _turnStatus.tryEmit(TurnStatusEnvelope(msg.sessionId, msg.turn))
                // Turn konsumieren statt ignorieren: sein Zustand treibt den
                // Busy-Status der Session — auch nach einem Reconnect, wo kein
                // eigenes Live-`status`-Event ankam. Nur zwischen RUNNING und
                // IDLE schalten; CREATING/STOPPED/ERROR bleibt unangetastet.
                val running = msg.turn.state.active
                _sessions.value = _sessions.value.map {
                    if (it.id != msg.sessionId) it
                    else when {
                        running -> it.copy(status = SessionStatus.RUNNING)
                        it.status == SessionStatus.RUNNING -> it.copy(status = SessionStatus.IDLE)
                        else -> it
                    }
                }
            }

            is ServerMessage.SessionTurnsMsg -> completePending(msg.requestId, msg)
            is ServerMessage.DeviceListMsg -> completePending(msg.requestId, msg)
            is ServerMessage.DeviceRevokedMsg -> completePending(msg.requestId, msg)
            is ServerMessage.LinkListMsg -> completePending(msg.requestId, msg)
            is ServerMessage.LinkRevokedMsg -> completePending(msg.requestId, msg)

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

    /**
     * Anfrage senden und die Antwort einheitlich auf ein [Result] abbilden:
     * ein `error` wird zum Misserfolg, eine fehlende Verbindung (null) ebenso,
     * und jede andere Antwort geht durch [map]. Gibt [map] null zurück, war die
     * Antwort unerwartet. Ersetzt das zehnfach kopierte
     * `when(response){ ErrorMsg->…; null->…; is X->…; else->… }`-Muster.
     */
    private suspend fun <T> requestAs(
        timeoutMs: Long = REQUEST_TIMEOUT_MS,
        jsonFactory: (requestId: String) -> String,
        map: (ServerMessage) -> T?,
    ): Result<T> = when (val response = request(timeoutMs, jsonFactory)) {
        is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
        null -> Result.failure(IllegalStateException("Keine Verbindung"))
        else -> map(response)?.let { Result.success(it) }
            ?: Result.failure(IllegalStateException("Unerwartete Antwort"))
    }

    suspend fun refreshSessions() {
        request { id -> encodeSessionList(id) }
    }

    suspend fun refreshRepos() {
        request { id -> encodeRepoList(id) }
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
        provider: String,
        model: String,
        mode: AgentMode,
        branch: String?,
        networkPolicy: String? = null,
    ): Result<String?> {
        val response = request { id ->
            encodeSessionCreate(id, repoId, provider, model, mode, branch, networkPolicy)
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
    suspend fun loadEvents(sessionId: String, limit: Int? = null): Result<List<AgentEvent>> =
        requestAs(jsonFactory = { id -> encodeSessionEventsGet(id, sessionId, limit) }) {
            (it as? ServerMessage.SessionEventsMsg)?.events
        }

    /**
     * Turn-Lebenszyklus einer Session (`session.turns.get`). Nach einem
     * Reconnect die verlässliche Quelle für den Ausgang jedes Turns, statt ihn
     * aus dem Event-Strom zu raten. Leere Liste ist ein gültiges Ergebnis.
     */
    suspend fun loadTurns(sessionId: String, limit: Int? = null): Result<List<TurnInfo>> =
        requestAs(jsonFactory = { id -> encodeSessionTurnsGet(id, sessionId, limit) }) {
            (it as? ServerMessage.SessionTurnsMsg)?.turns
        }

    /**
     * Titel der Session setzen; leerer String entfernt ihn. Der Server
     * bestätigt mit request.ok und schickt die geänderte Session als
     * session.status — die Liste aktualisiert sich darüber von selbst.
     */
    suspend fun renameSession(sessionId: String, title: String): Result<Unit> =
        requestAs(jsonFactory = { id -> encodeSessionRename(id, sessionId, title) }) { Unit }

    /** Session archivieren oder zurückholen; Antwortweg wie bei [renameSession]. */
    suspend fun setArchived(sessionId: String, archived: Boolean): Result<Unit> =
        requestAs(jsonFactory = { id -> encodeSessionArchive(id, sessionId, archived) }) { Unit }

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
     */
    suspend fun updateSession(
        sessionId: String,
        mode: AgentMode? = null,
        model: String? = null,
        reasoningEffort: ReasoningEffort? = null,
    ): Result<Unit> {
        return requestAs(jsonFactory = { id ->
            encodeSessionUpdate(id, sessionId, mode, model, reasoningEffort)
        }) { Unit }
    }

    /**
     * Modellkatalog des Session-Runners; leere Liste ist gültig.
     *
     * Ein nicht-leeres Ergebnis landet zusätzlich im [knownModels]-Cache —
     * die einzige Quelle für Modellvorschläge beim Anlegen einer neuen
     * Session, wo noch kein Runner läuft.
     */
    suspend fun loadModels(sessionId: String): Result<List<ModelInfo>> {
        val response = request { id -> encodeSessionModelsGet(id, sessionId) }
        return when (response) {
            is ServerMessage.SessionModelsMsg -> {
                if (response.models.isNotEmpty()) _knownModels.value = response.models
                Result.success(response.models)
            }
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
     *
     * Jeder Prompt trägt eine über den Turn stabile [messageId] (`msg_<zufall>`;
     * KILO-CLOUD-ANALYSE.md P1). Ambiguous-Admission-Regel: bleibt die
     * Bestätigung aus (null = Verbindung weg/uneindeutig), gilt die Annahme als
     * *unklar* — hier wird bewusst NICHT automatisch neu gesendet, sondern der
     * Misserfolg zurückgegeben (die UI überlässt dem Nutzer die Entscheidung).
     * Ein manuelles erneutes Senden benutzt dieselbe [messageId], sodass der
     * Server es als denselben Turn erkennt und keinen zweiten Agent-Turn startet.
     */
    suspend fun sendPrompt(
        sessionId: String,
        text: String,
        mode: AgentMode?,
        messageId: String = newMessageId(),
    ): Result<Unit> {
        val response = request { id -> encodeSessionPrompt(id, sessionId, text, mode, messageId) }
        return when (response) {
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> Result.success(Unit)
        }
    }

    fun sendPermission(sessionId: String, permissionId: String, decision: PermissionDecision): Boolean =
        ws.send(encodeSessionPermission(sessionId, permissionId, decision))

    /**
     * Antwortet zuverlässig auf eine Permission-Anfrage — auch dann, wenn der
     * Prozess gerade erst durch den Tap auf einen Notification-Aktionsbutton
     * gestartet wurde (App im Hintergrund/getötet, s.
     * `fcm.NotificationActionReceiver`). Wartet bis zu [connectTimeoutMs] auf
     * eine offene Verbindung, statt wie [sendPermission] sofort aufzugeben —
     * der normale Start-Pfad ([start]s tokens.setup-Collector) baut sie
     * ohnehin auf, das hier ist nur die aktive Wartezeit dafür und ein
     * sofortiger Reconnect-Anstoß, falls gerade ein Backoff läuft.
     *
     * [true] heißt: die Verbindung stand und `session.permission` ging raus —
     * wie beim In-App-Pfad (SessionScreen.decide) ist das fire-and-forget,
     * kein Beweis, dass der Agent sie schon verarbeitet hat. [false] heißt:
     * es kam innerhalb der Frist keine Verbindung zustande — der Aufrufer
     * weicht dann auf den Deep-Link in die Session aus, wo der Nutzer die
     * Entscheidung manuell trifft, sobald die App selbst verbunden ist.
     */
    suspend fun respondToPermission(
        sessionId: String,
        permissionId: String,
        decision: PermissionDecision,
        connectTimeoutMs: Long = PERMISSION_RESPONSE_CONNECT_TIMEOUT_MS,
    ): Boolean {
        val connected = awaitConnected(
            state = ws.state,
            timeoutMs = connectTimeoutMs,
            reconnect = { ws.reconnectNow(manual = true) },
        )
        if (!connected) return false
        return sendPermission(sessionId, permissionId, decision)
    }

    fun sendAbort(sessionId: String): Boolean = ws.send(encodeSessionAbort(sessionId))
    fun sendStop(sessionId: String): Boolean = ws.send(encodeSessionStop(sessionId))
    fun sendResume(sessionId: String): Boolean = ws.send(encodeSessionResume(sessionId))
    fun sendPush(sessionId: String): Boolean = ws.send(encodeSessionPush(sessionId))

    suspend fun addSecret(kind: String, value: String): Result<SecretInfo> =
        requestAs(jsonFactory = { id -> encodeSecretSet(id, kind, value) }) {
            (it as? ServerMessage.SecretSavedMsg)?.secret
        }

    /**
     * Live-Prüfung eines Keys beim Anbieter. Unabhängig vom Speichern; der
     * Wert wird nur für die Prüfung übertragen und nie zurückgeliefert.
     */
    suspend fun validateSecret(kind: String, value: String): Result<SecretValidation> =
        requestAs(jsonFactory = { id -> encodeSecretValidate(id, kind, value) }) {
            (it as? ServerMessage.SecretValidatedMsg)?.let { m ->
                SecretValidation(ok = m.ok, detail = m.detail, unverified = m.unverified)
            }
        }

    suspend fun deleteSecret(id: String): Boolean =
        request { requestId -> encodeSecretDelete(requestId, id) } is ServerMessage.SecretDeletedMsg

    suspend fun addRepo(fullName: String, defaultBranch: String): Result<RepoInfo> =
        requestAs(jsonFactory = { id -> encodeRepoAdd(id, fullName, defaultBranch) }) {
            (it as? ServerMessage.RepoAddedMsg)?.repo
        }

    /* ---------------- Geräte & Links ---------------- */

    /** Gekoppelte App-Geräte holen (`device.list`); leere Liste ist gültig. */
    suspend fun loadDevices(): Result<List<DeviceInfo>> =
        requestAs(jsonFactory = { id -> encodeDeviceList(id) }) {
            (it as? ServerMessage.DeviceListMsg)?.devices
        }

    /** Ein Gerät entkoppeln (`device.revoke`). */
    suspend fun revokeDevice(deviceId: String): Result<Unit> =
        requestAs(jsonFactory = { id -> encodeDeviceRevoke(id, deviceId) }) {
            if (it is ServerMessage.DeviceRevokedMsg) Unit else null
        }

    /** Verbundene Link-Agenten holen (`link.list`); leere Liste ist gültig. */
    suspend fun loadLinks(): Result<List<LinkInfo>> =
        requestAs(jsonFactory = { id -> encodeLinkList(id) }) {
            (it as? ServerMessage.LinkListMsg)?.links
        }

    /** Einen Link-Agenten trennen (`link.revoke`). */
    suspend fun revokeLink(linkId: String): Result<Unit> =
        requestAs(jsonFactory = { id -> encodeLinkRevoke(id, linkId) }) {
            if (it is ServerMessage.LinkRevokedMsg) Unit else null
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
                // Automatischer Auslöser (Netz/Vordergrund) — im Unauthorized-
                // Zustand darf das nicht erneut anklopfen (Fund: kein
                // Auto-Reconnect nach Server-Ablehnung).
                ws.reconnectNow(manual = false)
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

    /**
     * Aktiv abholen statt nur auf PocketFcmService.onNewToken zu warten — der
     * feuert nur bei Erst-Generierung/Rotation. Ohne das bleibt [fcmToken]
     * nach einem Prozess-Neustart zwischen Token-Generierung und Pairing oder
     * nach einem Re-Pairing (neues Gerät, Server-Reset) leer, und der
     * Connected-Hook oben registriert nie einen Token — Push bleibt still
     * tot, bis FCM zufällig rotiert (kann praktisch nie passieren).
     * Wird bei jedem Start aufgerufen (deckt auch Re-Pairing nach einem
     * Prozess-Neustart ab); Fehler werden stillschweigend geschluckt, wenn
     * Firebase nur mit Platzhaltern konfiguriert ist (PocketAgentApp.initFirebase).
     */
    private fun fetchFcmToken() {
        runCatching {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token -> onFcmToken(token) }
                .addOnFailureListener { /* kein Firebase / kein Netz — onNewToken holt es notfalls nach */ }
        }
    }

    suspend fun isPaired(): Boolean = tokens.setup.first() != null

    companion object {
        private const val REQUEST_TIMEOUT_MS = 15_000L

        /** Bremse für [ensureAlive] — s.o., gegen Anstoß-Stürme durch Doppel-Callbacks. */
        private const val ENSURE_ALIVE_DEBOUNCE_MS = 3_000L

        /** Kurzes Timeout der Liveness-Probe — soll schnell ehrlich sein, nicht 15s warten. */
        private const val ENSURE_ALIVE_TIMEOUT_MS = 4_000L

        /**
         * Zeitbudget für [respondToPermission], um die Verbindung aufzubauen.
         * Der Aufrufer (`NotificationActionReceiver.onReceive`) läuft in
         * `goAsync()` — Android gibt einem BroadcastReceiver dafür grob 10s,
         * bevor er als hängen geblieben gilt; 7s lassen Luft für den Rest der
         * Verarbeitung (Notification-Update, `pendingResult.finish()`).
         */
        const val PERMISSION_RESPONSE_CONNECT_TIMEOUT_MS = 7_000L
    }
}
