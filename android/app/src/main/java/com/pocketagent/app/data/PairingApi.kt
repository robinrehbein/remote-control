package com.pocketagent.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

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
                val url = base.trimEnd('/') + PAIRING_PATH
                val body = ProtocolJson.encodeToString(PairingConfirmBody.serializer(), PairingConfirmBody(code, deviceName))
                    .toRequestBody("application/json; charset=utf-8".toMediaType())
                val request = Request.Builder()
                    .url(url)
                    .post(body)
                    .build()
                client.newCall(request).execute().use { response ->
                    val text = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
                        throw IllegalStateException("HTTP ${response.code}: ${text.take(200)}")
                    }
                    parseResponse(text) ?: throw IllegalStateException("Ungültige Server-Antwort")
                }
            }.recoverCatching { error ->
                if (!cleartext) throw error
                throw IllegalStateException(
                    "Klartext-HTTP (http://) ist auf Android 9+ standardmäßig blockiert. " +
                        "Bitte eine https://-Server-URL verwenden. (Ursache: ${error.message})",
                    error
                )
            }
        }

    companion object {
        private const val PAIRING_PATH = "/api/pairing/confirm"
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
         * Ping alle 20s: Mobilfunk-NATs räumen stille Verbindungen gern nach
         * 30–60s ab. Mit 30s Ping lag der Abbruch genau im Risikofenster —
         * 20s hält die Verbindung offen und lässt einen toten Socket auch
         * schneller auffliegen (OkHttp bricht ab, wenn ein Pong ausbleibt).
         */
        fun default(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
