package com.pocketagent.app.connection

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.pocketagent.app.MainActivity
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.R
import com.pocketagent.app.data.WsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Was der Dienst für einen Verbindungszustand tun soll: einen Text in der
 * Status-Notification zeigen — oder sich beenden, weil es nichts mehr gibt,
 * was sich zu halten lohnt. Als eigene Abbildung statt `when` im Service,
 * damit sie ohne Android-Framework testbar ist (kein Mocking-Framework im
 * Projekt verfügbar, gleiche Begründung wie [WsClient]s `isUnauthorizedClose`).
 */
sealed interface ConnectionServiceAction {
    data class Announce(val text: String) : ConnectionServiceAction

    /** Kein Zustand, den eine gehaltene Verbindung sinnvoll anzeigen kann. */
    data object Stop : ConnectionServiceAction
}

/**
 * Übersetzt einen Verbindungszustand in die Dienst-Aktion.
 *
 * [WsClient.ConnState.Unauthorized] (Server hat endgültig abgelehnt — es
 * gibt ohnehin keinen automatischen Reconnect) beendet den Dienst: eine
 * Dauer-Notification ohne Verbindung wäre ein leeres Versprechen. Nicht
 * gekoppelt/abgemeldet wird nicht hier erkannt, sondern über den
 * tokenStore.setup-Collector im Dienst — [WsClient.ConnState.Idle] ist
 * bewusst kein Stop: Nach einem Sticky-Neustart des Prozesses ist der
 * Zustand erst mal Idle, bis repository.start()s asynchroner Collector
 * gekoppelt und connect() aufgerufen hat; ein Stop hier würde den Dienst
 * in diesem Fenster sofort wieder einfahren.
 */
fun connectionServiceAction(state: WsClient.ConnState): ConnectionServiceAction = when (state) {
    is WsClient.ConnState.Connected -> ConnectionServiceAction.Announce(
        if (state.serverVersion != null) {
            "Mit dem Server verbunden (v${state.serverVersion})"
        } else {
            "Mit dem Server verbunden"
        },
    )

    WsClient.ConnState.Connecting, WsClient.ConnState.Idle ->
        ConnectionServiceAction.Announce("Verbindung wird aufgebaut …")

    is WsClient.ConnState.Waiting -> ConnectionServiceAction.Announce(
        "Keine Verbindung – neuer Versuch in ${state.retryInSec} s",
    )

    is WsClient.ConnState.Disconnected -> ConnectionServiceAction.Announce(state.reason)

    WsClient.ConnState.Unauthorized -> ConnectionServiceAction.Stop
}

/**
 * Hält die WebSocket-Verbindung zum Orchestrator am Leben, während die App
 * im Hintergrund ist. Ohne diesen Dienst räumt Android den Prozess nach
 * kurzer Zeit ab (Doze/App Standby) — die Verbindung stirbt still, und beim
 * nächsten Öffnen heisst es wieder: verbinden, Verlauf laden, warten.
 *
 * Der Dienst läuft im selben Prozess wie [com.pocketagent.app.PocketAgentApp]
 * und hält selbst keine Verbindung — der dortige [WsClient] tut das längst.
 * Was er beiträgt, ist die Erhöhung der Prozesswichtigkeit über eine
 * stille Dauer-Notification (Foreground-Service) und das Offenhalten der
 * Netz-Callbacks des ConnectivityWatchers, damit ein Netzwechsel auch im
 * Hintergrund sofort neu verbindet statt auf den Backoff zu warten.
 *
 * Gestartet wird er nur aus Vordergrund-Momenten (App-Start, Rückkehr in
 * den Vordergrund, Pairing, Einstellungs-Wechsel) — Android 12+ verbietet
 * Apps im Hintergrund das Starten von Foreground-Services. Sobald er läuft,
 * überlebt er das Verlassen der App; abgemeldet oder vom Server abgelehnt
 * beendet er sich selbst.
 *
 * `specialUse` statt `dataSync`: Letzteres ist ab Android 15 auf 6 Stunden
 * gedeckelt — für eine Verbindung, die über Nacht halten soll, die falsche
 * Kategorie. Der deklarierte Subtyp (Manifest-Property) benennt den Zweck.
 */
class ConnectionService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        running = true
        ensureChannel(this)
        // Sofort in den Vordergrund: nach startForegroundService() gibt es
        // dafür ein Zeitfenster, sonst gilt der Dienst als hängend.
        promote(buildNotification(initialStatusText(this)))

        val container = (applicationContext as PocketAgentApp).container

        // Netz-Callbacks auch im Hintergrund behalten — sonst merkt die App
        // einen WLAN→Mobilfunk-Wechsel erst beim nächsten Vordergrund-Wechsel.
        container.connectivity.retain()

        // Die Notification ist die ehrliche Statuszeile der Verbindung: sie
        // folgt jedem Zustandswechsel. Der Waiting-Countdown tickt sekündlich,
        // aber ein manager.notify() pro Sekunde ist verschwenderisch (Fund) —
        // deshalb während des Countdowns nur in ~5-s-Schritten aktualisieren,
        // ansonsten bei jedem echten Zustandswechsel. Dedup über einen Schlüssel,
        // der die Sekunden auf 5er-Blöcke bündelt.
        scope.launch {
            var lastKey: String? = null
            container.repository.connState.collect { state ->
                when (val action = connectionServiceAction(state)) {
                    is ConnectionServiceAction.Announce -> {
                        val key = when (state) {
                            is WsClient.ConnState.Waiting -> "waiting:${state.retryInSec / 5}"
                            else -> action.text
                        }
                        if (key != lastKey) {
                            lastKey = key
                            notify(action.text)
                        }
                    }
                    ConnectionServiceAction.Stop -> stopSelf()
                }
            }
        }

        // Abgemeldet (Token gelöscht): nichts mehr zu halten. setup ist ein
        // StateFlow, der aktuelle Wert kommt also sofort — ein Start vor dem
        // Pairing beendet sich damit von selbst.
        scope.launch {
            container.tokenStore.setup.collect { setup ->
                if (setup == null) stopSelf()
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        running = false
        runCatching {
            (applicationContext as? PocketAgentApp)?.container?.connectivity?.release()
        }
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun promote(notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun notify(text: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): android.app.Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.connection_notification_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(contentIntent)
            // Dauerhafte Status-Notification, kein Dialog mit dem Nutzer:
            // weg wischen darf sie nicht können (sonst stirbt die Verbindung
            // mit ihr), und einmal angelegt darf sie nicht bei jedem
            // Zustandswechsel Vibration/Timeout-Rauschen machen.
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "connection"
        const val NOTIFICATION_ID = 1001

        /** Läuft der Dienst gerade? Billiger Check als ActivityManager-Fragen. */
        @Volatile
        private var running = false

        fun isRunning(): Boolean = running

        /**
         * Startet den Dienst, wenn die Einstellung an und das Gerät gekoppelt
         * ist — sonst wäre die Notification ein Versprechen ohne Verbindung.
         * Nur aus Vordergrund-Kontexten aufrufen (Android-12+-Regel); ob der
         * Aufrufer ein Activity- oder Application-Kontext ist, ist egal —
         * gestartet wird immer mit dem Application-Kontext, damit kein
         * zerstörtes Activity hängen bleibt.
         * runCatching gegen ForegroundServiceStartNotAllowedException: besser
         * ein verpasster Start als ein Absturz in einem Randzeitfenster.
         */
        fun startIfEligible(context: Context) {
            val appContext = context.applicationContext
            val app = appContext as? PocketAgentApp ?: return
            app.appScope.launch {
                val store = app.container.tokenStore
                if (!store.backgroundConnection.first()) return@launch
                if (store.setup.first() == null) return@launch
                if (running) return@launch
                runCatching {
                    appContext.startForegroundService(Intent(appContext, ConnectionService::class.java))
                }
            }
        }

        /** Hält den Dienst an — Einstellung aus oder Abmelden. No-op, wenn er nicht läuft. */
        fun stop(context: Context) {
            context.applicationContext.stopService(
                Intent(context.applicationContext, ConnectionService::class.java),
            )
        }

        fun ensureChannel(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.getNotificationChannel(CHANNEL_ID) ?: run {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        context.getString(R.string.connection_channel_name),
                        NotificationManager.IMPORTANCE_LOW,
                    ),
                )
            }
        }

        /** Erste Zeile, bevor der erste Zustand da ist — nie eine leere Notification. */
        private fun initialStatusText(context: Context): String =
            context.getString(R.string.connection_notification_connecting)
    }
}
