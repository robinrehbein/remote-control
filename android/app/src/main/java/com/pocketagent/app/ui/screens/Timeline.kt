package com.pocketagent.app.ui.screens

import com.pocketagent.app.data.AgentEvent
import com.pocketagent.app.data.PermissionDecision

/* ------------------------------------------------------------------ */
/* Timeline model                                                      */
/* ------------------------------------------------------------------ */

sealed interface TimelineItem {
    data class Chat(
        val role: String,
        val text: String,
    ) : TimelineItem

    data class Tool(
        val id: String,
        val tool: String,
        val title: String?,
        val input: kotlinx.serialization.json.JsonElement?,
        val result: AgentEvent.ToolResult?,
    ) : TimelineItem

    data class Approval(
        val permissionId: String,
        val kind: String,
        val title: String,
        val detail: String?,
        val diff: String?,
        val resolved: PermissionDecision?,
    ) : TimelineItem

    data class TurnEnd(
        val summary: String?,
        val commitSha: String?,
    ) : TimelineItem

    data class Pushed(
        val branch: String,
        val prUrl: String?,
        val auto: Boolean,
    ) : TimelineItem

    data class Error(val message: String) : TimelineItem

    /** Systemhinweis des Servers, z. B. Image-Build oder Agent-Wechsel. */
    data class Notice(val text: String) : TimelineItem
}

/* ------------------------------------------------------------------ */
/* Reduktion: Ereignisse -> Timeline                                   */
/* ------------------------------------------------------------------ */

/**
 * Ein Ereignis auf die Timeline anwenden. Rein: derselbe Verlauf ergibt
 * immer dieselbe Liste — egal ob die Ereignisse live hereinkommen oder
 * als gespeicherter Verlauf am Stück.
 *
 * Ereignisse ohne eigene Zeile (Status, Deltas, Ping, Fortschritts-Notices)
 * lassen die Liste unverändert; sie wirken anderswo (Busy-Anzeige,
 * Start-Fortschritt) und gehören nicht in den Verlauf.
 */
fun reduceTimeline(items: List<TimelineItem>, event: AgentEvent): List<TimelineItem> = when (event) {
    is AgentEvent.MessageCompleted -> items + TimelineItem.Chat(event.role, event.text)

    is AgentEvent.ToolCall -> items + TimelineItem.Tool(
        id = event.id,
        tool = event.tool,
        title = event.title,
        input = event.input,
        result = null,
    )

    is AgentEvent.ToolResult -> items.map { item ->
        if (item is TimelineItem.Tool && item.id == event.id) item.copy(result = event) else item
    }

    is AgentEvent.PermissionRequest -> items + TimelineItem.Approval(
        permissionId = event.permissionId,
        kind = event.kind.name.lowercase(),
        title = event.title,
        detail = event.detail,
        diff = event.diff,
        resolved = null,
    )

    is AgentEvent.PermissionResolved -> items.map { item ->
        if (item is TimelineItem.Approval && item.permissionId == event.permissionId) {
            item.copy(resolved = event.decision)
        } else {
            item
        }
    }

    is AgentEvent.TurnCompleted -> items + TimelineItem.TurnEnd(event.summary, event.commitSha)
    is AgentEvent.Pushed -> items + TimelineItem.Pushed(event.branch, event.prUrl, event.auto)

    is AgentEvent.TurnFailed -> {
        // Kopfzeile bleibt handlungsleitend; der Servertext – falls
        // vorhanden – steht nur als Nebensatz dahinter (wie beim
        // Fehlschlag einer Änderung im SessionScreen).
        val cause = event.error.takeIf { it.isNotBlank() }?.let { " ($it)" }.orEmpty()
        items + TimelineItem.Error("Der Auftrag ist fehlgeschlagen – bitte erneut versuchen.$cause")
    }

    is AgentEvent.ErrorEvent -> items + TimelineItem.Error(event.message)

    // Mit Phase ist die Notice Startfortschritt und lebt über dem Composer,
    // nicht in der Timeline — sonst stapelt sich derselbe Vorgang.
    is AgentEvent.Notice -> if (event.phase.isNullOrBlank()) {
        items + TimelineItem.Notice(event.message)
    } else {
        items
    }

    is AgentEvent.Status, is AgentEvent.MessageDelta, is AgentEvent.Ping -> items
}

/** Den kompletten Verlauf am Stück in eine Timeline falten. */
fun buildTimeline(events: List<AgentEvent>): List<TimelineItem> =
    events.fold(emptyList()) { acc, event -> reduceTimeline(acc, event) }

/* ------------------------------------------------------------------ */
/* Zusammenführen von Verlauf und Live-Strom                           */
/* ------------------------------------------------------------------ */

/**
 * Erkennungsmerkmal eines Ereignisses für die Dedupe.
 *
 * Der Vertrag gab Ereignissen ursprünglich weder Id noch Zeitstempel — also
 * kam die Identität aus dem Inhalt. Wo es eine fachliche Id gibt (Tool-Call,
 * Permission), ist sie das Kriterium; sonst zählte der vollständige Inhalt.
 * Seit W2.1 (Event-Replay) prägt der Server jedem sequenzierten Ereignis
 * eine `seq` auf (`AgentEvent.seq`) — trägt ein Ereignis sie, ist sie das
 * präzisere Merkmal: zwei Zeilen mit derselben `seq` sind serverseitig
 * garantiert dasselbe Ereignis (etwa nach einem Reconnect, wenn der geladene
 * Verlauf einen bereits live gesehenen Turn erneut liefert), während
 * Inhaltsgleichheit offenlässt, ob das ein Resend ist oder eine echte
 * Wiederholung (zwei tatsächlich gesendete „ok“). Fehlt sie (älterer
 * Server), bleibt es beim Inhaltsvergleich.
 *
 * null heißt „hat keine eigene Zeile“ (Status, Delta, Ping) — solche
 * Ereignisse werden nie dedupliziert, weil sie die Liste nicht verändern;
 * das gilt unabhängig von einer vorhandenen `seq`.
 */
fun eventIdentity(event: AgentEvent): String? {
    val contentKey = when (event) {
        is AgentEvent.ToolCall -> "tool.call:${event.id}"
        is AgentEvent.ToolResult -> "tool.result:${event.id}"
        is AgentEvent.PermissionRequest -> "permission.request:${event.permissionId}"
        is AgentEvent.PermissionResolved -> "permission.resolved:${event.permissionId}"
        is AgentEvent.MessageCompleted -> "message.completed:${event.role}\u0000${event.text}"
        is AgentEvent.TurnCompleted -> "turn.completed:${event.commitSha}\u0000${event.summary}"
        is AgentEvent.Pushed -> "pushed:${event.branch}\u0000${event.prUrl}\u0000${event.auto}"
        is AgentEvent.TurnFailed -> "turn.failed:${event.error}"
        is AgentEvent.ErrorEvent -> "error:${event.message}"
        is AgentEvent.Notice -> "notice:${event.phase}\u0000${event.message}\u0000${event.detail}"
        is AgentEvent.Status, is AgentEvent.MessageDelta, is AgentEvent.Ping -> null
    } ?: return null
    return event.seq?.let { "seq:$it" } ?: contentKey
}

/**
 * Gespeicherten Verlauf und den live mitgeschriebenen Rest zusammenführen.
 *
 * Warum es überhaupt Überschneidung gibt: zwischen dem Absenden von
 * `session.events.get` und der Antwort läuft der Live-Strom weiter. Was in
 * dieser Lücke ankommt, kann der Server bereits in seinen Schnappschuss
 * gelegt haben — oder eben nicht. Beides muss richtig herauskommen.
 *
 * Das Kriterium ist kein reines „kenne ich den Inhalt schon?“, sondern ein
 * **Mengenabgleich**: für jedes Erkennungsmerkmal zählt der Verlauf, wie oft
 * es vorkommt. Ein Live-Ereignis wird nur dann verworfen, wenn von seinem
 * Merkmal noch ein ungenutztes Vorkommen im Verlauf übrig ist. So bleiben
 * zwei echt gleiche Nachrichten („ok“, „ok“) beide erhalten, während
 * derselbe Vorgang, der doppelt hereinkommt, nur einmal erscheint.
 *
 * Der Vergleich betrifft ausschließlich den kurzen Zeitraum, in dem die
 * Anfrage unterwegs war — [live] enthält nur, was ab dem Absenden gepuffert
 * wurde. Damit bleibt das Fenster für einen Fehlgriff (gleicher Inhalt,
 * aber echt neues Ereignis) auf eine Netzwerkrunde beschränkt.
 */
fun mergeEvents(history: List<AgentEvent>, live: List<AgentEvent>): List<AgentEvent> {
    if (live.isEmpty()) return history
    if (history.isEmpty()) return live
    val budget = HashMap<String, Int>()
    for (event in history) {
        val key = eventIdentity(event) ?: continue
        budget[key] = (budget[key] ?: 0) + 1
    }
    val tail = ArrayList<AgentEvent>(live.size)
    for (event in live) {
        val key = eventIdentity(event)
        val left = if (key == null) 0 else budget[key] ?: 0
        if (key != null && left > 0) {
            budget[key] = left - 1
            continue
        }
        tail += event
    }
    return history + tail
}
