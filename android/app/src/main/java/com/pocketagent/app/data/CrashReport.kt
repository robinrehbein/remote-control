package com.pocketagent.app.data

/*
 * Pure Kotlin ohne Android-Imports — alles hier läuft in JVM-Unit-Tests.
 * Die Android-Seite (Handler installieren, Dateien schreiben/lesen) liegt
 * in CrashLog.kt.
 */

/** Obergrenze für den geteilten Report (~100 KB als text/plain-EXTRA_TEXT). */
const val CRASH_SHARE_MAX_CHARS = 100_000

/** Mehr Dateien behält die Rotation nie. */
const val CRASH_MAX_FILES = 3

private const val CRASH_FILE_PREFIX = "crash-"
private const val CRASH_FILE_SUFFIX = ".txt"
private const val TIMESTAMP_LINE_PREFIX = "Zeit: "

fun crashFileName(epochMillis: Long): String = "$CRASH_FILE_PREFIX$epochMillis$CRASH_FILE_SUFFIX"

/**
 * Zeile 1 ist immer die Ein-Zeilen-Zusammenfassung (Typ + Message), danach
 * ein Metadaten-Block, danach der volle Stacktrace inkl. aller Causes
 * (stackTraceToString druckt „Caused by:"-Ketten und Suppressed mit).
 */
fun formatCrashReport(
    throwable: Throwable,
    versionName: String,
    timestampIso: String,
    deviceInfo: String,
): String = buildString {
    appendLine(crashSummary(throwable))
    appendLine()
    appendLine("$TIMESTAMP_LINE_PREFIX$timestampIso")
    appendLine("App-Version: $versionName")
    appendLine("Gerät: $deviceInfo")
    appendLine()
    appendLine(throwable.stackTraceToString().trimEnd())
}

/** Typ + Message in genau einer Zeile — die Karte in den Settings zeigt sie. */
fun crashSummary(throwable: Throwable): String {
    val type = throwable.javaClass.simpleName.ifBlank { throwable.javaClass.name }
    // Mehrzeilige Messages (z. B. von Netzwerk-Stacks) würden sonst den
    // Parse-Vertrag „Zeile 1 = Zusammenfassung" brechen.
    val message = throwable.message
        ?.replace('\n', ' ')
        ?.replace("\r", "")
        ?.trim()
        ?.takeIf { it.isNotBlank() }
    return if (message != null) "$type: $message" else type
}

data class CrashReportInfo(val summary: String, val timestampIso: String?)

/** Liest Zusammenfassung und Zeitstempel aus einem per [formatCrashReport] geschriebenen Report. */
fun parseCrashReport(report: String): CrashReportInfo {
    val summary = report.lineSequence().firstOrNull().orEmpty().trim()
    val timestamp = report.lineSequence()
        .firstOrNull { it.startsWith(TIMESTAMP_LINE_PREFIX) }
        ?.removePrefix(TIMESTAMP_LINE_PREFIX)
        ?.trim()
        ?.takeIf { it.isNotBlank() }
    return CrashReportInfo(summary, timestamp)
}

/** Kürzt für ACTION_SEND: Anfang (Zusammenfassung + oberste Frames) ist der wertvolle Teil. */
fun truncateForShare(report: String, maxChars: Int = CRASH_SHARE_MAX_CHARS): String =
    if (report.length <= maxChars) report else report.take(maxChars) + "\n… [gekürzt]"

/**
 * Rotations-Logik über Dateinamen statt Dateien, damit sie im JVM-Test läuft:
 * liefert die Namen, die gelöscht werden müssen, damit nur die [keep]
 * neuesten crash-&lt;epochMillis&gt;.txt übrig bleiben.
 */
fun crashFilesToPrune(names: List<String>, keep: Int = CRASH_MAX_FILES): List<String> {
    if (names.size <= keep) return emptyList()
    return names.sortedByDescending(::crashFileOrder).drop(keep)
}

fun newestCrashFile(names: List<String>): String? = names.maxByOrNull(::crashFileOrder)

// Numerisch statt lexikografisch sortieren: Fremddateien ohne parsbaren
// Zeitstempel gelten als älteste und fliegen bei der Rotation zuerst raus.
private fun crashFileOrder(name: String): Long =
    name.removePrefix(CRASH_FILE_PREFIX).removeSuffix(CRASH_FILE_SUFFIX).toLongOrNull() ?: Long.MIN_VALUE
