package com.pocketagent.app

import androidx.compose.ui.unit.dp
import com.pocketagent.app.ui.PickListMinHeight
import com.pocketagent.app.ui.PickListPreferredHeight
import com.pocketagent.app.ui.pickListMaxHeight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Die Höhengrenze scrollbarer Auswahllisten in einem Sheet. Reine Funktion,
 * damit sich prüfen lässt, was mit offener Tastatur und quer passiert, ohne
 * ein Gerät zu drehen.
 */
class PickListHeightTest {

    @Test
    fun `a tall window keeps the full preferred height`() {
        // Hochkant ohne Tastatur: die Liste bleibt so hoch wie bisher.
        assertEquals(PickListPreferredHeight, pickListMaxHeight(800.dp))
        assertEquals(PickListPreferredHeight, pickListMaxHeight(640.dp))
    }

    @Test
    fun `the list never takes more than half of what is there`() {
        // Der Rest gehört Titel und Aktionszeile — genau die beiden Teile,
        // die vorher unter die Gestenleiste rutschten.
        assertEquals(250.dp, pickListMaxHeight(500.dp))
        assertEquals(200.dp, pickListMaxHeight(400.dp))
    }

    @Test
    fun `an open keyboard shrinks the list instead of the buttons`() {
        val windowHeight = 800.dp
        val imeHeight = 340.dp
        val withKeyboard = pickListMaxHeight(windowHeight - imeHeight)
        assertTrue(withKeyboard < pickListMaxHeight(windowHeight))
        assertEquals(230.dp, withKeyboard)
    }

    @Test
    fun `a very short window stops shrinking at the minimum`() {
        // Quer mit offener Tastatur bleibt kaum Platz. Unter zwei Zeilen ist
        // eine Liste keine Liste mehr.
        assertEquals(PickListMinHeight, pickListMaxHeight(200.dp))
        assertEquals(PickListMinHeight, pickListMaxHeight(240.dp))
    }

    @Test
    fun `nothing is claimed that is not there`() {
        // Bleibt weniger übrig als die Untergrenze, gilt der echte Rest —
        // eine Liste, die höher ist als ihr Fenster, hilft niemandem.
        assertEquals(80.dp, pickListMaxHeight(80.dp))
        assertEquals(0.dp, pickListMaxHeight(0.dp))
        assertEquals(0.dp, pickListMaxHeight((-20).dp))
    }

    @Test
    fun `a caller may ask for a lower ceiling`() {
        // Zwei Listen in einem Sheet: die zweite bekommt weniger, damit beide
        // zusammen nicht das ganze Sheet einnehmen.
        assertEquals(260.dp, pickListMaxHeight(800.dp, preferred = 260.dp))
        // Der eigene Deckel schlägt die Hälfte nie nach oben durch.
        assertEquals(150.dp, pickListMaxHeight(300.dp, preferred = 260.dp))
    }

    @Test
    fun `a ceiling below the minimum wins over the minimum`() {
        // Sonst stünde eine Untergrenze über dem Maximum — das ist keine
        // Spanne mehr, sondern ein Absturz.
        assertEquals(60.dp, pickListMaxHeight(800.dp, preferred = 60.dp))
        assertEquals(60.dp, pickListMaxHeight(200.dp, preferred = 60.dp))
    }
}
