package com.pocketagent.app

import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.SessionInfo
import com.pocketagent.app.data.SessionStatus
import com.pocketagent.app.data.SessionTarget
import com.pocketagent.app.data.effectiveTarget
import com.pocketagent.app.ui.screens.ComposerButton
import com.pocketagent.app.ui.screens.SessionAction
import com.pocketagent.app.ui.screens.activeSessions
import com.pocketagent.app.ui.screens.archiveDoneLabel
import com.pocketagent.app.ui.screens.archiveSwipeArchives
import com.pocketagent.app.ui.screens.archiveSwipeLabel
import com.pocketagent.app.ui.screens.archivedSessions
import com.pocketagent.app.ui.screens.composerButton
import com.pocketagent.app.ui.screens.deleteConfirmText
import com.pocketagent.app.ui.screens.diffPushAvailable
import com.pocketagent.app.ui.screens.sessionActionLabel
import com.pocketagent.app.ui.screens.sessionActionNote
import com.pocketagent.app.ui.screens.sessionActions
import com.pocketagent.app.ui.screens.sessionDisplayName
import com.pocketagent.app.ui.screens.sessionStatusLabel
import com.pocketagent.app.ui.screens.sessionSubtitle
import com.pocketagent.app.ui.screens.sessionTargetLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionActionsTest {

    private fun session(
        id: String = "s1",
        repo: String? = "acme/widgets",
        title: String? = null,
        status: SessionStatus = SessionStatus.IDLE,
        mode: AgentMode = AgentMode.ASK,
        archived: Boolean = false,
        prUrl: String? = null,
        linked: Boolean = false,
        target: SessionTarget? = null,
    ) = SessionInfo(
        id = id,
        repoId = "r1",
        repoFullName = repo,
        adapter = "pi",
        provider = "anthropic",
        model = "opus",
        mode = mode,
        status = status,
        branch = "main",
        createdAt = "2026-08-16T10:00:00Z",
        lastActiveAt = "2026-08-16T10:05:00Z",
        prUrl = prUrl,
        title = title,
        archived = archived,
        linked = linked,
        target = target,
    )

    /* ---------------- Anzeigename ---------------- */

    @Test
    fun `title wins over the repository name`() {
        assertEquals("Login-Bug", sessionDisplayName(session(title = "Login-Bug")))
    }

    @Test
    fun `without a title the repository is the name`() {
        assertEquals("acme/widgets", sessionDisplayName(session()))
    }

    @Test
    fun `a blank title does not count`() {
        assertEquals("acme/widgets", sessionDisplayName(session(title = "   ")))
        assertEquals("acme/widgets", sessionDisplayName(session(title = "")))
    }

    @Test
    fun `without title and repo there is still a name`() {
        assertEquals("Session", sessionDisplayName(session(repo = null)))
        assertEquals("Session", sessionDisplayName(session(repo = "  ")))
    }

    @Test
    fun `the repository is the subtitle only when a title pushed it aside`() {
        assertEquals("acme/widgets", sessionSubtitle(session(title = "Login-Bug")))
        assertNull(sessionSubtitle(session()))
        assertNull(sessionSubtitle(session(title = "acme/widgets")))
        assertNull(sessionSubtitle(session(repo = null, title = "Login-Bug")))
    }

    /* ---------------- Aktiv / Archiv ---------------- */

    @Test
    fun `archived sessions leave the main list but stay findable`() {
        val all = listOf(
            session(id = "a"),
            session(id = "b", archived = true),
            session(id = "c"),
        )
        assertEquals(listOf("a", "c"), activeSessions(all).map { it.id })
        assertEquals(listOf("b"), archivedSessions(all).map { it.id })
    }

    /* ---------------- Wischgeste ---------------- */

    @Test
    fun `the archive swipe reverses inside the archive`() {
        assertTrue(archiveSwipeArchives(archived = false))
        assertFalse(archiveSwipeArchives(archived = true))
        assertEquals("Archivieren", archiveSwipeLabel(archived = false))
        assertEquals("Aus Archiv holen", archiveSwipeLabel(archived = true))
        assertEquals("Session archiviert", archiveDoneLabel(archived = true))
        assertEquals("Aus Archiv geholt", archiveDoneLabel(archived = false))
    }

    /* ---------------- Kontextmenü ---------------- */

    @Test
    fun `idle session offers stop and push, never resume`() {
        val actions = sessionActions(session(status = SessionStatus.IDLE))
        assertEquals(
            listOf(
                SessionAction.RENAME,
                SessionAction.ARCHIVE,
                SessionAction.STOP,
                SessionAction.PUSH,
                SessionAction.DELETE,
            ),
            actions,
        )
    }

    @Test
    fun `running session behaves like an idle one`() {
        assertTrue(sessionActions(session(status = SessionStatus.RUNNING)).contains(SessionAction.STOP))
        assertFalse(sessionActions(session(status = SessionStatus.RUNNING)).contains(SessionAction.RESUME))
    }

    @Test
    fun `stopped session offers resume instead of stop and no push`() {
        val actions = sessionActions(session(status = SessionStatus.STOPPED))
        assertTrue(actions.contains(SessionAction.RESUME))
        assertFalse(actions.contains(SessionAction.STOP))
        assertFalse(actions.contains(SessionAction.PUSH))
    }

    @Test
    fun `starting or broken session offers neither stop nor resume`() {
        for (status in listOf(SessionStatus.CREATING, SessionStatus.ERROR)) {
            val actions = sessionActions(session(status = status))
            assertFalse("$status", actions.contains(SessionAction.STOP))
            assertFalse("$status", actions.contains(SessionAction.RESUME))
            assertFalse("$status", actions.contains(SessionAction.PUSH))
        }
    }

    @Test
    fun `an unrecognized future status behaves like starting or broken, not like a crash`() {
        // Fund: ein neuerer Server kennt einen status, den diese App-Version
        // nicht kennt. Die Session muss nutzbar bleiben (Umbenennen,
        // Archivieren, Löschen) statt eine Exception auszulösen — nur
        // Stop/Resume/Push, die einen bekannten Live-Zustand voraussetzen,
        // bleiben aus.
        val actions = sessionActions(session(status = SessionStatus.UNKNOWN))
        assertFalse(actions.contains(SessionAction.STOP))
        assertFalse(actions.contains(SessionAction.RESUME))
        assertFalse(actions.contains(SessionAction.PUSH))
        assertTrue(actions.contains(SessionAction.RENAME))
        assertTrue(actions.contains(SessionAction.DELETE))
    }

    @Test
    fun `yolo pushes on its own, so the menu does not offer it`() {
        assertFalse(sessionActions(session(mode = AgentMode.YOLO)).contains(SessionAction.PUSH))
        assertTrue(sessionActions(session(mode = AgentMode.AUTO)).contains(SessionAction.PUSH))
    }

    @Test
    fun `archived session offers the way back, nothing that needs a container`() {
        val actions = sessionActions(session(archived = true, status = SessionStatus.STOPPED))
        assertEquals(
            listOf(SessionAction.RENAME, SessionAction.UNARCHIVE, SessionAction.DELETE),
            actions,
        )
    }

    @Test
    fun `the pull request appears only when there is one`() {
        assertFalse(sessionActions(session()).contains(SessionAction.OPEN_PR))
        assertFalse(sessionActions(session(prUrl = "  ")).contains(SessionAction.OPEN_PR))
        assertTrue(
            sessionActions(session(prUrl = "https://github.com/acme/widgets/pull/7"))
                .contains(SessionAction.OPEN_PR),
        )
    }

    @Test
    fun `delete is always last and rename always first`() {
        val cases = listOf(
            session(),
            session(status = SessionStatus.STOPPED),
            session(archived = true),
            session(prUrl = "https://example.test/pr/1"),
            session(status = SessionStatus.ERROR),
        )
        for (s in cases) {
            val actions = sessionActions(s)
            assertEquals(SessionAction.RENAME, actions.first())
            assertEquals(SessionAction.DELETE, actions.last())
            assertEquals(actions.size, actions.distinct().size)
        }
    }

    @Test
    fun `every action has a label`() {
        for (action in SessionAction.entries) {
            assertTrue(action.name, sessionActionLabel(action).isNotBlank())
        }
    }

    /* ---------------- Ziel (Fly / Coolify / Heim-PC) ---------------- */

    @Test
    fun `target badge labels fly and the home pc, docker stays quiet`() {
        assertEquals("Fly", sessionTargetLabel(SessionTarget.FLY))
        assertEquals("PC", sessionTargetLabel(SessionTarget.LINK))
        // Docker ist der langjaehrige Standard — kein Badge (derselbe
        // Grundsatz wie beim Netzwerk-Chip: nur die Abweichung zeigt sich).
        assertNull(sessionTargetLabel(SessionTarget.DOCKER))
    }

    @Test
    fun `an old linked row without target resolves to the home pc`() {
        // Alter Server: linked ohne target => Heim-PC, alles andere => Docker.
        assertEquals(SessionTarget.LINK, session(linked = true).effectiveTarget())
        assertEquals(SessionTarget.DOCKER, session().effectiveTarget())
        // Neuer Server: das Ziel steht explizit da.
        assertEquals(SessionTarget.FLY, session(target = SessionTarget.FLY).effectiveTarget())
        assertEquals(SessionTarget.LINK, session(target = SessionTarget.LINK).effectiveTarget())
        assertEquals(SessionTarget.DOCKER, session(target = SessionTarget.DOCKER).effectiveTarget())
    }

    @Test
    fun `a stopped fly session is paused, a stopped link session says host offline`() {
        // Fly: 'stopped' heisst die Machine ist gestoppt — pausiert und per
        // Fortsetzen wieder anzuschubsen (gleiche Copy wie im Menue).
        assertEquals("Pausiert", sessionStatusLabel(session(target = SessionTarget.FLY, status = SessionStatus.STOPPED, linked = true)))
        // Heim-PC: der Agenten-Host ist nur gerade nicht verbunden.
        assertEquals("Host offline", sessionStatusLabel(session(linked = true, status = SessionStatus.STOPPED)))
        assertEquals("Host offline", sessionStatusLabel(session(target = SessionTarget.LINK, status = SessionStatus.STOPPED, linked = true)))
        // Docker behaelt den gewohnten Text.
        assertEquals("Gestoppt", sessionStatusLabel(session(status = SessionStatus.STOPPED)))
    }

    @Test
    fun `action notes name the machine for fly and stay honest for the home pc`() {
        val fly = session(target = SessionTarget.FLY)
        assertEquals(
            "Stoppt die Machine in der Cloud; Fortsetzen startet sie neu",
            sessionActionNote(SessionAction.STOP, fly),
        )
        // Fortsetzen einer gestoppten Fly-Machine startet der Server selbst —
        // der Vorbehalt gilt nur dem Heim-PC.
        assertNull(sessionActionNote(SessionAction.RESUME, fly))
        assertEquals(
            "Klappt erst, wenn der Agenten-Host wieder verbunden ist",
            sessionActionNote(SessionAction.RESUME, session(linked = true)),
        )
        // Docker bleibt beim Container-Wortlaut.
        assertEquals(
            "Der Container wird beendet; Fortsetzen startet ihn neu",
            sessionActionNote(SessionAction.STOP, session()),
        )
    }

    /* ---------------- Diff-Aktionsleiste (Fund: Diff-Screen ohne Handlung) ---------------- */

    @Test
    fun `the diff offers push only with changes, a live session and not in yolo`() {
        // Der Fund: Pushen lag nur im Overflow-Menü eines anderen Screens.
        // Die Aktionsleiste im Diff bietet es unter denselben Bedingungen wie
        // das Kontextmenü — plus, dass überhaupt etwas geändert wurde.
        assertTrue(diffPushAvailable(session(status = SessionStatus.IDLE), hasChanges = true))
        assertTrue(diffPushAvailable(session(status = SessionStatus.RUNNING), hasChanges = true))
        // Keine Änderungen -> nichts zu pushen.
        assertFalse(diffPushAvailable(session(status = SessionStatus.IDLE), hasChanges = false))
        // Yolo pusht selbst.
        assertFalse(diffPushAvailable(session(mode = AgentMode.YOLO), hasChanges = true))
        // Kein lebender Container.
        assertFalse(diffPushAvailable(session(status = SessionStatus.STOPPED), hasChanges = true))
        assertFalse(diffPushAvailable(session(status = SessionStatus.CREATING), hasChanges = true))
        // Ohne Session gibt es nichts anzubieten.
        assertFalse(diffPushAvailable(null, hasChanges = true))
    }

    /* ---------------- Ein Stop-Konzept (Fund: zwei Stop-Konzepte) ---------------- */

    @Test
    fun `the composer button stops the running turn, otherwise sends`() {
        // Der Fund: zwei benachbarte Stop-Aktionen. Der Turn-Abbruch wandert in
        // den Composer-Knopf — läuft ein Auftrag, ist er Stop; wartet ein Prompt
        // auf Bestätigung, dreht er; sonst sendet er. Busy hat Vorrang.
        assertEquals(ComposerButton.STOP, composerButton(busy = true, sending = false))
        assertEquals(ComposerButton.STOP, composerButton(busy = true, sending = true))
        assertEquals(ComposerButton.SENDING, composerButton(busy = false, sending = true))
        assertEquals(ComposerButton.SEND, composerButton(busy = false, sending = false))
    }

    @Test
    fun `the delete confirmation names the session and what is lost`() {
        val text = deleteConfirmText(session(title = "Login-Bug"))
        assertTrue(text.contains("Login-Bug"))
        assertTrue(text.contains("Verlauf"))
        assertTrue(text.contains("Arbeitsstand"))
    }
}
