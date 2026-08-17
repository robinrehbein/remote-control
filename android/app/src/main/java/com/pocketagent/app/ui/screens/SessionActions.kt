package com.pocketagent.app.ui.screens

import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.SessionInfo
import com.pocketagent.app.data.SessionStatus

/* ------------------------------------------------------------------ */
/* Anzeigename                                                         */
/* ------------------------------------------------------------------ */

/**
 * Wie die Session heißt: der vergebene Titel, sonst das Repository.
 * Ein leerer oder nur aus Leerzeichen bestehender Titel zählt als kein
 * Titel — der Server entfernt ihn dann ohnehin.
 */
fun sessionDisplayName(session: SessionInfo): String =
    session.title?.trim()?.takeIf { it.isNotEmpty() }
        ?: session.repoFullName?.trim()?.takeIf { it.isNotEmpty() }
        ?: "Session"

/**
 * Die Unterzeile zum Anzeigenamen: das Repository, aber nur solange es
 * nicht schon in der ersten Zeile steht. Ohne Titel gibt es also keine
 * doppelte Zeile.
 */
fun sessionSubtitle(session: SessionInfo): String? =
    session.repoFullName?.trim()
        ?.takeIf { it.isNotEmpty() && it != sessionDisplayName(session) }

/* ------------------------------------------------------------------ */
/* Aktiv / Archiv                                                      */
/* ------------------------------------------------------------------ */

/** Was in der Hauptliste steht. Archivierte Sessions kommen weiter vom Server. */
fun activeSessions(all: List<SessionInfo>): List<SessionInfo> = all.filterNot { it.archived }

/** Was hinter „Archiv“ liegt. */
fun archivedSessions(all: List<SessionInfo>): List<SessionInfo> = all.filter { it.archived }

/* ------------------------------------------------------------------ */
/* Wischgesten                                                         */
/* ------------------------------------------------------------------ */

/**
 * Was ein Wisch nach links (von rechts kommend) auslöst: bei einer aktiven
 * Session das Archivieren, bei einer archivierten das Zurückholen. Der
 * Wisch nach rechts ist immer das Löschen und braucht darum keine Funktion.
 */
fun archiveSwipeArchives(archived: Boolean): Boolean = !archived

/** Beschriftung des Wisch-Hintergrunds auf der Archiv-Seite. */
fun archiveSwipeLabel(archived: Boolean): String =
    if (archiveSwipeArchives(archived)) "Archivieren" else "Aus Archiv holen"

/** Bestätigung nach dem Wisch — dieselbe Sprache wie im Kontextmenü. */
fun archiveDoneLabel(archived: Boolean): String =
    if (archived) "Session archiviert" else "Aus Archiv geholt"

/* ------------------------------------------------------------------ */
/* Kontextmenü                                                         */
/* ------------------------------------------------------------------ */

enum class SessionAction { RENAME, ARCHIVE, UNARCHIVE, STOP, RESUME, PUSH, OPEN_PR, DELETE }

/**
 * Welche Einträge das Kontextmenü einer Session zeigt — in dieser
 * Reihenfolge, Löschen immer zuletzt.
 *
 * Regeln:
 * - Umbenennen geht immer.
 * - Eine archivierte Session ist serverseitig gestoppt und ihr Container
 *   ist weg. Stoppen, Fortsetzen und Pushen ergeben dort keinen Sinn;
 *   der Weg zurück heißt „Aus Archiv holen“.
 * - Stoppen nur, wenn etwas läuft (RUNNING/IDLE). Beim Starten (CREATING)
 *   und im Fehlerfall gibt es nichts anzuhalten.
 * - Fortsetzen nur bei gestoppter Session.
 * - Pushen bietet nur an, wer nicht im Yolo-Modus arbeitet — dort pusht
 *   der Agent selbst — und wessen Session gerade lebt.
 * - Den Pull Request gibt es nur, wenn es einen gibt.
 */
fun sessionActions(session: SessionInfo): List<SessionAction> = buildList {
    add(SessionAction.RENAME)
    if (session.archived) {
        add(SessionAction.UNARCHIVE)
    } else {
        add(SessionAction.ARCHIVE)
        when (session.status) {
            SessionStatus.RUNNING, SessionStatus.IDLE -> add(SessionAction.STOP)
            SessionStatus.STOPPED -> add(SessionAction.RESUME)
            SessionStatus.CREATING, SessionStatus.ERROR, SessionStatus.UNKNOWN -> Unit
        }
        val live = session.status == SessionStatus.RUNNING || session.status == SessionStatus.IDLE
        if (live && session.mode != AgentMode.YOLO) add(SessionAction.PUSH)
    }
    if (!session.prUrl.isNullOrBlank()) add(SessionAction.OPEN_PR)
    add(SessionAction.DELETE)
}

/**
 * Ob der Diff-Screen die Push-Aktion anbietet. Dieselbe Regel wie im
 * Kontextmenü (siehe [sessionActions]): nur eine laufende Session
 * (RUNNING/IDLE) außerhalb des Yolo-Modus, in dem der Agent selbst pusht —
 * plus die eigene Bedingung des Diff-Screens, dass überhaupt etwas geändert
 * wurde. So liegt „Pushen & Draft-PR" am Ort der Prüfung, nicht nur im
 * Overflow-Menü eines anderen Screens.
 */
fun diffPushAvailable(session: SessionInfo?, hasChanges: Boolean): Boolean {
    if (session == null || !hasChanges) return false
    val live = session.status == SessionStatus.RUNNING || session.status == SessionStatus.IDLE
    return live && session.mode != AgentMode.YOLO
}

/** Der runde Knopf im Composer hat genau diese drei Gestalten. */
enum class ComposerButton { SEND, STOP, SENDING }

/**
 * Was der Composer-Knopf gerade ist. Läuft ein Auftrag, bricht ihn derselbe
 * Knopf ab — das einzige Stop-Konzept für den laufenden Zug, im Daumenbereich
 * und eindeutig „bricht das Laufende ab". Wartet ein Prompt noch auf seine
 * Bestätigung, dreht der Knopf; sonst sendet er. Das Anhalten der ganzen
 * Session („Session pausieren") bleibt davon getrennt im Menü.
 */
fun composerButton(busy: Boolean, sending: Boolean): ComposerButton = when {
    busy -> ComposerButton.STOP
    sending -> ComposerButton.SENDING
    else -> ComposerButton.SEND
}

fun sessionActionLabel(action: SessionAction): String = when (action) {
    SessionAction.RENAME -> "Umbenennen"
    SessionAction.ARCHIVE -> "Archivieren"
    SessionAction.UNARCHIVE -> "Aus Archiv holen"
    SessionAction.STOP -> "Session pausieren"
    SessionAction.RESUME -> "Fortsetzen"
    SessionAction.PUSH -> "Änderungen pushen"
    SessionAction.OPEN_PR -> "Pull Request öffnen"
    SessionAction.DELETE -> "Löschen"
}

/**
 * Der Text unter dem Menüeintrag, wo eine Erklärung nötig ist. Alles
 * andere erklärt sich selbst und bleibt einzeilig. Für Link-Sessions sagen
 * die Erklärungen, was auf dem Agenten-Host passiert — „Container“ gäbe es
 * dort nicht.
 */
fun sessionActionNote(action: SessionAction, session: SessionInfo): String? = when (action) {
    SessionAction.ARCHIVE ->
        if (session.linked) "Der Agent auf dem Host läuft weiter"
        else "Container wird gestoppt, der Arbeitsstand bleibt erhalten"

    SessionAction.UNARCHIVE ->
        if (session.linked) "Zurück in die Liste"
        else "Zurück in die Liste; Fortsetzen startet den Container neu"

    SessionAction.STOP ->
        if (session.linked) "Beendet den Agenten-Prozess auf dem Host – dort neu starten"
        else "Der Container wird beendet; Fortsetzen startet ihn neu"

    SessionAction.RESUME ->
        if (session.linked) "Klappt erst, wenn der Agenten-Host wieder verbunden ist"
        else null

    SessionAction.DELETE -> "Endgültig – mit Verlauf und Arbeitsstand"
    else -> null
}

/** Text der Löschbestätigung; benennt, was tatsächlich verloren geht. */
fun deleteConfirmText(session: SessionInfo): String =
    "„${sessionDisplayName(session)}“ wird endgültig gelöscht, inklusive Verlauf und " +
        "Arbeitsstand. Das lässt sich nicht rückgängig machen."
