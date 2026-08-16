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
import kotlin.random.Random

class WsClient(private val client: OkHttpClient) {

    /**
     * Die vier ehrlichen Zustände. Es gibt bewusst kein „gescheitert“ mehr:
     * solange die App weiterprobiert, sagt sie das auch — mit Restzeit.
     */
    sealed interface ConnState {
        /** Noch nicht gestartet oder bewusst getrennt. */
        data object Idle : ConnState
        data object Connecting : ConnState
        data class Connected(val serverVersion: String?) : ConnState

        /** Nächster Versuch läuft; [retryInSec] zählt sichtbar herunter. */
        data class Waiting(val retryInSec: Int, val reason: String? = null) : ConnState

        /** Getrennt, ohne laufenden Versuch — praktisch immer: kein Netz. */
        data class Disconnected(val reason: String) : ConnState
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

    /**
     * Was Android über das Netz meldet. Ohne Beobachter (Tests, früher Start)
     * bleibt es true — dann verhält sich der Client wie bisher.
     */
    @Volatile
    private var networkAvailable = true

    private val backoff = Backoff()
    private var reconnectJob: Job? = null

    /** Zeitpunkt des letzten Verbindungsversuchs — bremst Anstoß-Stürme. */
    @Volatile
    private var lastAttemptAt = 0L

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
        lastAttemptAt = System.currentTimeMillis()
        _state.value = ConnState.Connecting
        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, listener)
    }

    @Synchronized
    fun disconnect() {
        manualClose = true
        reconnectJob?.cancel()
        reconnectJob = null
        backoff.reset()
        socket?.close(1000, "client disconnect")
        socket = null
        _state.value = ConnState.Idle
    }

    /**
     * Sofort neu verbinden, ohne den Backoff abzuwarten — für den Tap auf die
     * Statuszeile, den Wechsel in den Vordergrund und „Netz ist wieder da“.
     * Läuft bereits eine Verbindung, passiert nichts.
     */
    @Synchronized
    fun reconnectNow() {
        if (wsUrl == null || credentials == null) return
        if (_state.value is ConnState.Connected || _state.value is ConnState.Connecting) return
        // Mehrere Anstöße kurz hintereinander (zwei Netze werden gleichzeitig
        // verfügbar, dazu der Vordergrund-Wechsel) sind ein einziger Versuch.
        if (System.currentTimeMillis() - lastAttemptAt < MIN_ATTEMPT_GAP_MS) return
        reconnectJob?.cancel()
        reconnectJob = null
        backoff.reset()
        connect()
    }

    /** Android meldet ein nutzbares Netz. */
    fun onNetworkAvailable() {
        networkAvailable = true
        if (manualClose) return
        reconnectNow()
    }

    /** Android meldet, dass kein Netz mehr da ist. */
    fun onNetworkLost() {
        networkAvailable = false
        // Kein eigener Abbruch: OkHttp merkt es selbst. Nur ehrlich anzeigen,
        // dass gerade nichts zu holen ist, statt eine Restzeit vorzugaukeln.
        if (!manualClose && _state.value is ConnState.Waiting) {
            _state.value = ConnState.Disconnected("Kein Netz")
        }
    }

    /**
     * false heißt: ging nicht raus. Der Zustand wird mitgeprüft, damit eine
     * Anfrage auf einem toten Socket sofort scheitert, statt in den
     * 15s-Timeout zu laufen — und damit der Composer weiß, dass er den Text
     * behalten muss. Ein true bleibt trotzdem nur „im Sendepuffer“.
     */
    fun send(json: String): Boolean {
        if (_state.value !is ConnState.Connected) return false
        return socket?.send(json) ?: false
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            credentials?.let { webSocket.send(encodeHello(it.deviceId, it.deviceToken)) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = parseServerMessage(text) ?: return
            if (msg is ServerMessage.Welcome) {
                // Erst das Welcome ist ein wirklich erfolgreicher Aufbau —
                // eine offene, aber abgelehnte Verbindung darf den Backoff
                // nicht zurücksetzen.
                backoff.reset()
                _state.value = ConnState.Connected(msg.serverVersion)
            }
            _messages.tryEmit(msg)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            handleDisconnect(t.message ?: "Verbindung abgebrochen")
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            handleDisconnect("Verbindung geschlossen ($code)")
        }
    }

    @Synchronized
    private fun handleDisconnect(reason: String) {
        socket = null
        if (manualClose) {
            _state.value = ConnState.Idle
            return
        }
        val delaySec = backoff.nextSeconds()
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            // Sichtbar herunterzählen: der Nutzer soll sehen, dass es
            // weitergeht, statt eine stehende „Fehler“-Zeile zu lesen.
            var left = delaySec
            while (left > 0) {
                _state.value = if (networkAvailable) {
                    ConnState.Waiting(left, reason)
                } else {
                    ConnState.Disconnected("Kein Netz")
                }
                delay(1_000L)
                left -= 1
            }
            delay(Random.nextLong(0, JITTER_MS))
            connect()
        }
    }

    private companion object {
        const val MIN_ATTEMPT_GAP_MS = 900L
        const val JITTER_MS = 400L
    }
}
