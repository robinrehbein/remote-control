package com.pocketagent.app.fcm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.pocketagent.app.MainActivity
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.R
import com.pocketagent.app.data.PermissionDecision

class PocketFcmService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        (applicationContext as? PocketAgentApp)?.container?.repository?.onFcmToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val sessionId = data["sessionId"] ?: return
        val title = data["title"] ?: message.notification?.title ?: getString(R.string.app_name)
        val body = data["body"] ?: message.notification?.body ?: ""
        // Nur bei eventType=="permission.request" gesetzt (server/src/fcm.ts) —
        // erst das macht die Notification handlungsfähig (Fund W3.3: Erlauben/
        // Ablehnen direkt aus der Notification statt nur Tap-zum-Öffnen).
        val permissionId = data["permissionId"]?.takeIf { data["eventType"] == "permission.request" }

        // Eindeutig pro Push statt (wie zuvor) pro Session: sonst überschreibt
        // jede neue Notification die vorherige derselben Session, statt sich
        // dazuzugesellen — Gruppierung (Fund W3.3, Punkt 3) braucht mehrere
        // gleichzeitig sichtbare IDs. message.messageId ist FCMs eigene,
        // garantiert eindeutige Zustell-Id; ohne sie (Testpfad) reicht ein
        // Zeitstempel.
        val notificationId = notificationId(sessionId, message.messageId ?: permissionId)

        showNotification(sessionId, title, body, notificationId, permissionId)
    }

    private fun showNotification(
        sessionId: String,
        title: String,
        body: String,
        notificationId: Int,
        permissionId: String?,
    ) {
        ensureChannel(this)
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(sessionPendingIntent(this, sessionId))
            // Gruppierung pro Session: mehrere Pushes derselben Session
            // stapeln sich in der Statusleiste zusammen, statt bei mehreren
            // aktiven Sessions unsortiert durcheinanderzuliegen.
            .setGroup(groupKey(sessionId))

        if (permissionId != null) {
            builder.addAction(
                actionButton(sessionId, permissionId, PermissionDecision.ONCE, notificationId),
            )
            builder.addAction(
                actionButton(sessionId, permissionId, PermissionDecision.REJECT, notificationId),
            )
        }

        manager.notify(notificationId, builder.build())
        showGroupSummary(this, manager, sessionId)
    }

    private fun actionButton(
        sessionId: String,
        permissionId: String,
        decision: PermissionDecision,
        notificationId: Int,
    ): NotificationCompat.Action {
        val allow = decision == PermissionDecision.ONCE
        val icon = if (allow) R.drawable.ic_action_allow else R.drawable.ic_action_deny
        val label = getString(if (allow) R.string.notification_action_allow else R.string.notification_action_deny)

        val intent = Intent(this, NotificationActionReceiver::class.java).apply {
            // Eigene action-Strings statt nur des Extra-Inhalts: PendingIntent
            // dedupliziert nach Intent#filterEquals (Component + action/data/
            // categories/type — Extras zählen NICHT). Ohne diese Unterscheidung
            // würden "Erlauben" und "Ablehnen" derselben Anfrage denselben
            // PendingIntent teilen und sich gegenseitig überschreiben.
            action = "${packageName}.action.PERMISSION_${decision.name}.$permissionId"
            putExtra(NotificationActionReceiver.EXTRA_SESSION_ID, sessionId)
            putExtra(NotificationActionReceiver.EXTRA_PERMISSION_ID, permissionId)
            putExtra(NotificationActionReceiver.EXTRA_DECISION, decision.name)
            putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION_ID, notificationId)
        }
        val pending = PendingIntent.getBroadcast(
            this,
            notificationId * 4 + decision.ordinal,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action.Builder(icon, label, pending).build()
    }

    companion object {
        const val CHANNEL_ID = "sessions"
        private const val GROUP_PREFIX = "session_"

        /**
         * Eindeutig pro Push statt (wie vor W3.3) pro Session: sonst
         * überschreibt jede neue Notification die vorherige derselben Session,
         * statt sich dazuzugesellen — Gruppierung braucht mehrere gleichzeitig
         * sichtbare IDs. Reine Funktion, damit sie ohne Android-Framework
         * testbar ist (kein Mocking-Framework im Projekt verfügbar).
         * [disambiguator] ist FCMs eigene, garantiert eindeutige Zustell-Id
         * (`RemoteMessage.messageId`), ersatzweise die permissionId oder —
         * ganz ohne beides — ein Zeitstempel.
         */
        fun notificationId(sessionId: String, disambiguator: String?): Int =
            "$sessionId:${disambiguator ?: System.nanoTime()}".hashCode()

        /**
         * Wird sowohl hier (Nachricht kam bei laufendem Prozess an) als auch
         * eager in PocketAgentApp.onCreate aufgerufen: der Kanal muss schon
         * existieren, bevor die erste Push überhaupt eintrifft — sonst würde
         * das manifestierte `default_notification_channel_id` (für den Fall,
         * dass FCM je an onMessageReceived vorbei selbst rendert) auf einen
         * nicht existierenden Kanal zeigen, und Android 8+ verwirft die
         * Notification dann kommentarlos.
         */
        fun ensureChannel(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.getNotificationChannel(CHANNEL_ID) ?: run {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.notification_channel_sessions),
                    NotificationManager.IMPORTANCE_HIGH,
                )
                manager.createNotificationChannel(channel)
            }
        }

        fun groupKey(sessionId: String) = "$GROUP_PREFIX$sessionId"

        /**
         * Öffnet direkt die betroffene Session (Deep-Link aus Welle 1,
         * MainActivity.handleDeepLink) statt der Sessionliste — sowohl für den
         * Notification-Body-Tap als auch für die Gruppen-Summary und die
         * Folge-Notifications aus [NotificationActionReceiver].
         */
        fun sessionPendingIntent(context: Context, sessionId: String): PendingIntent {
            val deepLink = Uri.parse("pocketagent://session/$sessionId")
            val intent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                data = deepLink
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
            return PendingIntent.getActivity(
                context,
                sessionId.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        /**
         * Eine stumme Zusammenfassungs-Notification pro Session-Gruppe. Ab
         * Android N bündelt das System gleich-gruppierte Notifications zwar
         * auch ohne sie, aber erst eine explizite Summary gibt der Gruppe
         * einen eigenen, stabilen Eintrag statt eines generischen "N weitere".
         */
        fun showGroupSummary(context: Context, manager: NotificationManager, sessionId: String) {
            val summary = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.app_name))
                .setContentText(context.getString(R.string.notification_group_summary))
                .setGroup(groupKey(sessionId))
                .setGroupSummary(true)
                .setAutoCancel(true)
                .setContentIntent(sessionPendingIntent(context, sessionId))
                .build()
            manager.notify(groupKey(sessionId).hashCode(), summary)
        }

        /**
         * Sofort-Feedback auf den Button-Tap, bevor die Antwort raus ist: ohne
         * das wirkt die Notification bis zu mehrere Sekunden lang unverändert
         * (AppRepository.respondToPermission baut die Verbindung ggf. erst
         * auf), als sei der Tap ins Leere gelaufen.
         */
        fun showPending(context: Context, sessionId: String, notificationId: Int) {
            updateResult(
                context,
                sessionId,
                notificationId,
                context.getString(R.string.notification_decision_pending),
                autoCancel = false,
            )
        }

        /** Antwort ist raus (`session.permission` erfolgreich gesendet) — Buttons weichen dem Ergebnis. */
        fun showDecided(context: Context, sessionId: String, notificationId: Int, decision: PermissionDecision) {
            val text = context.getString(
                if (decision == PermissionDecision.ONCE) R.string.notification_decision_allowed
                else R.string.notification_decision_denied,
            )
            updateResult(context, sessionId, notificationId, text, autoCancel = true)
        }

        /**
         * Innerhalb des Zeitbudgets kam keine WS-Verbindung zustande (kein
         * Netz, Server nicht erreichbar) — Tap öffnet jetzt die App in der
         * Session, wo der Nutzer manuell entscheidet, statt die Antwort
         * stillschweigend zu verlieren (s. PR-Hinweis: bevorzugter Pfad ist
         * die direkte Zustellung, das hier ist der dokumentierte Fallback).
         */
        fun showDeliveryFailed(context: Context, sessionId: String, notificationId: Int) {
            updateResult(
                context,
                sessionId,
                notificationId,
                context.getString(R.string.notification_decision_failed),
                autoCancel = true,
            )
        }

        private fun updateResult(
            context: Context,
            sessionId: String,
            notificationId: Int,
            text: String,
            autoCancel: Boolean,
        ) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.app_name))
                .setContentText(text)
                .setAutoCancel(autoCancel)
                .setContentIntent(sessionPendingIntent(context, sessionId))
                .setGroup(groupKey(sessionId))
                // Keine Aktionsbuttons mehr — die Entscheidung ist gefallen
                // (oder der Notification-Pfad ist gescheitert, dann führt nur
                // noch der App-Tap weiter).
                .build()
            manager.notify(notificationId, notification)
        }
    }
}
