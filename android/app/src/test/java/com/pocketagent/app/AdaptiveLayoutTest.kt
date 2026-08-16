package com.pocketagent.app

import com.pocketagent.app.ui.WidthClass
import com.pocketagent.app.ui.listPaneFraction
import com.pocketagent.app.ui.usesTwoPanes
import com.pocketagent.app.ui.widthClassFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Die Breitenregeln aus one-ui/largescreen-and-foldable/intro. Reine
 * Funktionen, damit die Grenzen prüfbar sind, ohne ein Gerät zu falten.
 */
class AdaptiveLayoutTest {

    @Test
    fun `the documented breakpoints land in the documented classes`() {
        assertEquals(WidthClass.COMPACT, widthClassFor(360))
        assertEquals(WidthClass.COMPACT, widthClassFor(599))
        assertEquals(WidthClass.MEDIUM, widthClassFor(600))
        assertEquals(WidthClass.MEDIUM, widthClassFor(839))
        assertEquals(WidthClass.EXPANDED, widthClassFor(840))
        assertEquals(WidthClass.EXPANDED, widthClassFor(1280))
    }

    @Test
    fun `a folded cover screen stays compact`() {
        // Das Außendisplay eines Z Fold ist schmal — dort gilt dieselbe
        // einspaltige Auslegung wie auf jedem Telefon.
        assertEquals(WidthClass.COMPACT, widthClassFor(320))
    }

    @Test
    fun `two panes only from expanded on`() {
        assertFalse(usesTwoPanes(WidthClass.COMPACT))
        // Bei Medium ist eine Spalte die ausdrückliche Empfehlung.
        assertFalse(usesTwoPanes(WidthClass.MEDIUM))
        assertTrue(usesTwoPanes(WidthClass.EXPANDED))
    }

    @Test
    fun `the list pane takes 42 percent below 960dp`() {
        assertEquals(0.42f, listPaneFraction(840, foldedVertically = false), 0.0001f)
        assertEquals(0.42f, listPaneFraction(959, foldedVertically = false), 0.0001f)
    }

    @Test
    fun `the list pane narrows to 38 percent from 960dp on`() {
        assertEquals(0.38f, listPaneFraction(960, foldedVertically = false), 0.0001f)
        assertEquals(0.38f, listPaneFraction(1600, foldedVertically = false), 0.0001f)
    }

    @Test
    fun `a vertical fold splits the window in half at any width`() {
        // Das Scharnier schlägt die Breitenregel: eine Spaltenkante neben der
        // Falz liest sich als Fehler, nicht als Gestaltung.
        assertEquals(0.5f, listPaneFraction(840, foldedVertically = true), 0.0001f)
        assertEquals(0.5f, listPaneFraction(1600, foldedVertically = true), 0.0001f)
    }
}
