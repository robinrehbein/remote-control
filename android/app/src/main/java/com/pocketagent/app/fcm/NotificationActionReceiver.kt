package com.pocketagent.app.fcm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.PermissionDecision
import kotlinx.coroutines.launch

/**
 * Empfängt "Erlauben"/"Ablehnen" von den Aktionsbuttons einer Approval-
 * Notification (s. `PocketFcmService.actionButton`) — die Fernbedienung soll
 * hier direkt handlungsfähig sein, ohne dass die App erst geöffnet werden muss
 * (ENTWICKLUNGSPLAN.md W3.3).
 *
 * `goAsync()` hält den Prozess am Leben, bis die Antwort raus ist. Läuft die
 * App gerade im Hintergrund oder wurde sie vom System getötet, startet der
 * eingehende Broadcast den Prozess ohnehin neu (derselbe Cold-Start-Pfad wie
 * ein Notification-Tap) — [PocketAgentApp.onCreate] läuft dabei VOR diesem
 * Receiver, weil beides im selben, frisch gestarteten Prozess passiert. Der
 * dort schon angestoßene WS-Verbindungsaufbau läuft also bereits;
 * `respondToPermission` wartet nur noch die Restzeit ab, statt bei null
 * anzufangen. Reicht die Zeit nicht (kein Netz, Server nicht erreichbar),
 * bleibt der dokumentierte Fallback: die Notification zeigt „nicht
 * zugestellt“ und öffnet beim nächsten Tap die App in der Session, wo der
 * Nutzer manuell entscheidet.
 */
class NotificationActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return
        val permissionId = intent.getStringExtra(EXTRA_PERMISSION_ID) ?: return
        val decision = intent.getStringExtra(EXTRA_DECISION)
            ?.let { PermissionDecision.fromRaw(it) } ?: return
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, sessionId.hashCode())

        val app = context.applicationContext as? PocketAgentApp ?: return
        val appContext = context.applicationContext

        PocketFcmService.showPending(appContext, sessionId, notificationId)

        // Läuft im app-weiten Scope, nicht in einem eigenen — der überlebt
        // (anders als ein an die Activity/den Receiver gebundener Scope) den
        // Rückkehrpunkt von onReceive; goAsync().finish() ist das eigentliche
        // Signal an das System, dass die Arbeit fertig ist.
        val pending = goAsync()
        app.appScope.launch {
            try {
                val delivered = app.container.repository.respondToPermission(sessionId, permissionId, decision)
                if (delivered) {
                    PocketFcmService.showDecided(appContext, sessionId, notificationId, decision)
                } else {
                    PocketFcmService.showDeliveryFailed(appContext, sessionId, notificationId)
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_PERMISSION_ID = "permissionId"
        const val EXTRA_DECISION = "decision"
        const val EXTRA_NOTIFICATION_ID = "notificationId"
    }
}
