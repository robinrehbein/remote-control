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
     * Die ehrlichen Zustände. Es gibt bewusst kein generisches „gescheitert“:
     * solange die App weiterprobiert, sagt sie das auch — mit Restzeit. Die
     * einzige Ausnahme ist [Unauthorized]: da hat der Server explizit nein
     * gesagt, weiterprobieren wäre falsch.
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

        /**
         * Der Server hat das Gerät abgelehnt (Token unbekannt oder entzogen,
         * Close-Code 4001). Kein automatischer Reconnect — das wäre nur
         * weiteres Klopfen an eine Tür, die bewusst zu ist. Ein manueller
         * Tap (`reconnectNow`) darf es trotzdem versuchen, z.B. nach
         * erneutem Koppeln mit einem neuen Token.
         */
        data object Unauthorized : ConnState
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
        credentials ?: return
        if (_state.value is ConnState.Connecting || _state.value is ConnState.Connected) return
        doConnect(url)
    }

    /**
     * Der eigentliche Verbindungsaufbau, ohne den Connected/Connecting-Guard
     * von [connect] — den braucht [forceReconnect], der genau aus Connected
     * heraus neu verbinden will. Ruft nur mit bereits geprüftem [url] auf.
     */
    @Synchronized
    private fun doConnect(url: String) {
        manualClose = false
        // Ohne dieses Aufräumen kann ein zweiter Aufruf (z.B. eine fremde
        // DataStore-Re-Emission, die tokens.setup erneut auslöst, während
        // ein Waiting-Countdown läuft) den laufenden reconnectJob überleben
        // lassen und einen alten, noch offenen Socket verwaisen: der Job
        // überschreibt den Zustand am Ende seines Countdowns weiter und ruft
        // selbst noch einmal connect() — zwei parallele Verbindungen sind die
        // Folge (jedes Event doppelt, serverseitiges Verbindungslimit droht).
        reconnectJob?.cancel()
        reconnectJob = null
        socket?.cancel()
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
     *
     * [manual] unterscheidet den bewussten Nutzer-Tap von automatischen
     * Auslösern (Netz zurück, Vordergrund): im Zustand [ConnState.Unauthorized]
     * hat der Server das Gerät explizit abgelehnt — das ist keine Netzstörung,
     * die von selbst wieder gut wird. Automatische Auslöser dürfen dort nicht
     * erneut anklopfen, nur ein echter Tap darf es versuchen (z.B. nach
     * erneutem Koppeln mit einem neuen Token).
     */
    @Synchronized
    fun reconnectNow(manual: Boolean = true) {
        if (wsUrl == null || credentials == null) return
        if (_state.value is ConnState.Connected || _state.value is ConnState.Connecting) return
        if (!manual && _state.value is ConnState.Unauthorized) return
        // Mehrere Anstöße kurz hintereinander (zwei Netze werden gleichzeitig
        // verfügbar, dazu der Vordergrund-Wechsel) sind ein einziger Versuch.
        if (System.currentTimeMillis() - lastAttemptAt < MIN_ATTEMPT_GAP_MS) return
        reconnectJob?.cancel()
        reconnectJob = null
        backoff.reset()
        connect()
    }

    /**
     * Reisst eine als „Connected“ gemeldete, aber tatsächlich tote Verbindung
     * hart ab und baut sofort neu auf. Für den Fall, dass ein Socket still
     * gestorben ist (Netzwechsel, Doze) und OkHttp das noch nicht bemerkt hat
     * — das dauert bis zu ~20s (Ping alle 10s + Pong-Wartezeit). [connect]
     * allein hilft hier nicht: sein Connected-Guard würde sofort zurückkehren,
     * ohne etwas zu tun.
     */
    @Synchronized
    fun forceReconnect() {
        if (manualClose) return
        val url = wsUrl ?: return
        credentials ?: return
        reconnectJob?.cancel()
        reconnectJob = null
        // Hartes Abreissen ohne Close-Handshake — der Socket antwortet
        // ohnehin nicht mehr. socket wird schon hier auf null gesetzt (und
        // sofort durch doConnect neu belegt), damit handleDisconnect den
        // gleich folgenden onFailure-Callback des alten (abgerissenen)
        // Sockets an seiner veralteten Referenz erkennt und ignoriert —
        // sonst würde er einen zweiten, überflüssigen Reconnect-Zyklus
        // anstossen.
        socket?.cancel()
        socket = null
        backoff.reset()
        doConnect(url)
    }

    /** Android meldet ein nutzbares Netz. */
    fun onNetworkAvailable() {
        networkAvailable = true
        if (manualClose) return
        reconnectNow(manual = false)
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
            handleDisconnect(webSocket, t.message ?: "Verbindung abgebrochen")
        }

        /**
         * OkHttp ruft [onClosed] nur auf, wenn der Client den Close-Handshake
         * selbst abschliesst (also nach einem eigenen `close()`-Aufruf). Ein
         * vom Server initiierter Close — genau der Fall bei Code 4001 — löst
         * beim Client zunächst nur [onClosing] aus; ohne diese Überschreibung
         * bliebe die Unauthorized-Erkennung toter Code (der Server-Close
         * hängt, bis der nächste Ping-Timeout generisch retryt). Deshalb wird
         * hier geprüft und bestätigt, statt auf [onClosed] zu warten.
         */
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            if (isUnauthorizedClose(code, reason)) {
                handleUnauthorized(webSocket)
            }
            // Handshake in jedem Fall abschliessen, damit OkHttp den Socket
            // sauber beendet und (für den Nicht-Unauthorized-Fall) onClosed
            // regulär nachläuft.
            webSocket.close(code, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            // Der Server lehnt das Gerät endgültig ab (unbekanntes oder
            // entzogenes Token) — das ist kein Netzflackern, also gehört es
            // nicht in den generischen Retry-Loop von handleDisconnect. Der
            // Normalfall dafür läuft schon über onClosing (s.o.); dieser Zweig
            // bleibt als zweite Absicherung stehen (z.B. wenn eine künftige
            // OkHttp-Version doch direkt onClosed für einen Server-Close
            // aufruft) — handleUnauthorized ignoriert einen bereits
            // erledigten Socket über den Referenz-Check.
            if (isUnauthorizedClose(code, reason)) {
                handleUnauthorized(webSocket)
                return
            }
            handleDisconnect(webSocket, "Verbindung geschlossen ($code)")
        }
    }

    /**
     * [webSocket] ist der Socket, der den Abbruch meldet — nicht zwingend
     * mehr der aktuelle. [forceReconnect] reisst einen Socket hart ab und
     * baut sofort einen neuen auf; der onFailure/onClosed-Callback des alten
     * kommt trotzdem noch (asynchron) und darf dann keinen zweiten,
     * überflüssigen Reconnect-Zyklus anstossen.
     */
    @Synchronized
    private fun handleDisconnect(webSocket: WebSocket, reason: String) {
        if (webSocket !== socket) return
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

    /**
     * Endgültige Ablehnung durch den Server — kein Backoff, kein weiterer
     * Versuch von selbst. Derselbe Referenz-Check wie in [handleDisconnect]:
     * ein Close von einem schon ersetzten Socket wird ignoriert.
     */
    @Synchronized
    private fun handleUnauthorized(webSocket: WebSocket) {
        if (webSocket !== socket) return
        socket = null
        reconnectJob?.cancel()
        reconnectJob = null
        _state.value = ConnState.Unauthorized
    }

    private companion object {
        const val MIN_ATTEMPT_GAP_MS = 900L
        const val JITTER_MS = 400L
    }
}

/**
 * Lehnt der Server das Gerät endgültig ab (Code 4001, Grund 'unauthorized'
 * für ein unbekanntes Token oder 'revoked' für ein entzogenes Gerät)? Als
 * reine Funktion ausgelagert, damit sie ohne Android-Framework/OkHttp
 * testbar ist. Das Verbindungs-LIMIT läuft serverseitig über Code 4002 —
 * der bleibt bewusst außen vor und landet weiter im normalen Retry-Loop.
 */
fun isUnauthorizedClose(code: Int, reason: String): Boolean =
    code == 4001 && (reason == "unauthorized" || reason == "revoked")

/**
 * Wartet bis zu [timeoutMs] darauf, dass [state] [WsClient.ConnState.Connected]
 * erreicht — Polling statt Callback, weil kurzlebige Aufrufer (Notification-
 * Action-Antworten, s. `AppRepository.respondToPermission`) sowieso schon in
 * einer eigenen Coroutine mit festem Zeitbudget laufen. Als eigene, von
 * [AppRepository]/Android entkoppelte Funktion ausgelagert, damit sie ohne
 * Mocking-Framework testbar ist (s. [isUnauthorizedClose] oben — im Projekt
 * ist keins verfügbar).
 *
 * [reconnect] läuft einmal vorab, falls noch nicht verbunden — steht z.B.
 * gerade ein Backoff-Countdown an, überspringt das ihn, statt ihn abzuwarten.
 * Ist die Verbindung schon da, passiert gar nichts (kein unnötiger Reconnect).
 */
suspend fun awaitConnected(
    state: StateFlow<WsClient.ConnState>,
    timeoutMs: Long,
    pollMs: Long = 150,
    reconnect: () -> Unit = {},
): Boolean {
    if (state.value !is WsClient.ConnState.Connected) reconnect()
    val deadline = System.currentTimeMillis() + timeoutMs
    while (state.value !is WsClient.ConnState.Connected && System.currentTimeMillis() < deadline) {
        delay(pollMs)
    }
    return state.value is WsClient.ConnState.Connected
}
