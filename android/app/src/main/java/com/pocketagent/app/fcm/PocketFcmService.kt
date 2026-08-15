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

class PocketFcmService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        (applicationContext as? PocketAgentApp)?.container?.repository?.onFcmToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val sessionId = data["sessionId"] ?: return
        val title = data["title"] ?: message.notification?.title ?: getString(R.string.app_name)
        val body = data["body"] ?: message.notification?.body ?: ""

        showNotification(sessionId, title, body)
    }

    private fun showNotification(sessionId: String, title: String, body: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.getNotificationChannel(CHANNEL_ID) ?: run {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_sessions),
                NotificationManager.IMPORTANCE_HIGH,
            )
            manager.createNotificationChannel(channel)
        }

        val deepLink = Uri.parse("pocketagent://session/$sessionId")
        val intent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = deepLink
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            sessionId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        manager.notify(sessionId.hashCode(), notification)
    }

    companion object {
        const val CHANNEL_ID = "sessions"
    }
}
