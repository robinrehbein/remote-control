package com.pocketagent.app

import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import com.pocketagent.app.ui.components.appendMarkup
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownInlineTest {

    // Fund: appendRuns sprang für trefferlose Reste über appendTail zurück an
    // die Spitze der Kaskade — mit demselben Segment. Jeder gewöhnliche
    // Antworttext („Hallo") rekursierte endlos und riss die App per
    // StackOverflowError ab, sobald eine Agenten-Antwort gerendert wurde.

    @Test
    fun `plain text terminates and passes through unchanged`() {
        val result = buildAnnotatedString { appendMarkup("Hallo, ich habe die Datei angepasst.") }
        assertEquals("Hallo, ich habe die Datei angepasst.", result.text)
        assertTrue(result.spanStyles.isEmpty())
    }

    @Test
    fun `bold and italic runs are styled, markers stripped`() {
        val result = buildAnnotatedString { appendMarkup("Vor **fett** und *kursiv* danach") }
        assertEquals("Vor fett und kursiv danach", result.text)

        val bold = result.spanStyles.single { it.item.fontWeight == FontWeight.Bold }
        assertEquals("fett", result.text.substring(bold.start, bold.end))

        val italic = result.spanStyles.single { it.item.fontStyle == FontStyle.Italic }
        assertEquals("kursiv", result.text.substring(italic.start, italic.end))
    }

    @Test
    fun `bold-italic wins over bold over italic`() {
        val result = buildAnnotatedString { appendMarkup("***beides***") }
        assertEquals("beides", result.text)
        val span = result.spanStyles.single()
        assertEquals(FontWeight.Bold, span.item.fontWeight)
        assertEquals(FontStyle.Italic, span.item.fontStyle)
    }

    @Test
    fun `underscore variants and unclosed markers terminate`() {
        assertEquals("u-fett", buildAnnotatedString { appendMarkup("__u-fett__") }.text)
        assertEquals("u-kursiv", buildAnnotatedString { appendMarkup("_u-kursiv_") }.text)
        // Unvollständiges Markup bleibt Klartext statt zu hängen.
        assertEquals("2 ** 3 ist 8", buildAnnotatedString { appendMarkup("2 ** 3 ist 8") }.text)
    }
}
