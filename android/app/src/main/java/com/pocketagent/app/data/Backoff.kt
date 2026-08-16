package com.pocketagent.app.data

import kotlin.math.min

/**
 * Wartezeit zwischen zwei Verbindungsversuchen.
 *
 * Bewusst kurz gedeckelt: ein Handy wechselt ständig zwischen WLAN und
 * Mobilfunk, und eine Minute Wartezeit fühlt sich wie „kaputt“ an. Die
 * Reihe verdoppelt sich (1, 2, 4, 8 …) und läuft gegen [maxSec]; nach einem
 * erfolgreichen Verbindungsaufbau beginnt sie über [reset] wieder bei 1s.
 *
 * Reine Rechnung ohne Zeitquelle — damit testbar.
 */
class Backoff(private val maxSec: Int = DEFAULT_MAX_SEC) {

    private var attempt = 0

    /** Wie viele Versuche seit dem letzten [reset] gezählt wurden. */
    val attempts: Int get() = attempt

    /** Wartezeit für den nächsten Versuch und einen Schritt weiterzählen. */
    fun nextSeconds(): Int = secondsFor(attempt++, maxSec)

    /** Nach erfolgreichem Verbindungsaufbau: die Reihe beginnt von vorn. */
    fun reset() {
        attempt = 0
    }

    companion object {
        /**
         * Obergrenze der Wartezeit. 12s ist lang genug, um einen dauerhaft
         * toten Server nicht zu hämmern, und kurz genug, dass niemand nach
         * einem Netzwechsel spürbar wartet.
         */
        const val DEFAULT_MAX_SEC = 12

        /** Wartezeit des [attempt]-ten Versuchs (0-basiert), gedeckelt. */
        fun secondsFor(attempt: Int, maxSec: Int = DEFAULT_MAX_SEC): Int {
            val steps = attempt.coerceIn(0, 16)
            val exp = if (steps >= 5) maxSec else 1 shl steps
            return min(maxSec, exp).coerceAtLeast(1)
        }
    }
}
