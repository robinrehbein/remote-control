package com.pocketagent.app

import com.pocketagent.app.data.PermissionDecision
import com.pocketagent.app.fcm.PocketFcmService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fund W3.3: mehrere Notifications derselben Session müssen sich stapeln
 * statt sich gegenseitig zu überschreiben (wie vor diesem Paket, als
 * `sessionId.hashCode()` allein die Notification-Id war), und der
 * Aktionsbutton-Pfad muss die Entscheidung so codieren, wie der Receiver sie
 * zurückliest. Beides als reine Funktionen getestet — der Rest von
 * PocketFcmService/NotificationActionReceiver braucht echtes Android
 * (NotificationManager, PendingIntent, ...) und bleibt ungetestet wie der
 * übrige FCM-Code im Projekt.
 */
class NotificationGroupingTest {

    @Test
    fun `two pushes for the same session get different notification ids`() {
        val first = PocketFcmService.notificationId("s1", "msg-a")
        val second = PocketFcmService.notificationId("s1", "msg-b")

        assertNotEquals(first, second)
    }

    @Test
    fun `the same push id is stable across recomputation`() {
        assertEquals(
            PocketFcmService.notificationId("s1", "msg-a"),
            PocketFcmService.notificationId("s1", "msg-a"),
        )
    }

    @Test
    fun `different sessions never collide even with the same disambiguator`() {
        val a = PocketFcmService.notificationId("session-a", "msg-1")
        val b = PocketFcmService.notificationId("session-b", "msg-1")

        assertNotEquals(a, b)
    }

    @Test
    fun `the group key is stable per session and distinct across sessions`() {
        assertEquals(PocketFcmService.groupKey("s1"), PocketFcmService.groupKey("s1"))
        assertNotEquals(PocketFcmService.groupKey("s1"), PocketFcmService.groupKey("s2"))
    }

    /**
     * PocketFcmService.actionButton codiert die Entscheidung als
     * `decision.name` (Kotlin-Konstantenname, z.B. "ONCE") in ein Intent-
     * Extra; NotificationActionReceiver decodiert es über
     * `PermissionDecision.fromRaw`. Beide Enden müssen zusammenpassen, sonst
     * verschluckt der Receiver den Tap still (frühes `return` bei null).
     */
    @Test
    fun `every notification action decision round-trips through fromRaw`() {
        for (decision in listOf(PermissionDecision.ONCE, PermissionDecision.REJECT)) {
            assertEquals(decision, PermissionDecision.fromRaw(decision.name))
        }
    }

    @Test
    fun `allow and deny for the same permission get distinct pending-intent request codes`() {
        val notificationId = PocketFcmService.notificationId("s1", "perm-1")
        val allowCode = notificationId * 4 + PermissionDecision.ONCE.ordinal
        val denyCode = notificationId * 4 + PermissionDecision.REJECT.ordinal

        assertTrue(allowCode != denyCode)
    }
}
