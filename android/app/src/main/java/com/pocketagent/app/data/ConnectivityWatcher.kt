package com.pocketagent.app.data

import android.app.Activity
import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Bundle

/**
 * Zwei Auslöser für „jetzt sofort neu verbinden“, beide aus dem Framework:
 *
 *  1. Android meldet ein nutzbares Netz (`registerNetworkCallback`) — nach
 *     einem Wechsel zwischen WLAN und Mobilfunk ist das der Moment, in dem
 *     es wieder losgehen kann.
 *  2. Die App kommt in den Vordergrund — nach Bildschirm aus / App-Wechsel
 *     ist die Verbindung oft still gestorben.
 *
 * Der Netz-Callback hängt am Vordergrund der App: er wird beim ersten
 * sichtbaren Activity registriert und beim letzten wieder abgemeldet. Im
 * Hintergrund lauscht die App also nicht mit — dort weckt Push, und beim
 * Zurückkommen greift ohnehin (2).
 */
class ConnectivityWatcher(
    private val app: Application,
    private val onNetworkAvailable: () -> Unit,
    private val onNetworkLost: () -> Unit,
    private val onForeground: () -> Unit,
) : Application.ActivityLifecycleCallbacks {

    private val connectivity: ConnectivityManager? =
        app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    /** Wie viele Activities gerade sichtbar sind — 0 heißt Hintergrund. */
    private var startedActivities = 0

    private var registered = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            onNetworkAvailable()
        }

        override fun onLost(network: Network) {
            // Nur melden, wenn danach wirklich gar nichts mehr da ist —
            // beim WLAN→Mobilfunk-Wechsel kommt onLost für das alte Netz,
            // während das neue schon trägt.
            if (!hasNetwork()) onNetworkLost()
        }
    }

    fun attach() {
        app.registerActivityLifecycleCallbacks(this)
    }

    /** Gibt es gerade irgendein Netz mit Internet-Fähigkeit? */
    fun hasNetwork(): Boolean {
        val cm = connectivity ?: return true
        val active = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(active) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun register() {
        val cm = connectivity ?: return
        if (registered) return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching { cm.registerNetworkCallback(request, callback) }
            .onSuccess { registered = true }
    }

    private fun unregister() {
        val cm = connectivity ?: return
        if (!registered) return
        // Doppeltes Abmelden wirft — deshalb erst das Flag, dann der Aufruf.
        registered = false
        runCatching { cm.unregisterNetworkCallback(callback) }
    }

    /* -------- ActivityLifecycleCallbacks: nur Start/Stop zählen -------- */

    override fun onActivityStarted(activity: Activity) {
        startedActivities += 1
        if (startedActivities == 1) {
            register()
            onForeground()
        }
    }

    override fun onActivityStopped(activity: Activity) {
        startedActivities = (startedActivities - 1).coerceAtLeast(0)
        if (startedActivities == 0) unregister()
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
