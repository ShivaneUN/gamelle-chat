package com.gamelle.gamelle_chat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object AlarmNotifier {
    // v2 : canal sans ringtone (le WebView joue son1→son2 en boucle).
    const val CHANNEL = "gamelle_alarm_silent_v2"
    private const val LEGACY_CHANNEL = "gamelle_alarm"
    const val NOTIF_ID = 77
    const val ACTION_STOP = "com.gamelle.gamelle_chat.STOP_ALARM"

    fun show(ctx: Context, payload: String) {
        val app = ctx.applicationContext
        var text = "C’est l’heure !"
        try {
            val json = JSONObject(payload)
            val msg = json.optString("message").trim()
            if (msg.isNotEmpty()) text = msg
        } catch (_: Exception) {
            if (payload.isNotBlank() && !payload.startsWith("{")) text = payload
        }
        ensureChannel(app)
        val open = Intent(app, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            putExtra("alarm", true)
            putExtra("screen", "on")
        }
        val openPi = PendingIntent.getActivity(
            app,
            1,
            open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = Intent(app, AlarmStopReceiver::class.java).setAction(ACTION_STOP)
        val stopPi = PendingIntent.getBroadcast(
            app,
            2,
            stop,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(app, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(app)
        }
        val notif = builder
            .setContentTitle("🔔 Alarme Gamelle")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentIntent(openPi)
            .setFullScreenIntent(openPi, true)
            .setOngoing(true)
            .setAutoCancel(false)
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_pause, "Arrêter", stopPi)
            .build()
        val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, notif)
    }

    fun hide(ctx: Context) {
        val nm = ctx.applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(NOTIF_ID)
    }

    private fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        try { nm.deleteNotificationChannel(LEGACY_CHANNEL) } catch (_: Exception) {}
        val ch = NotificationChannel(CHANNEL, "Alarme Gamelle", NotificationManager.IMPORTANCE_HIGH)
        ch.description = "Alarme repas / horaires (son via l’appli)"
        ch.enableVibration(true)
        ch.enableLights(true)
        ch.setBypassDnd(true)
        ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        // Son = WebView (séquence son1→son2). Pas de ringtone système qui vole le focus.
        ch.setSound(null, null)
        nm.createNotificationChannel(ch)
    }
}

class AlarmStopReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        AlarmNotifier.hide(context)
        val pending = goAsync()
        Thread {
            try {
                val url = URL("http://127.0.0.1:3001/api/alarm-stop")
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 2500
                conn.readTimeout = 2500
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write("{}".toByteArray()) }
                conn.inputStream.use { it.readBytes() }
                conn.disconnect()
            } catch (_: Exception) {
            } finally {
                Handler(Looper.getMainLooper()).post { pending.finish() }
            }
        }.start()
    }
}
