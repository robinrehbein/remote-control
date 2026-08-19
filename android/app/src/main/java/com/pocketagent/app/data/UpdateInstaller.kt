package com.pocketagent.app.data

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Lädt ein Release-APK in den FileProvider-Pfad `cacheDir/updates/` und
 * übergibt es dem System-Installer. Die eigentliche Update-Sicherheit steckt
 * nicht hier, sondern in Androids Signaturprüfung: ein Update, das nicht mit
 * demselben Key signiert ist wie die installierte App, lehnt der Installer ab.
 */
class UpdateInstaller(private val context: Context, private val client: OkHttpClient) {

    suspend fun download(release: ReleaseInfo): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            val dir = File(context.cacheDir, UPDATES_DIR)
            // Alte/halbfertige Downloads vorher löschen — es zählt nur die
            // jeweils aktuelle Datei, und ein Rest eines abgebrochenen
            // Downloads darf nie als fertiges APK durchgehen.
            dir.listFiles()?.forEach { it.delete() }
            dir.mkdirs()
            val target = File(dir, release.apkName)
            val request = Request.Builder().url(release.apkUrl).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IllegalStateException("Download fehlgeschlagen (HTTP ${response.code})")
                }
                val body = response.body ?: throw IllegalStateException("Leere Antwort beim Download")
                target.outputStream().use { out -> body.byteStream().copyTo(out) }
            }
            if (release.apkSize > 0 && target.length() != release.apkSize) {
                val got = target.length()
                target.delete()
                throw IllegalStateException("Download unvollständig ($got von ${release.apkSize} Bytes)")
            }
            target
        }
    }

    /** Startet den System-Installer für die heruntergeladene Datei. */
    fun install(apk: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    companion object {
        private const val UPDATES_DIR = "updates"
        private const val APK_MIME = "application/vnd.android.package-archive"

        /**
         * Für den APK-Download: endliche connect/read-Timeouts, aber bewusst
         * ohne callTimeout — ein größeres APK über Mobilfunk darf länger als
         * die 20 s von [PairingApi.httpClient] brauchen. Abgebrochen wird nur,
         * wenn 30 s lang gar keine Daten mehr ankommen.
         */
        fun downloadClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
