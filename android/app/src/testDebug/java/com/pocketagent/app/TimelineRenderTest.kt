package com.pocketagent.app

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.pocketagent.app.data.ServerMessage
import com.pocketagent.app.data.parseServerMessage
import com.pocketagent.app.ui.screens.SessionViewModel
import com.pocketagent.app.ui.screens.TimelineItem
import com.pocketagent.app.ui.screens.TimelineItemView
import com.pocketagent.app.ui.screens.buildTimeline
import com.pocketagent.app.ui.theme.PocketAgentTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Rendert die Chat-Timeline wirklich — mit dem Wire-Format als Ausgangspunkt.
 *
 * Fund: die Endlos-Rekursion im Markdown-Renderer (appendRuns → appendTail →
 * appendRuns, seit v0.1) crashte die App bei jeder Agenten-Antwort und wurde
 * von den reinen JVM-Logik-Tests nie gefangen, weil kein Test je die
 * Compose-UI aufgebaut hat. Dieser Test schließt genau diese Lücke: Fixture
 * im session.events-Wire-Format → parseServerMessage (testet nebenbei den
 * Decoder) → buildTimeline → jede Karte im App-Theme rendern.
 *
 * Ein unge-bundenes SessionViewModel() genügt: TimelineItemView fasst es nur
 * in Klick-Handlern an, die der Test nicht auslöst.
 *
 * Liegt bewusst in `testDebug`, nicht in `test`: createComposeRule() braucht
 * die ComponentActivity aus ui-test-manifest, die nur ins Debug-Manifest
 * gemergt wird — ins Release-APK darf sie nicht. `testReleaseUnitTest`
 * (Release-Workflow) fand die Activity daher nicht und schlug fehl (Fund:
 * Release-Run 48, v0.13.0). Das Gerenderte ist variantenunabhängig; einmal
 * pro Build in der Debug-Variante reicht.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TimelineRenderTest {

    @get:Rule
    val compose = createComposeRule()

    private fun loadEvents(): List<com.pocketagent.app.data.AgentEvent> {
        val raw = checkNotNull(javaClass.classLoader?.getResourceAsStream("fixtures/session-events.json")) {
            "Fixture fixtures/session-events.json fehlt im Test-Classpath"
        }.use { it.readBytes().decodeToString() }
        val msg = parseServerMessage(raw) as ServerMessage.SessionEventsMsg
        return msg.events
    }

    @Test
    fun `kompletter Verlauf aus dem Wire-Format rendert ohne Absturz`() {
        val events = loadEvents()
        // Alle 18 Fixture-Ereignisse müssen den Decoder überleben — fällt hier
        // eines heraus, ist das Wire-Format und nicht das Rendering kaputt.
        assertEquals(18, events.size)

        val items = buildTimeline(events)
        // 2 Chat, 2 Tool, 2 Approval, 1 Notice (die mit phase bleibt draußen),
        // TurnEnd, Pushed, turn.failed-Error, error — status/delta/ping ohne Zeile.
        assertEquals(11, items.size)

        compose.setContent {
            PocketAgentTheme(darkTheme = false) {
                val vm = SessionViewModel()
                Column {
                    items.forEach { TimelineItemView(it, vm) }
                }
            }
        }

        // Kern-Assertion ist das setContent selbst: die alte Endlos-Rekursion
        // wäre hier als StackOverflowError geflogen. Der Rest sind Stichproben.
        compose.onNodeWithText("Bitte räum den Markdown-Renderer auf und push das Ergebnis.").assertExists()

        // Markdown: Marker gestript, Inhalt sichtbar.
        compose.onNodeWithText("Aufräumen erledigt").assertExists()
        compose.onNodeWithText("Renderer komplett überarbeitet", substring = true).assertExists()
        compose.onNodeWithText("inline code bleibt monospaced", substring = true).assertExists()
        compose.onNodeWithText("Hallo PocketAgent", substring = true).assertExists()

        // Tool-Karten: Titel bzw. Toolname als Kopfzeile.
        compose.onNodeWithText("bash: gradle :app:testDebugUnitTest").assertExists()

        // Approvals: beide Karten, eine entschieden, eine offen mit Buttons.
        compose.onAllNodesWithText("Bestätigung erforderlich").assertCountEquals(2)
        compose.onNodeWithText("Markdown.kt ändern").assertExists()
        compose.onNodeWithText("Erlaubt").assertExists()
        compose.onNodeWithText("npm install ausführen").assertExists()
        compose.onNodeWithText("Erlauben").assertExists()
        compose.onNodeWithText("Ablehnen").assertExists()

        // Systemzeilen: Turn-Ende mit gekürztem SHA, Notice ohne Phase drin,
        // Start-Fortschritt (Notice mit Phase) draußen.
        compose.onNodeWithText("Fertig · a1b2c3d · Renderer gefixt").assertExists()
        compose.onNodeWithText("Arbeitsverzeichnis vorbereitet").assertExists()
        compose.onAllNodesWithText("Image wird gebaut…").assertCountEquals(0)

        // Push-Karte mit PR, Fehlerkarten.
        compose.onNodeWithText("Automatisch gepusht", substring = true).assertExists()
        compose.onNodeWithText("pocketagent/markdown-fix").assertExists()
        compose.onNodeWithText("pi wurde mit Code 1 beendet", substring = true).assertExists()
        compose.onNodeWithText("Verbindung zum Runner verloren").assertExists()
    }

    @Test
    // ASCII-Testname mit Absicht: das Dateisystem des CI-Containers laeuft im
    // POSIX-Locale, ein Nicht-ASCII-Zeichen im Namen macht den .class-Pfad
    // unschreibbar (InvalidPathException beim Kompilieren).
    fun `Assistant-Markdown-Bubble allein rendert (Regressionsfall)`() {
        // Genau der Content, der die App früher bei jeder Antwort abriss.
        val bubble = buildTimeline(loadEvents())
            .filterIsInstance<TimelineItem.Chat>()
            .first { it.role == "assistant" }

        compose.setContent {
            PocketAgentTheme(darkTheme = false) {
                TimelineItemView(bubble, SessionViewModel())
            }
        }

        compose.onNodeWithText("Aufräumen erledigt").assertExists()
        compose.onNodeWithText("Damit rendert jede Antwort ohne StackOverflow.").assertExists()
    }
}
