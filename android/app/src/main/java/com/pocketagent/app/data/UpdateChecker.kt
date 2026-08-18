package com.pocketagent.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

@Serializable
private data class GitHubAsset(
    val name: String = "",
    @SerialName("browser_download_url") val browserDownloadUrl: String = "",
    val size: Long = 0,
    @SerialName("content_type") val contentType: String = "",
)

@Serializable
private data class GitHubRelease(
    @SerialName("tag_name") val tagName: String = "",
    val body: String = "",
    val assets: List<GitHubAsset> = emptyList(),
)

/** Das eine installierbare Release: Tag, APK-Asset und Release-Notes. */
data class ReleaseInfo(
    val tag: String,
    val apkName: String,
    val apkUrl: String,
    val apkSize: Long,
    val notes: String,
)

/**
 * Fragt das jeweils neueste GitHub-Release des Repos ab. Ohne Token: das Repo
 * ist öffentlich, und das unauthentifizierte Rate-Limit (60/h pro IP) reicht
 * für einen Check auf Nutzeraktion locker aus.
 */
class UpdateChecker(private val client: OkHttpClient) {

    suspend fun fetchLatest(): Result<ReleaseInfo?> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url(RELEASES_LATEST_URL)
                .header("Accept", "application/vnd.github+json")
                .build()
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw IllegalStateException("GitHub antwortete mit HTTP ${response.code}")
                }
                parseLatestRelease(text)
            }
        }
    }

    companion object {
        const val RELEASES_LATEST_URL =
            "https://api.github.com/repos/robinrehbein/remote-control/releases/latest"

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * Liest Tag, Release-Notes und das APK-Asset aus der Antwort von
         * `/releases/latest`. Null, wenn die Antwort kein Release mit
         * APK-Asset beschreibt — dann gibt es schlicht nichts zu installieren.
         */
        fun parseLatestRelease(raw: String): ReleaseInfo? {
            val release = runCatching {
                json.decodeFromString(GitHubRelease.serializer(), raw)
            }.getOrNull() ?: return null
            if (release.tagName.isBlank()) return null
            // Releases tragen genau ein Asset `pocketagent-vX.Y.Z.apk`; gematcht
            // wird trotzdem über Typ/Endung, damit ein zusätzliches Asset
            // (z. B. eine Checksummen-Datei) den Updater nicht verwirrt.
            val apk = release.assets.firstOrNull {
                it.contentType == "application/vnd.android.package-archive" ||
                    it.name.endsWith(".apk", ignoreCase = true)
            } ?: return null
            if (apk.browserDownloadUrl.isBlank()) return null
            return ReleaseInfo(
                tag = release.tagName,
                apkName = apk.name.ifBlank { "update.apk" },
                apkUrl = apk.browserDownloadUrl,
                apkSize = apk.size,
                notes = release.body.trim(),
            )
        }

        /**
         * Ist das Remote-Tag echt neuer als die installierte Version?
         * Führendes `v` ist egal, fehlende Segmente zählen als 0 (0.13 > 0.12.2).
         * Sobald ein Segment nicht rein numerisch ist (0.13-rc1, kaputte Tags,
         * ein versionName-Suffix wie -usercatrust), konservativ false — lieber
         * kein Update anbieten als ein falsches.
         */
        fun isNewer(remoteTag: String, installed: String): Boolean {
            val remote = parseVersion(remoteTag) ?: return false
            val local = parseVersion(installed) ?: return false
            for (i in 0 until maxOf(remote.size, local.size)) {
                val r = remote.getOrElse(i) { 0 }
                val l = local.getOrElse(i) { 0 }
                if (r != l) return r > l
            }
            return false
        }

        private fun parseVersion(tag: String): List<Int>? {
            val trimmed = tag.trim().removePrefix("v")
            if (trimmed.isEmpty()) return null
            return trimmed.split(".").map { it.toIntOrNull() ?: return null }
        }
    }
}
