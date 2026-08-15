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
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class SessionEventEnvelope(val sessionId: String, val event: AgentEvent)

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

            is ServerMessage.ServerStatsMsg -> {
                _stats.value = msg.stats
                completePending(msg.requestId, msg)
            }

            is ServerMessage.SessionDiffMsg -> completePending(msg.requestId, msg)

            is ServerMessage.SessionDeletedMsg -> {
                _sessions.value = _sessions.value.filterNot { it.id == msg.sessionId }
                completePending(msg.requestId, msg)
            }

            is ServerMessage.SessionStatusMsg -> {
                val info = msg.session
                _sessions.value = _sessions.value.map { existing ->
                    when {
                        info != null && existing.id == info.id -> info
                        existing.id == msg.sessionId -> existing.copy(status = msg.status)
                        else -> existing
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

    suspend fun request(jsonFactory: (requestId: String) -> String): ServerMessage? {
        val id = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<ServerMessage>()
        pending[id] = deferred
        val sent = ws.send(jsonFactory(id))
        if (!sent) {
            pending.remove(id)
            return null
        }
        return try {
            withTimeoutOrNull(REQUEST_TIMEOUT_MS) { deferred.await() }
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

    suspend fun createSession(
        repoId: String,
        adapter: String,
        provider: String,
        model: String,
        mode: AgentMode,
        branch: String?,
        networkPolicy: String? = null,
    ): Result<Unit> {
        val response = request { id ->
            encodeSessionCreate(id, repoId, adapter, provider, model, mode, branch, networkPolicy)
        }
        return when (response) {
            is ServerMessage.ErrorMsg -> Result.failure(IllegalStateException(response.message))
            null -> Result.failure(IllegalStateException("Keine Verbindung"))
            else -> {
                refreshSessions()
                Result.success(Unit)
            }
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

    suspend fun deleteSession(sessionId: String): Boolean =
        when (val response = request { id -> encodeSessionDelete(id, sessionId) }) {
            is ServerMessage.ErrorMsg -> false
            null -> false
            else -> true
        }

    fun sendPrompt(sessionId: String, text: String, mode: AgentMode?): Boolean =
        ws.send(encodeSessionPrompt(sessionId, text, mode))

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
    }
}
