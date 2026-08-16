package com.pocketagent.app

import com.pocketagent.app.data.AgentEvent
import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.PermissionDecision
import com.pocketagent.app.data.PermissionKind
import com.pocketagent.app.ui.screens.TimelineItem
import com.pocketagent.app.ui.screens.buildTimeline
import com.pocketagent.app.ui.screens.eventIdentity
import com.pocketagent.app.ui.screens.mergeEvents
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Der Verlauf kommt am Stück vom Server, während der Live-Strom weiterläuft.
 * Hier steht, dass dabei nichts doppelt und nichts verloren geht.
 */
class TimelineMergeTest {

    private fun user(text: String) = AgentEvent.MessageCompleted("user", text)
    private fun assistant(text: String) = AgentEvent.MessageCompleted("assistant", text)
    private fun call(id: String) = AgentEvent.ToolCall(id = id, tool = "bash", input = null, title = null)
    private fun result(id: String) = AgentEvent.ToolResult(id = id, tool = "bash", output = "ok", isError = null)

    @Test
    fun `history alone builds the timeline in order`() {
        val items = buildTimeline(
            listOf(
                user("Bau den Login um"),
                call("c1"),
                result("c1"),
                assistant("Fertig."),
                AgentEvent.TurnCompleted(summary = null, usage = null, commitSha = "abc1234"),
            ),
        )
        assertEquals(4, items.size)
        assertEquals("Bau den Login um", (items[0] as TimelineItem.Chat).text)
        // Das Ergebnis hängt sich an seinen Aufruf, statt eine Zeile zu belegen
        val tool = items[1] as TimelineItem.Tool
        assertEquals("c1", tool.id)
        assertEquals("ok", tool.result?.output)
        assertEquals("abc1234", (items[3] as TimelineItem.TurnEnd).commitSha)
    }

    @Test
    fun `events without their own line leave the timeline untouched`() {
        val items = buildTimeline(
            listOf(
                AgentEvent.Status("claude", null, null, null, AgentMode.AUTO, busy = true),
                AgentEvent.MessageDelta("assistant", "Teil"),
                AgentEvent.Ping(1L),
                AgentEvent.Notice("Image wird gebaut", phase = "image-build", detail = "Step 3/7"),
                AgentEvent.Notice("Agent gewechselt"),
            ),
        )
        // Nur die Notice ohne Phase ist eine Systemzeile
        assertEquals(1, items.size)
        assertEquals("Agent gewechselt", (items[0] as TimelineItem.Notice).text)
    }

    @Test
    fun `empty history and empty live stay empty`() {
        assertTrue(mergeEvents(emptyList(), emptyList()).isEmpty())
        assertTrue(buildTimeline(emptyList()).isEmpty())
    }

    @Test
    fun `live events already contained in the history are dropped`() {
        val history = listOf(user("Los geht's"), call("c1"), result("c1"), assistant("Fertig."))
        // Genau diese beiden kamen live herein, während die Anfrage lief —
        // der Server hatte sie schon im Schnappschuss.
        val live = listOf(result("c1"), assistant("Fertig."))

        val merged = mergeEvents(history, live)
        assertEquals(history, merged)
        val items = buildTimeline(merged)
        assertEquals(3, items.size)
        assertEquals(1, items.count { it is TimelineItem.Chat && it.text == "Fertig." })
    }

    @Test
    fun `live events newer than the snapshot are appended`() {
        val history = listOf(user("Los geht's"), assistant("Fertig."))
        val live = listOf(assistant("Fertig."), user("Und jetzt die Tests"), call("c9"))

        val merged = mergeEvents(history, live)
        assertEquals(4, merged.size)
        assertEquals(user("Und jetzt die Tests"), merged[2])
        assertEquals(call("c9"), merged[3])
    }

    @Test
    fun `identical messages sent twice both survive`() {
        // Der Nutzer hat wirklich zweimal "ok" geschickt; der Verlauf kennt
        // beide. Live kommt nur eines davon nach — es darf nicht zu drei
        // Zeilen führen, aber auch nicht auf eine zusammenfallen.
        val history = listOf(user("ok"), user("ok"))
        val live = listOf(user("ok"))
        assertEquals(2, buildTimeline(mergeEvents(history, live)).size)

        // Umgekehrt: der Verlauf kennt eines, live kommen zwei -> drei
        // Vorkommen insgesamt sind eines zu viel, also bleibt es bei zwei.
        val late = mergeEvents(listOf(user("ok")), listOf(user("ok"), user("ok")))
        assertEquals(2, buildTimeline(late).size)
    }

    @Test
    fun `permission request and its resolution deduplicate by id`() {
        val request = AgentEvent.PermissionRequest(
            permissionId = "p1",
            kind = PermissionKind.BASH,
            title = "bash: rm -rf build",
            detail = null,
            diff = null,
            patterns = emptyList(),
        )
        val resolved = AgentEvent.PermissionResolved("p1", PermissionDecision.ONCE)

        val merged = mergeEvents(listOf(request, resolved), listOf(request, resolved))
        val items = buildTimeline(merged)
        assertEquals(1, items.size)
        val approval = items[0] as TimelineItem.Approval
        assertEquals("p1", approval.permissionId)
        assertEquals(PermissionDecision.ONCE, approval.resolved)
    }

    @Test
    fun `events without an own line are never deduplicated`() {
        // Sie verändern die Timeline nicht, also gibt es nichts zu schützen —
        // und ein Merkmal, das mehrfach vorkommt, dürfte nichts verschlucken.
        assertNull(eventIdentity(AgentEvent.Ping(1L)))
        assertNull(eventIdentity(AgentEvent.MessageDelta("assistant", "x")))
        assertNull(eventIdentity(AgentEvent.Status("claude", null, null, null, AgentMode.AUTO, busy = false)))

        val ping = AgentEvent.Ping(1L)
        val merged = mergeEvents(listOf(ping), listOf(ping))
        assertEquals(2, merged.size)
        assertTrue(buildTimeline(merged).isEmpty())
    }

    @Test
    fun `identity separates events that only look alike`() {
        // Gleicher Text, andere Rolle -> zwei verschiedene Ereignisse
        assertTrue(eventIdentity(user("hallo")) != eventIdentity(assistant("hallo")))
        // Gleiche Id, anderer Ereignistyp -> ebenfalls verschieden
        assertTrue(eventIdentity(call("c1")) != eventIdentity(result("c1")))

        val merged = mergeEvents(listOf(user("hallo")), listOf(assistant("hallo")))
        assertEquals(2, buildTimeline(merged).size)
    }

    @Test
    fun `merge keeps history when nothing arrived live`() {
        val history = listOf(user("a"), assistant("b"))
        assertEquals(history, mergeEvents(history, emptyList()))
        // Und ohne Verlauf bleibt der Live-Rest vollständig erhalten
        assertEquals(history, mergeEvents(emptyList(), history))
    }
}
