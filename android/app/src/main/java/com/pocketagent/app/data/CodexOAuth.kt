package com.pocketagent.app.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URLDecoder
import java.util.UUID

/* ------------------------------------------------------------------ */
/* In-App Codex OAuth (CODEX-OAUTH.md, Variante A + Device-Code)       */
/*                                                                     */
/* Der Server startet den Login im Auth-Container und schickt auth.url */
/* (Login-URL + Loopback-Port). Bei oauth-loopback öffnet die App die  */
/* URL im Browser und lauscht selbst auf 127.0.0.1:{port}: den Redirect*/
/* fängt sie ab, schickt code+state per auth.callback über den WSS und */
/* zeigt dem Browser eine Erfolgsseite. auth.done schließt den Flow.   */
/* ------------------------------------------------------------------ */

/** Ein vom Loopback-Listener abgefangener OAuth-Callback. */
data class CodexCallback(val code: String, val state: String)

/**
 * Die vom Server in `auth.url`/`auth.done` gemeldeten Ereignisse eines Flows,
 * gefiltert nach requestId in [CodexOAuthController].
 */
sealed interface CodexAuthEvent {
    val requestId: String
    data class Url(
        override val requestId: String,
        val url: String,
        val port: Int,
        val flow: String? = null,
        val userCode: String? = null,
    ) : CodexAuthEvent

    data class Done(
        override val requestId: String,
        val ok: Boolean,
        val account: String? = null,
        val error: String? = null,
    ) : CodexAuthEvent
}

/**
 * Sichtbarer Zustand des Login-Flows für die UI.
 */
sealed interface CodexAuthUiState {
    data object Idle : CodexAuthUiState

    /** auth.start ist raus, warten auf auth.url. */
    data object Starting : CodexAuthUiState

    /**
     * Browser offen. Bei device-code trägt [userCode] den einzugebenden Code
     * (kein Loopback-Listener); bei oauth-loopback lauscht die App auf [port].
     */
    data class AwaitingBrowser(val url: String, val userCode: String? = null, val port: Int = 0) : CodexAuthUiState

    data class Success(val account: String? = null) : CodexAuthUiState
    data class Failed(val error: String) : CodexAuthUiState
}

/**
 * Zerlegt die erste Zeile einer HTTP-Anfrage
 * (`GET /auth/callback?code=..&state=.. HTTP/1.1`) in code+state. Reine
 * Funktion, damit sie ohne Sockets testbar ist. Fehlt eines von beiden oder
 * ist der Pfad ein anderer, ergibt sie null.
 */
fun parseLoopbackCallback(requestLine: String): CodexCallback? {
    val parts = requestLine.trim().split(Regex("\\s+"))
    if (parts.size < 2) return null
    val target = parts[1]
    val q = target.indexOf('?')
    if (q < 0) return null
    val path = target.substring(0, q)
    if (!path.endsWith("/auth/callback") && path != "/auth/callback") return null
    val params = HashMap<String, String>()
    for (pair in target.substring(q + 1).split('&')) {
        val eq = pair.indexOf('=')
        if (eq <= 0) continue
        val key = pair.substring(0, eq)
        val value = decode(pair.substring(eq + 1))
        params[key] = value
    }
    val code = params["code"]?.takeIf { it.isNotBlank() } ?: return null
    val state = params["state"]?.takeIf { it.isNotBlank() } ?: return null
    return CodexCallback(code, state)
}

private fun decode(raw: String): String = try {
    URLDecoder.decode(raw, "UTF-8")
} catch (_: Exception) {
    raw
}

/**
 * Die kleine HTTP-Antwort, die der Browser nach dem Redirect sieht.
 * [ok] false zeigt einen Fehlertext; sonst „zurück zur App".
 */
fun loopbackHttpResponse(ok: Boolean = true): String {
    val body = if (ok) {
        "<!doctype html><meta charset=utf-8><title>Codex</title>" +
            "<body style=\"font-family:system-ui;text-align:center;padding:3rem;color:#111\">" +
            "<h2>Angemeldet ✓</h2><p>Du kannst zurück zur App wechseln.</p></body>"
    } else {
        "<!doctype html><meta charset=utf-8><title>Codex</title>" +
            "<body style=\"font-family:system-ui;text-align:center;padding:3rem;color:#111\">" +
            "<h2>Login unvollständig</h2><p>Bitte in der App erneut versuchen.</p></body>"
    }
    val bytes = body.toByteArray(Charsets.UTF_8)
    return buildString {
        append("HTTP/1.1 200 OK\r\n")
        append("Content-Type: text/html; charset=utf-8\r\n")
        append("Content-Length: ").append(bytes.size).append("\r\n")
        append("Connection: close\r\n")
        append("\r\n")
        append(body)
    }
}

/**
 * Bindet 127.0.0.1:[port] (nur Loopback!), nimmt genau EINE Anfrage entgegen,
 * liefert code+state und antwortet dem Browser mit der Erfolgsseite. Lebt nur
 * für die Dauer des Flows. Gibt null zurück bei Timeout/Fehler/Abbruch.
 */
suspend fun awaitLoopbackCallback(port: Int, timeoutMs: Long = 5 * 60_000L): CodexCallback? =
    withContext(Dispatchers.IO) {
        var server: ServerSocket? = null
        try {
            server = ServerSocket()
            server.reuseAddress = true
            server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
            // soTimeout, weil accept() blockierend ist und ein Coroutine-Timeout es
            // nicht unterbrechen könnte: nach Ablauf wirft accept eine
            // SocketTimeoutException, die unten zu null wird.
            server.soTimeout = timeoutMs.coerceIn(1, Int.MAX_VALUE.toLong()).toInt()
            server.accept().use { s ->
                val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
                val requestLine = reader.readLine() ?: return@withContext null
                val callback = parseLoopbackCallback(requestLine)
                val out = s.getOutputStream()
                out.write(loopbackHttpResponse(ok = callback != null).toByteArray(Charsets.UTF_8))
                out.flush()
                callback
            }
        } catch (_: Exception) {
            null
        } finally {
            try {
                server?.close()
            } catch (_: Exception) {
                // ignore
            }
        }
    }

/**
 * Treibt einen Codex-Login-Flow und bündelt den Zustand für die UI. Der
 * Loopback-Listener bindet nur 127.0.0.1 und lebt nur, bis der Callback kommt
 * (oder abgebrochen wird). [openUrl] öffnet die Login-URL im Browser.
 */
class CodexOAuthController(
    private val scope: CoroutineScope,
    private val repository: AppRepository,
    private val openUrl: (String) -> Unit,
) {
    private val _state = MutableStateFlow<CodexAuthUiState>(CodexAuthUiState.Idle)
    val state: StateFlow<CodexAuthUiState> = _state

    private var requestId: String? = null
    private var job: Job? = null
    private var listenerJob: Job? = null

    /** Startet den Flow. [flow] = "oauth-loopback" oder "device-code" (oder null). */
    fun begin(flow: String?) {
        cancel() // ein laufender Flow wird ersetzt
        val id = "auth_" + UUID.randomUUID().toString().replace("-", "")
        requestId = id
        _state.value = CodexAuthUiState.Starting
        job = scope.launch {
            repository.authEvents.collect { event ->
                if (event.requestId != id) return@collect
                when (event) {
                    is CodexAuthEvent.Url -> onUrl(event)
                    is CodexAuthEvent.Done -> {
                        listenerJob?.cancel()
                        listenerJob = null
                        _state.value = if (event.ok) {
                            CodexAuthUiState.Success(event.account)
                        } else {
                            CodexAuthUiState.Failed(event.error ?: "Login fehlgeschlagen")
                        }
                    }
                }
            }
        }
        if (!repository.startCodexAuth(id, flow)) {
            // Ging nicht raus (kein Socket): den Collector abräumen, aber den
            // Fehler stehen lassen (cancel() würde ihn auf Idle zurücksetzen).
            job?.cancel()
            job = null
            requestId = null
            _state.value = CodexAuthUiState.Failed("Keine Verbindung zum Server")
        }
    }

    private fun onUrl(url: CodexAuthEvent.Url) {
        _state.value = CodexAuthUiState.AwaitingBrowser(url.url, url.userCode, url.port)
        openUrl(url.url)
        if (url.port <= 0) return // device-code: kein Listener, Server meldet auth.done
        val id = requestId ?: return
        listenerJob?.cancel()
        listenerJob = scope.launch {
            val callback = awaitLoopbackCallback(url.port)
            if (callback != null) {
                repository.sendAuthCallback(id, callback.code, callback.state)
            } else if (_state.value is CodexAuthUiState.AwaitingBrowser) {
                _state.value = CodexAuthUiState.Failed("Kein Callback empfangen (Zeitüberschreitung)")
            }
        }
    }

    /** Bricht den Flow ab (Sheet geschlossen). Idempotent. */
    fun cancel() {
        requestId?.let { repository.cancelCodexAuth(it) }
        requestId = null
        listenerJob?.cancel()
        listenerJob = null
        job?.cancel()
        job = null
        _state.value = CodexAuthUiState.Idle
    }
}
