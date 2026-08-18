package com.pocketagent.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

@Serializable
data class PairingConfirmBody(val code: String, val deviceName: String)

@Serializable
data class PairingConfirmResponse(
    val ok: Boolean = false,
    val deviceId: String = "",
    val deviceToken: String = "",
)

class PairingApi(private val client: OkHttpClient) {

    suspend fun confirm(serverUrl: String, code: String, deviceName: String): Result<PairingConfirmResponse> =
        withContext(Dispatchers.IO) {
            val base = normalizeUrl(serverUrl)
            val cleartext = base.startsWith("http://")
            runCatching {
                try {
                    attempt(base, code, deviceName)
                } catch (error: IOException) {
                    // Mobilfunk-Blips (Netzwechsel, NAT-Timeout) scheitern oft
                    // genau einmal. Wiederholt wird nur, wenn der Request den
                    // Server sicher nie erreicht hat — sonst könnte der erste
                    // Versuch den Code serverseitig schon verbraucht haben und
                    // der zweite ihn fälschlich als ungültig melden.
                    if (!failedBeforeSend(error)) throw error
                    delay(RETRY_DELAY_MS)
                    attempt(base, code, deviceName)
                }
            }.recoverCatching { error ->
                if (cleartext && error is IOException) {
                    throw IllegalStateException(
                        "Klartext-HTTP (http://) ist auf Android 9+ standardmäßig blockiert. " +
                            "Bitte eine https://-Server-URL verwenden. (Ursache: ${error.message})",
                        error
                    )
                }
                if (error is IOException) {
                    throw IllegalStateException(describeNetworkFailure(error, base), error)
                }
                throw error
            }
        }

    private fun attempt(base: String, code: String, deviceName: String): PairingConfirmResponse {
        val url = base.trimEnd('/') + PAIRING_PATH
        val body = ProtocolJson.encodeToString(PairingConfirmBody.serializer(), PairingConfirmBody(code, deviceName))
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder()
            .url(url)
            .post(body)
            .build()
        return client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw IllegalStateException("HTTP ${response.code}: ${text.take(200)}")
            }
            parseResponse(text) ?: throw IllegalStateException("Ungültige Server-Antwort")
        }
    }

    companion object {
        private const val PAIRING_PATH = "/api/pairing/confirm"
        private const val RETRY_DELAY_MS = 800L
        private val responseJson = Json { ignoreUnknownKeys = true; isLenient = true }

        fun parseResponse(raw: String): PairingConfirmResponse? =
            runCatching { responseJson.decodeFromString(PairingConfirmResponse.serializer(), raw) }
                .getOrNull()
                ?.takeIf { it.ok && it.deviceToken.isNotBlank() }

        fun normalizeUrl(url: String): String {
            val trimmed = url.trim().trimEnd('/')
            return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed
            else "https://$trimmed"
        }

        fun wsUrl(serverUrl: String): String {
            val base = normalizeUrl(serverUrl).trimEnd('/')
                .replaceFirst("https://", "wss://")
                .replaceFirst("http://", "ws://")
            return "$base/ws"
        }

        /**
         * Scheiterte der Versuch, bevor der Request den Server erreicht haben
         * kann? Nur dann ist ein automatischer Retry gefahrlos: Nach einem
         * Read-Timeout könnte der Server den Pairing-Code bereits konsumiert
         * haben, und die Antwort mit dem Device-Token wäre verloren.
         */
        fun failedBeforeSend(error: Throwable): Boolean =
            causeChain(error).any {
                it is UnknownHostException ||
                    it is ConnectException ||
                    it is NoRouteToHostException ||
                    (it is SocketTimeoutException && it.message?.contains("connect", ignoreCase = true) == true)
            }

        /**
         * Übersetzt eine Netzwerk-Exception in eine Meldung, mit der man das
         * Problem eingrenzen kann — die rohe OkHttp-Meldung („Failed to
         * connect to …“) sagt nicht, ob URL, Handy-Netz oder Server schuld
         * sind. Der Browser-Test auf `/api/health` trennt die Fälle: Lädt er,
         * liegt es an der App-Umgebung (VPN, privates DNS, Filter); lädt er
         * nicht, an Netz oder Server.
         */
        fun describeNetworkFailure(error: Throwable, base: String): String {
            val health = "${base.trimEnd('/')}/api/health"
            val chain = causeChain(error)
            return when {
                chain.any { it is UnknownHostException } ->
                    "Der Servername ließ sich nicht auflösen (DNS). Prüfe die Server-URL auf Tippfehler — " +
                        "und ob ein VPN oder privates DNS auf dem Gerät die Auflösung blockiert."
                chain.any { it is SSLException } ->
                    "TLS-Handshake fehlgeschlagen — das Server-Zertifikat wird nicht akzeptiert. " +
                        "Prüfe im Browser, ob $health ohne Zertifikatswarnung lädt; bei einer frisch " +
                        "eingerichteten Domain fehlt eventuell noch das Zertifikat des Reverse-Proxys."
                chain.any { it is SocketTimeoutException } ->
                    "Zeitüberschreitung beim Verbinden — Server gerade nicht erreichbar oder das Netz hakt. " +
                        "Teste $health im Browser und versuch es erneut, notfalls nach einem Wechsel " +
                        "zwischen WLAN und Mobilfunk."
                else ->
                    "Keine Verbindung zum Server (${error.message ?: error.javaClass.simpleName}). " +
                        "Teste $health im Browser auf diesem Gerät: Lädt die Seite, blockiert vermutlich " +
                        "ein VPN, privates DNS oder ein Firewall-/Werbefilter die App. Lädt sie nicht, " +
                        "wechsle testweise zwischen WLAN und Mobilfunk."
            }
        }

        private fun causeChain(error: Throwable): List<Throwable> {
            val seen = ArrayList<Throwable>(4)
            var current: Throwable? = error
            while (current != null && current !in seen && seen.size < 8) {
                seen.add(current)
                current = current.cause
            }
            return seen
        }

        /**
         * Ping alle 10s: Mobilfunk-NATs räumen stille Verbindungen gern nach
         * 30–60s ab — der Ping hält sie offen. Zugleich begrenzt er die
         * Erkennung eines still gestorbenen Sockets (OkHttp bricht ab, wenn
         * ein Pong ausbleibt): mit 10s ist der schlimmste Fall ~20s statt
         * ~40s, und genau diese Lücke ist die als „ewig“ empfundene Zeit
         * zwischen Netzwechsel und Wiederanschluss.
         *
         * Nur für den WebSocket gedacht (daher `readTimeout(0)` — unendlich,
         * eine offene Verbindung soll nie deswegen abreißen). Für gewöhnliche
         * synchrone HTTP-Calls (Pairing) ist das falsch getunt: ein
         * hängender Reverse-Proxy nach dem TCP-Connect würde diese Anfrage
         * unbegrenzt blockieren. Dafür gibt es [httpClient].
         */
        fun default(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(10, TimeUnit.SECONDS)
            .build()

        /**
         * Für synchrone HTTP-Requests (aktuell nur [confirm]): endliche
         * Timeouts, damit ein Server, der nach dem TCP-Connect nie antwortet,
         * den Pairing-Screen nicht auf unbegrenzte Zeit im Ladezustand hält.
         */
        fun httpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .callTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
