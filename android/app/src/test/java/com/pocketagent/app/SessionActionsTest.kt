package com.pocketagent.app

import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.SessionInfo
import com.pocketagent.app.data.SessionStatus
import com.pocketagent.app.ui.screens.SessionAction
import com.pocketagent.app.ui.screens.activeSessions
import com.pocketagent.app.ui.screens.archiveDoneLabel
import com.pocketagent.app.ui.screens.archiveSwipeArchives
import com.pocketagent.app.ui.screens.archiveSwipeLabel
import com.pocketagent.app.ui.screens.archivedSessions
import com.pocketagent.app.ui.screens.deleteConfirmText
import com.pocketagent.app.ui.screens.sessionActionLabel
import com.pocketagent.app.ui.screens.sessionActions
import com.pocketagent.app.ui.screens.sessionDisplayName
import com.pocketagent.app.ui.screens.sessionSubtitle
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
    ) = SessionInfo(
        id = id,
        repoId = "r1",
        repoFullName = repo,
        adapter = "claude",
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

    @Test
    fun `the delete confirmation names the session and what is lost`() {
        val text = deleteConfirmText(session(title = "Login-Bug"))
        assertTrue(text.contains("Login-Bug"))
        assertTrue(text.contains("Verlauf"))
        assertTrue(text.contains("Arbeitsstand"))
    }
}
