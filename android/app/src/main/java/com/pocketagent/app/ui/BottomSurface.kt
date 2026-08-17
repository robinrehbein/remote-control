package com.pocketagent.app.ui

import android.os.Build
import android.view.WindowManager
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import com.pocketagent.app.ui.theme.BottomSurfaceGap

/*
 * ------------------------------------------------------------------
 * Unten verankerte Flächen: Dialog und Sheet
 * ------------------------------------------------------------------
 *
 * Beide liegen bei One UI unten, in Daumennähe, und beide tragen ihre
 * Aktionszeile ganz unten. Genau dort liegt aber auch die Gestenleiste, und
 * sobald ein Eingabefeld im Spiel ist, kommt die Tastatur dazu. Damit
 * „Abbrechen“ und „Übernehmen“ verlässlich tippbar bleiben, brauchen beide
 * dieselben drei Dinge — deshalb stehen sie hier an einer Stelle und nicht
 * je Screen noch einmal:
 *
 *   1. Insets, die stimmen ([ProvideAppInsets], [bottomSurfacePadding]).
 *   2. Ein Fenster, das sich nicht selbst verschiebt ([KeepWindowStillForIme]).
 *   3. Einen Inhalt, der scrollt, statt die Aktionszeile hinauszudrücken —
 *      das machen `OneUiDialog` und `SettingSheet` in ihrem eigenen Aufbau.
 */

/**
 * Die Insets des App-Fensters, festgehalten, damit sie auch in einem eigenen
 * Fenster gelten.
 *
 * Der Grund ist der Kern dieses Fehlers: `WindowInsets.safeDrawing` löst gegen
 * das Fenster auf, in dem es *gelesen* wird. Ein Dialog hat ein eigenes
 * Fenster, und ein Dialogfenster ist per Voreinstellung „floating" — das
 * System legt es von sich aus innerhalb der Systemleisten aus und meldet ihm
 * deshalb Insets von null. Eine Polsterung nach `safeDrawing` im Dialog
 * rechnet damit gegen lauter Nullen und bewirkt nichts; genau das ist der
 * Grund, warum die Aktionszeile trotz vorhandener Inset-Behandlung auf der
 * Gestenleiste lag.
 *
 * Das App-Fenster dagegen meldet richtig: `MainActivity` schaltet es per
 * `enableEdgeToEdge()` randlos, und `android:windowSoftInputMode="adjustResize"`
 * im Manifest sorgt dafür, dass auch die Tastatur als Inset ankommt. Diese
 * Werte werden hier eingesammelt und über die Komposition weitergereicht —
 * Dialoge und Sheets sind Unterkompositionen und erben sie.
 */
@Immutable
class AppInsets(
    /** Systemleisten, Kameraausschnitt und Tastatur des App-Fensters. */
    val safeDrawing: WindowInsets,
    /** Nur die Tastatur — für alles, was seine Höhe nach ihr richtet. */
    val ime: WindowInsets,
)

private val LocalAppInsets = staticCompositionLocalOf<AppInsets?> { null }

/**
 * Reicht die Insets des App-Fensters an die ganze Komposition weiter. Gehört
 * genau einmal um den Inhalt der Activity (siehe `PocketAgentTheme`).
 */
@Composable
fun ProvideAppInsets(content: @Composable () -> Unit) {
    val safeDrawing = WindowInsets.safeDrawing
    val ime = WindowInsets.ime
    // remember, weil ein neues AppInsets bei jeder Rekomposition den statischen
    // CompositionLocal ändern und damit den gesamten Baum neu bauen würde. Die
    // beiden Inset-Objekte selbst sind über die Lebensdauer des Fensters
    // stabil; ihre Werte stecken in Snapshot-State und ändern sich, ohne dass
    // die Objekte getauscht werden.
    val insets = remember(safeDrawing, ime) { AppInsets(safeDrawing, ime) }
    CompositionLocalProvider(LocalAppInsets provides insets, content = content)
}

/**
 * Ab Android 11 gehört der Inset-Zustand dem Display und wird an *jedes*
 * Fenster gemeldet — auch an das App-Fenster, während ein Dialog den
 * Eingabefokus hat. Darunter erfährt nur das fokussierte Fenster von der
 * Tastatur; dort wäre der Umweg über das App-Fenster falsch.
 *
 * Deshalb genau hier die Grenze: darunter meldet das Dialogfenster selbst
 * richtig (Compose nimmt ihm unter API 31 das „floating" ab und stellt es auf
 * `ADJUST_RESIZE`), darüber tut es das nicht mehr — und das App-Fenster tut es.
 */
private const val DisplayWideInsetsSdk = 30

@Composable
private fun surfaceInsets(): AppInsets? =
    if (Build.VERSION.SDK_INT >= DisplayWideInsetsSdk) LocalAppInsets.current else null

/**
 * Systemleisten, Kameraausschnitt und Tastatur, aus der Quelle, die für das
 * aktuelle Fenster stimmt (siehe [DisplayWideInsetsSdk]). Ohne
 * [ProvideAppInsets] — etwa in einer Vorschau — bleibt es beim aktuellen
 * Fenster, statt null zu liefern.
 */
@Composable
fun surfaceSafeInsets(): WindowInsets = surfaceInsets()?.safeDrawing ?: WindowInsets.safeDrawing

/** Nur die Tastatur, aus derselben Quelle wie [surfaceSafeInsets]. */
@Composable
fun surfaceImeInsets(): WindowInsets = surfaceInsets()?.ime ?: WindowInsets.ime

/**
 * Unterer Abschluss einer unten verankerten Fläche: erst der Platz, den
 * Gestenleiste oder Tastatur brauchen, dann [BottomSurfaceGap] sichtbare Luft
 * darüber.
 *
 * Seitlich kommt der Kameraausschnitt dazu — quer liegt er sonst über dem
 * Rand des Dialogs. Oben bewusst nichts: die Fläche hängt unten, ihre
 * Oberkante begrenzt ohnehin das Fenster.
 */
@Composable
fun Modifier.bottomSurfacePadding(): Modifier = this
    .windowInsetsPadding(
        surfaceSafeInsets().only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom),
    )
    .padding(bottom = BottomSurfaceGap)

/**
 * Hält das eigene Fenster still, wenn die Tastatur aufgeht.
 *
 * Ohne das schiebt das System ein Dialogfenster selbst nach oben, sobald ein
 * Feld den Fokus bekommt — `SOFT_INPUT_ADJUST_PAN`, die Voreinstellung für
 * Dialoge, die Compose ab API 31 unangetastet lässt. Geschoben wird dabei
 * genau so weit, dass das *fokussierte Feld* sichtbar wird; was darunter
 * liegt, also die Aktionszeile, wandert unter die Tastatur. Genau das ist der
 * gemeldete Fehler.
 *
 * `ADJUST_NOTHING` überlässt die Bewegung dem Inhalt. Der weicht über
 * [bottomSurfacePadding] aus — und scrollt, wo das nicht reicht.
 *
 * Unterhalb von [DisplayWideInsetsSdk] bleibt es bei dem, was Compose bzw.
 * Material selbst einstellen: dort ist das Fenster nicht „floating", wird von
 * der Tastatur verkleinert und meldet seine Insets selbst richtig.
 */
@Composable
fun KeepWindowStillForIme() {
    val view = LocalView.current
    SideEffect {
        if (Build.VERSION.SDK_INT < DisplayWideInsetsSdk) return@SideEffect
        // Der Elternteil der Compose-View ist bei Dialog und ModalBottomSheet
        // die Layout-View des jeweiligen Fensters; beide melden es über
        // DialogWindowProvider. Trifft das nicht zu, gibt es kein eigenes
        // Fenster und nichts zu stellen.
        val window = (view.parent as? DialogWindowProvider)?.window ?: return@SideEffect
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
    }
}

/* ------------------------------------------------------------------ */
/* Höhe scrollbarer Auswahllisten                                      */
/* ------------------------------------------------------------------ */

/** Höhe einer Auswahlliste, solange reichlich Platz da ist. */
val PickListPreferredHeight = 320.dp

/**
 * Darunter lohnt sich keine eigene Scrollfläche mehr: zwei Zeilen sind das
 * Wenigste, an dem noch erkennbar ist, dass es eine Liste ist.
 */
val PickListMinHeight = 120.dp

/** Anteil der freien Höhe, den eine einzelne Liste höchstens belegen darf. */
const val PickListHeightShare = 0.5f

/**
 * Wie hoch eine scrollbare Auswahlliste in einem Sheet höchstens werden darf.
 *
 * Feste 320 dp waren hochkant großzügig und quer — oder mit offener Tastatur —
 * mehr als der ganze verbleibende Platz: die Liste allein füllte das Sheet,
 * und Titel wie Aktionszeile hatten keinen mehr. Die Hälfte des freien Platzes
 * lässt beiden Rändern etwas übrig, ohne hochkant enger zu werden als vorher.
 *
 * Reine Funktion, damit die Grenzen prüfbar sind, ohne ein Gerät zu drehen.
 */
fun pickListMaxHeight(available: Dp, preferred: Dp = PickListPreferredHeight): Dp {
    // Ein Aufrufer darf einen Deckel unterhalb der Untergrenze setzen — dann
    // gilt sein Deckel. Sonst wäre die Untergrenze größer als das Maximum.
    val floor = minOf(PickListMinHeight, preferred)
    if (available <= floor) return available.coerceAtLeast(0.dp)
    return (available * PickListHeightShare).coerceIn(floor, preferred)
}

/**
 * [pickListMaxHeight] für den Platz, der gerade wirklich da ist: die Höhe des
 * App-Fensters ohne den Teil, den die Tastatur verdeckt.
 */
@Composable
fun sheetPickListMaxHeight(preferred: Dp = PickListPreferredHeight): Dp {
    val density = LocalDensity.current
    val windowHeight = LocalConfiguration.current.screenHeightDp.dp
    val imeHeight = with(density) { surfaceImeInsets().getBottom(density).toDp() }
    return pickListMaxHeight(windowHeight - imeHeight, preferred)
}
