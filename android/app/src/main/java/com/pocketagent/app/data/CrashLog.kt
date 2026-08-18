package com.pocketagent.app.data

import android.content.Context
import android.os.Build
import java.io.File
import java.time.Instant

/**
 * Hinterlässt bei einem unbehandelten Crash eine Spur, die der Nutzer aus den
 * Settings heraus teilen kann. Formatierung/Rotation sind pure Funktionen in
 * CrashReport.kt; hier liegt nur die Android-Seite (Handler, Dateien).
 */
object CrashLog {

    private const val DIR_NAME = "crash"

    data class LastCrash(val summary: String, val timestampIso: String?, val report: String)

    /** In Application.onCreate() aufrufen — so früh wie möglich, damit auch Init-Crashes landen. */
    fun install(context: Context) {
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            // Ein Crash-Handler, der crasht, ist schlimmer als keiner: alles
            // (auch OutOfMemoryError & Co.) schlucken, damit die Delegation
            // unten in jedem Fall erreicht wird.
            try {
                write(app, throwable)
            } catch (_: Throwable) {
            }
            // IMMER an den vorherigen Default-Handler weiterreichen — der von
            // Android installierte (RuntimeInit) zeigt den System-Crash-Dialog
            // und beendet den Prozess. Ohne Delegation bliebe die App in
            // undefiniertem Zustand am Leben.
            if (previous != null) {
                previous.uncaughtException(thread, throwable)
            } else {
                // Kein Vorgänger (sollte auf Android nie passieren): hart
                // beenden. halt() statt exit(), weil Shutdown-Hooks in einem
                // kaputten Prozess hängen können.
                Runtime.getRuntime().halt(1)
            }
        }
    }

    /** Neuester Report oder null. Nie werfen — Diagnose darf die Settings nicht abschießen. */
    fun latest(context: Context): LastCrash? {
        return try {
            val dir = File(context.filesDir, DIR_NAME)
            val name = newestCrashFile(dir.list()?.toList().orEmpty()) ?: return null
            val report = File(dir, name).readText()
            if (report.isBlank()) return null
            val info = parseCrashReport(report)
            LastCrash(info.summary, info.timestampIso, report)
        } catch (_: Throwable) {
            null
        }
    }

    /** „Verwerfen" in den Settings: alle aufgehobenen Reports löschen. */
    fun discardAll(context: Context) {
        try {
            File(context.filesDir, DIR_NAME).listFiles()?.forEach { it.delete() }
        } catch (_: Throwable) {
        }
    }

    // Synchron und auf dem crashenden Thread: der Prozess stirbt gleich,
    // ein Coroutine-Dispatch käme nie mehr dran.
    private fun write(context: Context, throwable: Throwable) {
        val versionName = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unbekannt"
        } catch (_: Throwable) {
            "unbekannt"
        }
        val deviceInfo =
            "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), " +
                "${Build.MANUFACTURER} ${Build.MODEL}"
        val report = formatCrashReport(throwable, versionName, Instant.now().toString(), deviceInfo)

        val dir = File(context.filesDir, DIR_NAME)
        dir.mkdirs()
        File(dir, crashFileName(System.currentTimeMillis())).writeText(report)
        crashFilesToPrune(dir.list()?.toList().orEmpty()).forEach { File(dir, it).delete() }
    }
}
