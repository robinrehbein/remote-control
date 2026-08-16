package com.pocketagent.app

import com.pocketagent.app.data.Backoff
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackoffTest {

    @Test
    fun `doubles and then stops at the cap`() {
        assertEquals(1, Backoff.secondsFor(0))
        assertEquals(2, Backoff.secondsFor(1))
        assertEquals(4, Backoff.secondsFor(2))
        assertEquals(8, Backoff.secondsFor(3))
        // Ab hier greift die Deckelung — nie wieder die alte Minute
        assertEquals(Backoff.DEFAULT_MAX_SEC, Backoff.secondsFor(4))
        assertEquals(Backoff.DEFAULT_MAX_SEC, Backoff.secondsFor(9))
        assertEquals(Backoff.DEFAULT_MAX_SEC, Backoff.secondsFor(1000))
        assertTrue(Backoff.DEFAULT_MAX_SEC in 10..15)
    }

    @Test
    fun `never waits less than a second and survives odd input`() {
        assertEquals(1, Backoff.secondsFor(-5))
        assertEquals(1, Backoff.secondsFor(0, maxSec = 0))
        assertEquals(3, Backoff.secondsFor(7, maxSec = 3))
    }

    @Test
    fun `walks the series and resets after a successful connect`() {
        val backoff = Backoff()
        assertEquals(listOf(1, 2, 4, 8), List(4) { backoff.nextSeconds() })
        assertEquals(4, backoff.attempts)

        // Verbindung steht wieder -> der nächste Abbruch beginnt bei vorn,
        // statt den Nutzer für einen alten Ausfall bezahlen zu lassen.
        backoff.reset()
        assertEquals(0, backoff.attempts)
        assertEquals(1, backoff.nextSeconds())
        assertEquals(2, backoff.nextSeconds())
    }

    @Test
    fun `stays at the cap without overflowing`() {
        val backoff = Backoff()
        repeat(40) { backoff.nextSeconds() }
        assertEquals(Backoff.DEFAULT_MAX_SEC, backoff.nextSeconds())
    }
}
