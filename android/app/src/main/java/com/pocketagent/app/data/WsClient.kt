package com.pocketagent.app.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlin.math.min
import kotlin.random.Random

class WsClient(private val client: OkHttpClient) {

    sealed interface ConnState {
        data object Idle : ConnState
        data object Connecting : ConnState
        data class Connected(val serverVersion: String?) : ConnState
        data class Waiting(val retryInSec: Int) : ConnState
        data class Failed(val reason: String) : ConnState
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow<ConnState>(ConnState.Idle)
    val state: StateFlow<ConnState> = _state

    private val _messages = MutableSharedFlow<ServerMessage>(
        extraBufferCapacity = 512,
        onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
    val messages: SharedFlow<ServerMessage> = _messages

    @Volatile
    private var credentials: DeviceCredentials? = null

    @Volatile
    private var wsUrl: String? = null

    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    private var manualClose = false

    private var attempt = 0
    private var reconnectJob: Job? = null

    fun configure(url: String, creds: DeviceCredentials) {
        this.wsUrl = url
        this.credentials = creds
    }

    @Synchronized
    fun connect() {
        val url = wsUrl ?: return
        val creds = credentials ?: return
        if (_state.value is ConnState.Connecting || _state.value is ConnState.Connected) return
        manualClose = false
        _state.value = ConnState.Connecting
        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, listener)
    }

    @Synchronized
    fun disconnect() {
        manualClose = true
        reconnectJob?.cancel()
        reconnectJob = null
        attempt = 0
        socket?.close(1000, "client disconnect")
        socket = null
        _state.value = ConnState.Idle
    }

    fun send(json: String): Boolean =
        socket?.send(json) ?: false

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            attempt = 0
            credentials?.let { webSocket.send(encodeHello(it.deviceId, it.deviceToken)) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = parseServerMessage(text) ?: return
            if (msg is ServerMessage.Welcome) {
                _state.value = ConnState.Connected(msg.serverVersion)
            }
            _messages.tryEmit(msg)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            handleDisconnect(t.message ?: "connection failed")
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            handleDisconnect("closed ($code)")
        }
    }

    private fun handleDisconnect(reason: String) {
        socket = null
        if (manualClose) {
            _state.value = ConnState.Idle
            return
        }
        val delaySec = backoffSeconds(attempt)
        attempt += 1
        _state.value = if (attempt >= 3) ConnState.Failed(reason) else ConnState.Waiting(delaySec)
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delaySec * 1000L)
            connect()
        }
    }

    private fun backoffSeconds(attempt: Int): Int {
        val exp = min(60, 1 shl min(attempt, 6))
        val jitter = Random.nextInt(0, 750)
        return min(60, (exp * 1000 + jitter) / 1000).coerceAtLeast(1)
    }
}
