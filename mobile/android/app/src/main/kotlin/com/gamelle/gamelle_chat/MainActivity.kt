package com.gamelle.gamelle_chat

import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.Process as AndroidProcess
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugins.webviewflutter.WebViewFlutterAndroidExternalApi
import org.binbard.node_flutter.NodeService
import java.io.File
import java.util.regex.Pattern

class MainActivity : FlutterActivity() {
    companion object {
        @Volatile private var running: MainActivity? = null
        @Volatile var lastPublicUrl: String? = null

        fun shutdownIfRunning() {
            running?.shutdownAll()
        }
    }

    private var tunnel: java.lang.Process? = null
    private var eventSink: EventChannel.EventSink? = null
    private var webEventSink: EventChannel.EventSink? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val urlPattern = Pattern.compile("https://(?!api\\.)[a-z0-9-]+\\.trycloudflare\\.com", Pattern.CASE_INSENSITIVE)

    private val protectWebViews = object : Runnable {
        override fun run() {
            protectAllWebViews(window?.decorView)
            keepWebViewsAlive()
            mainHandler.postDelayed(this, 800)
        }
    }

    private fun isQuickTunnelUrl(url: String): Boolean {
        val host = try {
            java.net.URI(url).host ?: ""
        } catch (_: Exception) {
            return false
        }
        return host.endsWith(".trycloudflare.com") && host != "api.trycloudflare.com"
    }

    private var screenForcedOff = false

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger

        EventChannel(messenger, "gamelle/cloudflare_events").setStreamHandler(
            object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    eventSink = events
                    lastPublicUrl?.let { url ->
                        events?.success(mapOf("type" to "url", "value" to url))
                    }
                }

                override fun onCancel(arguments: Any?) {
                    eventSink = null
                }
            },
        )

        EventChannel(messenger, "gamelle/webview_events").setStreamHandler(
            object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    webEventSink = events
                }

                override fun onCancel(arguments: Any?) {
                    webEventSink = null
                }
            },
        )

        MethodChannel(messenger, "gamelle/cloudflare").setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    try {
                        startTunnel()
                        result.success(true)
                    } catch (e: Exception) {
                        result.error("TUNNEL", e.message, null)
                    }
                }
                "stop" -> {
                    stopTunnel()
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }

        MethodChannel(messenger, "gamelle/github").setMethodCallHandler { call, result ->
            when (call.method) {
                "status", "apply" -> {
                    val token = (call.arguments as? Map<*, *>)?.get("token") as? String
                    Thread {
                        val map = try {
                            if (call.method == "status") {
                                GithubUpdate.status(filesDir, token)
                            } else {
                                GithubUpdate.apply(filesDir, token)
                            }
                        } catch (e: Exception) {
                            mapOf(
                                "ok" to false,
                                "available" to false,
                                "restart" to false,
                                "message" to (e.message ?: "Erreur GitHub"),
                            )
                        }
                        mainHandler.post { result.success(map) }
                    }.start()
                }
                "applyOverlay" -> {
                    try {
                        GithubUpdate.applyStoredOverlay(filesDir)
                        result.success(true)
                    } catch (e: Exception) {
                        result.error("OTA", e.message, null)
                    }
                }
                "stopNode" -> {
                    stopNodeService()
                    result.success(true)
                }
                "saveToken" -> {
                    GithubUpdate.saveToken(filesDir, call.arguments as? String ?: "")
                    result.success(true)
                }
                "loadToken" -> result.success(GithubUpdate.readToken(filesDir))
                else -> result.notImplemented()
            }
        }

        MethodChannel(messenger, "gamelle/lifecycle").setMethodCallHandler { call, result ->
            when (call.method) {
                "shutdown" -> {
                    shutdownAll()
                    result.success(true)
                }
                "keepAlive" -> {
                    val cam = when (val args = call.arguments) {
                        is Boolean -> args
                        is Map<*, *> -> args["camera"] == true
                        else -> true
                    }
                    KeepAliveService.start(this, cam)
                    keepWebViewsAlive()
                    result.success(true)
                }
                "screenOn" -> {
                    applyScreen(true)
                    result.success(true)
                }
                "screenOff" -> {
                    applyScreen(false)
                    result.success(true)
                }
                "alarmShow" -> {
                    applyScreen(true)
                    AlarmNotifier.show(this, call.arguments as? String ?: "")
                    result.success(true)
                }
                "alarmHide" -> {
                    AlarmNotifier.hide(this)
                    result.success(true)
                }
                "background" -> {
                    KeepAliveService.start(this, KeepAliveService.cameraWanted)
                    keepWebViewsAlive()
                    moveTaskToBack(true)
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }

        MethodChannel(messenger, "gamelle/webview").setMethodCallHandler { call, result ->
            when (call.method) {
                "protect" -> {
                    val id = (call.arguments as? Number)?.toLong()
                    if (id != null) {
                        protectWebView(WebViewFlutterAndroidExternalApi.getWebView(flutterEngine, id))
                    }
                    protectAllWebViews(window?.decorView)
                    requestPlaybackAudio()
                    result.success(true)
                }
                "audioFocus" -> {
                    requestPlaybackAudio()
                    result.success(true)
                }
                "destroy" -> {
                    val id = (call.arguments as? Number)?.toLong()
                    if (id != null) {
                        destroyWebView(WebViewFlutterAndroidExternalApi.getWebView(flutterEngine, id))
                    }
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }

        mainHandler.post(protectWebViews)
        running = this
        if (intent?.getStringExtra("screen") == "on") applyScreen(true)
        if (intent?.getBooleanExtra("alarm", false) == true) applyScreen(true)
        if (intent?.getBooleanExtra("stayBackground", false) == true) {
            KeepAliveService.start(this, true)
            keepWebViewsAlive()
            moveTaskToBack(true)
        }
        try {
            startService(Intent(this, TaskRemovedWatcher::class.java))
        } catch (_: Exception) {
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getStringExtra("screen") == "on") applyScreen(true)
        if (intent.getStringExtra("screen") == "off") applyScreen(false)
        if (intent.getBooleanExtra("alarm", false)) applyScreen(true)
        if (intent.getBooleanExtra("stayBackground", false) == true) {
            KeepAliveService.start(this, true)
            keepWebViewsAlive()
            moveTaskToBack(true)
        }
    }

    override fun onResume() {
        super.onResume()
        keepWebViewsAlive()
        if (screenForcedOff) applyScreen(false)
    }

    private fun applyScreen(on: Boolean) {
        screenForcedOff = !on
        if (on) {
            try {
                val launch = Intent(this, MainActivity::class.java)
                launch.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP,
                )
                startActivity(launch)
            } catch (_: Exception) {
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true)
                setTurnScreenOn(on)
            }
        } catch (_: Exception) {
        }
        try {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            val lp = window.attributes
            lp.screenBrightness = if (on) {
                WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
            } else {
                0.01f
            }
            window.attributes = lp
        } catch (_: Exception) {
        }
        if (!on) return
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            @Suppress("DEPRECATION")
            val wl = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "gamelle:screen",
            )
            wl.acquire(4000)
            wl.release()
        } catch (_: Exception) {
        }
        keepWebViewsAlive()
    }

    private fun protectAllWebViews(root: View?) {
        if (root == null) return
        if (root is WebView) {
            protectWebView(root)
        }
        if (root is ViewGroup) {
            for (i in 0 until root.childCount) {
                protectAllWebViews(root.getChildAt(i))
            }
        }
    }

    private fun protectWebView(webView: WebView?) {
        if (webView == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val current = webView.webViewClient
        if (current is SafeWebViewClient) return
        webView.webViewClient = SafeWebViewClient(current, ::onRendererGone)
        try {
            WebView::class.java
                .getMethod("setAudioMuted", java.lang.Boolean.TYPE)
                .invoke(webView, false)
        } catch (_: Exception) {
        }
        try {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)
        } catch (_: Exception) {
        }
        try {
            webView.onResume()
        } catch (_: Exception) {
        }
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                webView.settings.isAlgorithmicDarkeningAllowed = false
            } else if (Build.VERSION.SDK_INT >= 29) {
                @Suppress("DEPRECATION")
                webView.settings.forceDark = WebSettings.FORCE_DARK_OFF
            }
        } catch (_: Exception) {
        }
    }

    private fun keepWebViewsAlive() {
        resumeAllWebViews(window?.decorView)
    }

    private fun resumeAllWebViews(root: View?) {
        if (root == null) return
        if (root is WebView) {
            try {
                root.onResume()
            } catch (_: Exception) {
            }
            try {
                root.resumeTimers()
            } catch (_: Exception) {
            }
            try {
                WebView::class.java
                    .getMethod("setAudioMuted", java.lang.Boolean.TYPE)
                    .invoke(root, false)
            } catch (_: Exception) {
            }
        }
        if (root is ViewGroup) {
            for (i in 0 until root.childCount) {
                resumeAllWebViews(root.getChildAt(i))
            }
        }
    }

    override fun onPause() {
        super.onPause()
        KeepAliveService.start(this)
        keepWebViewsAlive()
        mainHandler.post { keepWebViewsAlive() }
    }

    override fun onStop() {
        super.onStop()
        KeepAliveService.start(this)
        keepWebViewsAlive()
        mainHandler.post { keepWebViewsAlive() }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        keepWebViewsAlive()
    }

    private fun requestPlaybackAudio() {
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_NORMAL
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build(),
                    )
                    .build()
                am.requestAudioFocus(req)
            } else {
                @Suppress("DEPRECATION")
                am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
            }
        } catch (_: Exception) {
        }
    }

    private fun onRendererGone(view: WebView) {
        mainHandler.post {
            try {
                (view.parent as? ViewGroup)?.removeView(view)
            } catch (_: Exception) {
            }
            try {
                view.destroy()
            } catch (_: Exception) {
            }
            webEventSink?.success(mapOf("type" to "rendererGone"))
        }
    }

    private fun destroyWebView(webView: WebView?) {
        if (webView == null) return
        try {
            webView.stopLoading()
            webView.loadUrl("about:blank")
        } catch (_: Exception) {
        }
        try {
            (webView.parent as? ViewGroup)?.removeView(webView)
        } catch (_: Exception) {
        }
        try {
            webView.destroy()
        } catch (_: Exception) {
        }
    }

    private var tunnelThread: Thread? = null
    @Volatile private var gotTunnelUrl = false
    @Volatile private var shuttingDown = false

    private fun isJavaProcessAlive(proc: java.lang.Process?): Boolean {
        if (proc == null) return false
        return try {
            proc.exitValue()
            false
        } catch (_: IllegalThreadStateException) {
            true
        }
    }

    private fun startTunnel() {
        if (isJavaProcessAlive(tunnel)) return
        if (tunnelThread?.isAlive == true) return
        tunnelThread = Thread { runTunnelLoop() }
        tunnelThread?.start()
    }

    private fun runTunnelLoop() {
        val bin = File(applicationInfo.nativeLibraryDir, "libcloudflared.so")
        if (!bin.exists()) {
            emit("error", "cloudflared introuvable (${bin.absolutePath})")
            return
        }
        try {
            bin.setReadable(true, false)
            bin.setExecutable(true, false)
        } catch (_: Exception) {
        }

        val home = File(filesDir, "cloudflared-home")
        home.mkdirs()
        File(home, ".cloudflared").mkdirs()
        try {
            File(home, "resolv.conf").writeText("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
        } catch (_: Exception) {
        }
        try {
            File(File(filesDir, "gamelle-persist/data"), "public-url.json").delete()
        } catch (_: Exception) {
        }
        val logFile = File(filesDir, "cloudflared.log")
        try {
            logFile.writeText("")
        } catch (_: Exception) {
        }

        val protocols = listOf("http2", "quic", "auto")
        var lastErr = "cloudflared n’a pas démarré"
        var i = 0
        while (!shuttingDown) {
            gotTunnelUrl = false
            val protocol = protocols[i % protocols.size]
            lastErr = runTunnelOnce(bin, home, logFile, protocol)
            if (shuttingDown) return
            if (!gotTunnelUrl) {
                emit("error", lastErr)
            }
            i++
            try {
                Thread.sleep(if (gotTunnelUrl) 1500L else 2500L)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    private fun isPortOpen(port: Int): Boolean {
        return try {
            java.net.Socket().use { s ->
                s.connect(java.net.InetSocketAddress("127.0.0.1", port), 600)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun waitForOrigin() {
        val deadline = System.currentTimeMillis() + 45000
        while (System.currentTimeMillis() < deadline && !shuttingDown) {
            if (isPortOpen(3001) || isPortOpen(3000)) return
            try {
                Thread.sleep(400)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    private fun runTunnelOnce(bin: File, home: File, logFile: File, protocol: String): String {
        waitForOrigin()
        val useHttp = isPortOpen(3001)
        if (!useHttp && !isPortOpen(3000)) {
            return "serveur local pas prêt (ports 3000/3001)"
        }
        val args = mutableListOf(
            bin.absolutePath,
            "tunnel",
            "--no-autoupdate",
            "--protocol",
            protocol,
            "--edge-ip-version",
            "4",
        )
        if (!useHttp) args.add("--no-tls-verify")
        args.add("--url")
        args.add(if (useHttp) "http://127.0.0.1:3001" else "https://127.0.0.1:3000")
        val builder = ProcessBuilder(args)
        builder.redirectErrorStream(true)
        builder.directory(home)
        try {
            val env = builder.environment()
            env["HOME"] = home.absolutePath
            env["TMPDIR"] = cacheDir.absolutePath
            env["TMP"] = cacheDir.absolutePath
            env["TEMP"] = cacheDir.absolutePath
            env["XDG_CONFIG_HOME"] = home.absolutePath
            env["XDG_CACHE_HOME"] = cacheDir.absolutePath
            env["NO_COLOR"] = "1"
            env["GODEBUG"] = "netdns=cgo"
        } catch (_: Exception) {
        }

        val proc = try {
            builder.start()
        } catch (e: Exception) {
            return e.message ?: "impossible de lancer cloudflared"
        }
        tunnel = proc
        val lines = mutableListOf<String>()
        try {
            proc.inputStream.bufferedReader().use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    val text = line!!
                    lines.add(text)
                    try {
                        logFile.appendText(text + "\n")
                    } catch (_: Exception) {
                    }
                    val matcher = urlPattern.matcher(text)
                    if (matcher.find()) {
                        val url = matcher.group()
                        if (isQuickTunnelUrl(url)) {
                            gotTunnelUrl = true
                            lastPublicUrl = url
                            persistPublicUrl(url)
                            emit("url", url)
                        }
                    }
                }
            }
            val code = proc.waitFor()
            if (gotTunnelUrl) {
                return "tunnel coupé (code $code)"
            }
            return summarizeCloudflaredError(lines, code)
        } catch (e: Exception) {
            return e.message ?: "lecture cloudflared"
        }
    }

    private fun summarizeCloudflaredError(lines: List<String>, code: Int): String {
        val useful = lines.filter { line ->
            val t = line.lowercase()
            (t.contains("err ") || t.contains(" failed") || t.contains("error") ||
                t.contains("denied") || t.contains("refused") || t.contains("unable")) &&
                !t.contains("thank you")
        }
        val picked = if (useful.isNotEmpty()) useful.takeLast(2) else lines.takeLast(2)
        val msg = picked.joinToString(" | ").replace(Regex("\\s+"), " ").trim().take(240)
        if (msg.isEmpty()) return "cloudflared s’est arrêté (code $code)"
        return msg
    }

    private fun persistPublicUrl(url: String) {
        try {
            val dir = File(filesDir, "gamelle-persist/data")
            dir.mkdirs()
            File(dir, "public-url.json").writeText("{\"url\":\"" + url + "\"}")
        } catch (_: Exception) {
        }
    }

    private fun emit(type: String, value: String) {
        mainHandler.post {
            eventSink?.success(mapOf("type" to type, "value" to value))
        }
    }

    private fun stopTunnel() {
        try {
            tunnelThread?.interrupt()
        } catch (_: Exception) {
        }
        tunnelThread = null
        val proc = tunnel
        tunnel = null
        if (proc == null) return
        try {
            proc.destroy()
        } catch (_: Exception) {
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                proc.destroyForcibly()
            }
        } catch (_: Exception) {
        }
    }

    private fun stopNodeService() {
        try {
            val stop = Intent(this, NodeService::class.java)
            stop.putExtra("action", "stop")
            startService(stop)
            stopService(stop)
        } catch (_: Exception) {
        }
    }

    private fun shutdownAll() {
        if (shuttingDown) return
        shuttingDown = true
        mainHandler.removeCallbacks(protectWebViews)
        KeepAliveService.stop(this)
        stopTunnel()
        stopNodeService()
        try {
            finishAndRemoveTask()
        } catch (_: Exception) {
            try {
                finish()
            } catch (_: Exception) {
            }
        }
        AndroidProcess.killProcess(AndroidProcess.myPid())
    }

    override fun onDestroy() {
        if (running === this) running = null
        mainHandler.removeCallbacks(protectWebViews)
        super.onDestroy()
    }
}

/** Le swipe dans les récents ne doit plus tuer serveur + caméra. */
class TaskRemovedWatcher : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        KeepAliveService.start(this, true)
    }
}
