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
    if (archiveSwipeArchives(archived)) "Archivieren" else "Wiederherstellen"

/** Bestätigung nach dem Wisch — dieselbe Sprache wie im Kontextmenü. */
fun archiveDoneLabel(archived: Boolean): String =
    if (archived) "Session archiviert" else "Session wiederhergestellt"

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
            SessionStatus.CREATING, SessionStatus.ERROR -> Unit
        }
        val live = session.status == SessionStatus.RUNNING || session.status == SessionStatus.IDLE
        if (live && session.mode != AgentMode.YOLO) add(SessionAction.PUSH)
    }
    if (!session.prUrl.isNullOrBlank()) add(SessionAction.OPEN_PR)
    add(SessionAction.DELETE)
}

fun sessionActionLabel(action: SessionAction): String = when (action) {
    SessionAction.RENAME -> "Umbenennen"
    SessionAction.ARCHIVE -> "Archivieren"
    SessionAction.UNARCHIVE -> "Aus Archiv holen"
    SessionAction.STOP -> "Container anhalten"
    SessionAction.RESUME -> "Fortsetzen"
    SessionAction.PUSH -> "Änderungen pushen"
    SessionAction.OPEN_PR -> "Pull Request öffnen"
    SessionAction.DELETE -> "Löschen"
}

/**
 * Der Text unter dem Menüeintrag, wo eine Erklärung nötig ist. Alles
 * andere erklärt sich selbst und bleibt einzeilig.
 */
fun sessionActionNote(action: SessionAction): String? = when (action) {
    SessionAction.ARCHIVE -> "Container wird gestoppt, der Arbeitsstand bleibt erhalten"
    SessionAction.UNARCHIVE -> "Zurück in die Liste; Fortsetzen startet den Container neu"
    SessionAction.DELETE -> "Endgültig – mit Verlauf und Arbeitsstand"
    else -> null
}

/** Text der Löschbestätigung; benennt, was tatsächlich verloren geht. */
fun deleteConfirmText(session: SessionInfo): String =
    "„${sessionDisplayName(session)}“ wird endgültig gelöscht, inklusive Verlauf und " +
        "Arbeitsstand. Container, Volume und Netz werden entfernt. Das lässt sich nicht " +
        "rückgängig machen."
