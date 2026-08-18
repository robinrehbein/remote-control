package com.pocketagent.app

import com.pocketagent.app.data.CRASH_SHARE_MAX_CHARS
import com.pocketagent.app.data.crashFileName
import com.pocketagent.app.data.crashFilesToPrune
import com.pocketagent.app.data.formatCrashReport
import com.pocketagent.app.data.newestCrashFile
import com.pocketagent.app.data.parseCrashReport
import com.pocketagent.app.data.truncateForShare
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrashReportTest {

    // Fund: der StackOverflow im Markdown-Renderer war nur diagnostizierbar,
    // weil jemand den Bug im Quellcode fand — die App selbst hinterließ beim
    // Absturz keine Spur, die der Nutzer hätte teilen können. Der Report aus
    // formatCrashReport ist diese Spur; hier ist sein Format festgenagelt.

    private fun report(
        throwable: Throwable = IllegalStateException("kaputt"),
        versionName: String = "0.12.2",
        timestampIso: String = "2026-08-18T09:30:00Z",
        deviceInfo: String = "Android 15 (API 35), Google Pixel 8",
    ) = formatCrashReport(throwable, versionName, timestampIso, deviceInfo)

    @Test
    fun `first line is the one-line summary of type and message`() {
        val lines = report().lines()
        assertEquals("IllegalStateException: kaputt", lines.first())
    }

    @Test
    fun `metadata block carries version, timestamp and device`() {
        val text = report()
        assertTrue(text.contains("Zeit: 2026-08-18T09:30:00Z"))
        assertTrue(text.contains("App-Version: 0.12.2"))
        assertTrue(text.contains("Gerät: Android 15 (API 35), Google Pixel 8"))
    }

    @Test
    fun `cause chain appears in the stacktrace`() {
        val text = report(RuntimeException("außen", IllegalArgumentException("innen")))
        assertEquals("RuntimeException: außen", text.lines().first())
        assertTrue(text.contains("java.lang.RuntimeException: außen"))
        assertTrue(text.contains("Caused by: java.lang.IllegalArgumentException: innen"))
    }

    @Test
    fun `missing message falls back to the bare type`() {
        assertEquals("StackOverflowError", report(StackOverflowError()).lines().first())
    }

    @Test
    fun `multiline message stays a single summary line`() {
        // Mehrzeilige Messages (Netzwerk-Stacks, Compose-Diagnosen) dürfen den
        // Vertrag „Zeile 1 = Zusammenfassung" nicht brechen.
        val text = report(IllegalStateException("erste Zeile\nzweite Zeile"))
        assertEquals("IllegalStateException: erste Zeile zweite Zeile", text.lines().first())
    }

    @Test
    fun `parse recovers summary and timestamp from a written report`() {
        val info = parseCrashReport(report())
        assertEquals("IllegalStateException: kaputt", info.summary)
        assertEquals("2026-08-18T09:30:00Z", info.timestampIso)
    }

    @Test
    fun `parse of a foreign file yields no timestamp`() {
        val info = parseCrashReport("irgendwas anderes\nohne Metadaten")
        assertEquals("irgendwas anderes", info.summary)
        assertNull(info.timestampIso)
    }

    /* ---------- Kürzung für ACTION_SEND ---------- */

    @Test
    fun `short reports are shared unchanged`() {
        val text = report()
        assertEquals(text, truncateForShare(text))
    }

    @Test
    fun `huge reports are capped and marked as cut`() {
        val huge = "x".repeat(CRASH_SHARE_MAX_CHARS * 2)
        val shared = truncateForShare(huge)
        assertTrue(shared.length <= CRASH_SHARE_MAX_CHARS + 16)
        assertTrue(shared.endsWith("[gekürzt]"))
        // Der Anfang (Zusammenfassung + oberste Frames) bleibt erhalten.
        assertTrue(shared.startsWith("x".repeat(100)))
    }

    /* ---------- Rotation ---------- */

    @Test
    fun `prune keeps only the three newest crash files`() {
        val names = listOf(
            crashFileName(1000),
            crashFileName(4000),
            crashFileName(2000),
            crashFileName(3000),
            crashFileName(5000),
        )
        assertEquals(
            listOf(crashFileName(2000), crashFileName(1000)),
            crashFilesToPrune(names),
        )
    }

    @Test
    fun `prune with few files deletes nothing`() {
        assertEquals(emptyList<String>(), crashFilesToPrune(emptyList()))
        assertEquals(emptyList<String>(), crashFilesToPrune(listOf(crashFileName(1), crashFileName(2), crashFileName(3))))
    }

    @Test
    fun `foreign files count as oldest and are pruned first`() {
        // Fremddateien ohne parsbaren Zeitstempel dürfen die Rotation nicht
        // dazu bringen, echte Reports zu opfern.
        val names = listOf("notiz.txt", crashFileName(1), crashFileName(2), crashFileName(3))
        assertEquals(listOf("notiz.txt"), crashFilesToPrune(names))
    }

    @Test
    fun `newest crash file wins by timestamp not by list order`() {
        val names = listOf(crashFileName(2000), crashFileName(9000), crashFileName(5000))
        assertEquals(crashFileName(9000), newestCrashFile(names))
        assertNull(newestCrashFile(emptyList()))
    }
}
