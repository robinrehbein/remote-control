package com.pocketagent.app.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker

/**
 * Wie breit das Fenster gerade ist — in den Klassen, die One UI benennt:
 * „Compact: Width < 600dp · Medium: 600 ≤ Width < 840dp · Expanded: 840 ≤
 * Width" (one-ui/largescreen-and-foldable/intro).
 *
 * Bewusst selbst gerechnet statt über `calculateWindowSizeClass`: dessen API
 * ist als experimentell markiert, und die Grenzen stehen hier ohnehin fest.
 */
enum class WidthClass { COMPACT, MEDIUM, EXPANDED }

fun widthClassFor(widthDp: Int): WidthClass = when {
    widthDp < 600 -> WidthClass.COMPACT
    widthDp < 840 -> WidthClass.MEDIUM
    else -> WidthClass.EXPANDED
}

/**
 * Zwei Spalten lohnen sich erst, wenn beide benutzbar bleiben. One UI
 * empfiehlt sie ab Expanded; bei Medium ist ausdrücklich *eine* Spalte die
 * Empfehlung, also bleibt es dort einspaltig.
 */
fun usesTwoPanes(widthClass: WidthClass): Boolean = widthClass == WidthClass.EXPANDED

/**
 * Der Anteil, den die Listenspalte bekommt; der Rest gehört dem Detail.
 * Werte aus one-ui/largescreen-and-foldable/intro:
 *
 *   600–960 dp   42 % / 58 %
 *   ab 960 dp    38 % / 62 %
 *   Foldable     50 % / 50 %
 *
 * Das Foldable schlägt die Breitenregel, weil dort nicht die Breite
 * entscheidet, sondern das Scharnier: eine Spaltenkante neben der Falz sieht
 * aus wie ein Fehler, nicht wie eine Gestaltung.
 */
fun listPaneFraction(widthDp: Int, foldedVertically: Boolean): Float = when {
    foldedVertically -> 0.5f
    widthDp >= 960 -> 0.38f
    else -> 0.42f
}

/**
 * Trägt das Gerät gerade eine senkrechte Falz, die das Fenster teilt?
 *
 * Nur dann ist 50/50 richtig. Ein waagerechtes Scharnier (Flex Mode) teilt
 * oben und unten und geht die Spaltenaufteilung nichts an.
 *
 * Ohne Activity — etwa in einer Vorschau — bleibt es bei `false`, statt zu
 * raten.
 */
@Composable
fun rememberVerticalFold(): State<Boolean> {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    return produceState(initialValue = false, activity) {
        val host = activity ?: return@produceState
        WindowInfoTracker.getOrCreate(host)
            .windowLayoutInfo(host)
            .collect { layoutInfo ->
                value = layoutInfo.displayFeatures
                    .filterIsInstance<FoldingFeature>()
                    .any { it.orientation == FoldingFeature.Orientation.VERTICAL }
            }
    }
}

/**
 * Die Activity hinter einem Compose-Context: `LocalContext` liefert dort oft
 * einen ContextWrapper und nicht die Activity selbst.
 */
private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
