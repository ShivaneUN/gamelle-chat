package com.gamelle.gamelle_chat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** Service avant-plan : dataSync toujours ; caméra/micro seulement si le récepteur les utilise. */
class KeepAliveService : Service() {
    companion object {
        private const val CHANNEL = "gamelle_live"
        private const val NOTIF_ID = 42
        const val EXTRA_CAMERA = "camera"

        @Volatile var cameraWanted = false
            private set

        fun start(ctx: Context, camera: Boolean = cameraWanted) {
            cameraWanted = camera || cameraWanted
            val intent = Intent(ctx, KeepAliveService::class.java)
            intent.putExtra(EXTRA_CAMERA, cameraWanted)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(intent)
                } else {
                    ctx.startService(intent)
                }
            } catch (_: Exception) {
            }
        }

        fun stop(ctx: Context) {
            cameraWanted = false
            try {
                ctx.stopService(Intent(ctx, KeepAliveService::class.java))
            } catch (_: Exception) {
            }
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gamelle:live").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.getBooleanExtra(EXTRA_CAMERA, false) == true) {
            cameraWanted = true
        }
        startAsForeground()
        return START_STICKY
    }

    private fun hasPerm(perm: String): Boolean {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
    }

    private fun startAsForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            val ch = NotificationChannel(CHANNEL, "Gamelle en direct", NotificationManager.IMPORTANCE_LOW)
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
        val launch = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_NEW_TASK,
                )
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notif = builder
            .setContentTitle("Gamelle Chat")
            .setContentText(if (cameraWanted) "Caméra et serveur actifs" else "Serveur actif")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(launch)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()

        val types = foregroundTypes()
        try {
            if (Build.VERSION.SDK_INT >= 29 && types != 0) {
                startForeground(NOTIF_ID, notif, types)
            } else {
                startForeground(NOTIF_ID, notif)
            }
        } catch (_: Exception) {
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                } else {
                    startForeground(NOTIF_ID, notif)
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun foregroundTypes(): Int {
        var types = 0
        if (Build.VERSION.SDK_INT >= 29) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        }
        if (cameraWanted && Build.VERSION.SDK_INT >= 29) {
            if (hasPerm(android.Manifest.permission.CAMERA)) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
            if (hasPerm(android.Manifest.permission.RECORD_AUDIO)) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
        }
        return types
    }

    override fun onDestroy() {
        try {
            wakeLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
        super.onDestroy()
    }
}
