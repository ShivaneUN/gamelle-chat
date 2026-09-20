package com.gamelle.gamelle_chat

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.Process as AndroidProcess
import android.graphics.Color
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
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
    private var githubProgressSink: EventChannel.EventSink? = null
    private var webEventSink: EventChannel.EventSink? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val urlPattern = Pattern.compile(
        "https://(?!api\\.)[a-z0-9-]+\\.trycloudflare\\.com",
        Pattern.CASE_INSENSITIVE,
    )
    private val namedReadyPattern = Pattern.compile(
        "Registered tunnel connection",
        Pattern.CASE_INSENSITIVE,
    )
    private var fixedPublicUrl: String? = null
    private var tunnelToken: String? = null

    private fun isAllowedPublicUrl(url: String): Boolean {
        val host = try {
            java.net.URI(url).host ?: ""
        } catch (_: Exception) {
            return false
        }.lowercase()
        if (host.isEmpty() || host == "api.trycloudflare.com") return false
        if (host == "localhost" || host == "127.0.0.1" || host == "::1") return false
        if (host == "juvana.cc" || host.endsWith(".juvana.cc")) return true
        return host.endsWith(".trycloudflare.com")
    }

    private fun readAssetText(name: String): String? {
        return try {
            assets.open(name).bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            null
        }
    }

    private fun loadTunnelSettings() {
        fixedPublicUrl = null
        tunnelToken = null
        try {
            val cfgRaw = readAssetText("tunnel.config.json")
            if (!cfgRaw.isNullOrBlank()) {
                val urlMatch = Regex("\"publicUrl\"\\s*:\\s*\"([^\"]+)\"").find(cfgRaw)
                val url = urlMatch?.groupValues?.getOrNull(1)?.trim()?.trimEnd('/')
                if (!url.isNullOrBlank() && isAllowedPublicUrl(url)) {
                    fixedPublicUrl = url
                }
            }
        } catch (_: Exception) {
        }
        try {
            val tokenRaw = readAssetText("tunnel.token") ?: ""
            val token = tokenRaw
                .lineSequence()
                .map { it.trim() }
                .firstOrNull { it.isNotEmpty() && !it.startsWith("#") && !it.contains("REMPLACE_MOI") }
            if (!token.isNullOrBlank()) tunnelToken = token
        } catch (_: Exception) {
        }
    }

    private fun useNamedTunnel(): Boolean {
        return !tunnelToken.isNullOrBlank() && !fixedPublicUrl.isNullOrBlank()
    }

    private var pendingApkPath: String? = null
    private var pendingApkTag: String? = null

    private val protectWebViews = object : Runnable {
        override fun run() {
            protectAllWebViews(window?.decorView)
            keepWebViewsAlive()
            mainHandler.postDelayed(this, 800)
        }
    }

    private var screenForcedOff = false
    private var userRequestedBackground = false
    private var blackOverlay: View? = null

    private fun canPostNotifications(): Boolean {
        if (Build.VERSION.SDK_INT < 33) return true
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun startKeepAliveSafe(camera: Boolean = KeepAliveService.cameraWanted) {
        if (!canPostNotifications()) return
        KeepAliveService.start(this, camera)
    }

    private fun bringToFrontIfNeeded() {
        if (userRequestedBackground || isFinishing) return
        if (hasWindowFocus()) return
        try {
            val launch = Intent(this, MainActivity::class.java)
            launch.addFlags(
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_NEW_TASK,
            )
            startActivity(launch)
        } catch (_: Exception) {
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger

        EventChannel(messenger, "gamelle/cloudflare_events").setStreamHandler(
            object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    eventSink = events
                    lastPublicUrl?.let { url ->
                        events?.success(mapOf("type" to "url", "value" to url))
                    } ?: lastTunnelError?.let { err ->
                        events?.success(mapOf("type" to "error", "value" to err))
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
                        val bin = File(applicationInfo.nativeLibraryDir, "libcloudflared.so")
                        if (!bin.exists()) {
                            val msg = "cloudflared introuvable — réinstalle l’APK (Mises à jour)."
                            lastTunnelError = msg
                            emit("error", msg)
                            result.error("TUNNEL", msg, null)
                            return@setMethodCallHandler
                        }
                        shuttingDown = false
                        startTunnel()
                        result.success(true)
                    } catch (e: Exception) {
                        val msg = e.message ?: "tunnel"
                        lastTunnelError = msg
                        emit("error", msg)
                        result.error("TUNNEL", msg, null)
                    }
                }
                "stop" -> {
                    stopTunnel()
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }

        EventChannel(messenger, "gamelle/github_progress").setStreamHandler(
            object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    githubProgressSink = events
                }

                override fun onCancel(arguments: Any?) {
                    githubProgressSink = null
                }
            },
        )

        MethodChannel(messenger, "gamelle/github").setMethodCallHandler { call, result ->
            when (call.method) {
                "status", "apply" -> {
                    val installed = try {
                        packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()
                    } catch (_: Exception) {
                        ""
                    }
                    Thread {
                        val map: Map<String, Any?> = try {
                            if (call.method == "status") {
                                GithubUpdate.status(filesDir, installed)
                            } else {
                                if (!canInstallPackages()) {
                                    mainHandler.post { requestInstallPermission() }
                                    mapOf(
                                        "ok" to false,
                                        "available" to true,
                                        "restart" to false,
                                        "install" to false,
                                        "message" to "Autorise « Installer des apps inconnues » pour Gamelle Chat, puis réessaie.",
                                    )
                                } else {
                                    GithubUpdate.apply(filesDir, installed) { pct, label ->
                                        mainHandler.post {
                                            githubProgressSink?.success(
                                                mapOf("pct" to pct, "label" to label),
                                            )
                                        }
                                    }
                                }
                            }
                        } catch (e: Exception) {
                            mapOf(
                                "ok" to false,
                                "available" to false,
                                "restart" to false,
                                "install" to false,
                                "message" to (e.message ?: "Erreur GitHub"),
                            )
                        }
                        mainHandler.post {
                            var out = map
                            val path = map["apkPath"] as? String
                            val tag = (map["tag"] as? String).orEmpty()
                            if (map["install"] == true && !path.isNullOrBlank()) {
                                try {
                                    launchApkInstall(path, tag)
                                } catch (e: Exception) {
                                    out = map + mapOf(
                                        "ok" to false,
                                        "install" to false,
                                        "message" to ("Install APK échouée: " + (e.message ?: e.toString())),
                                    )
                                }
                            }
                            result.success(out)
                        }
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
                    startKeepAliveSafe(cam)
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
                    userRequestedBackground = true
                    startKeepAliveSafe(KeepAliveService.cameraWanted)
                    keepWebViewsAlive()
                    moveTaskToBack(true)
                    result.success(true)
                }
                "bringToFront" -> {
                    if (!userRequestedBackground) bringToFrontIfNeeded()
                    result.success(true)
                }
                "restartApp" -> {
                    result.success(true)
                    mainHandler.postDelayed({ relaunchApp() }, 350)
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
            userRequestedBackground = true
            startKeepAliveSafe(true)
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
            userRequestedBackground = true
            startKeepAliveSafe(true)
            keepWebViewsAlive()
            moveTaskToBack(true)
        }
    }

    override fun onResume() {
        super.onResume()
        userRequestedBackground = false
        keepWebViewsAlive()
        if (screenForcedOff) applyScreen(false)
        val pending = pendingApkPath
        if (!pending.isNullOrBlank() && canInstallPackages()) {
            try {
                launchApkInstall(pending, pendingApkTag.orEmpty())
            } catch (_: Exception) {
            }
        }
    }

    /** Vrai écran noir (style Android Hub) : overlay noir, caméra/serveur restent actifs. */
    private fun ensureBlackOverlay(): View {
        blackOverlay?.let { return it }
        val overlay = View(this).apply {
            setBackgroundColor(Color.BLACK)
            isClickable = true
            isFocusable = true
            elevation = 100_000f
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setOnTouchListener { _, event ->
                if (event.action == MotionEvent.ACTION_DOWN) {
                    applyScreen(true)
                }
                true
            }
        }
        val content = findViewById<ViewGroup>(android.R.id.content)
        content.addView(overlay)
        blackOverlay = overlay
        return overlay
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
            // Garde l’écran alimenté pour que la caméra / WebView restent vivants.
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            val lp = window.attributes
            lp.screenBrightness = if (on) {
                WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
            } else {
                0f
            }
            window.attributes = lp
        } catch (_: Exception) {
        }
        try {
            val overlay = ensureBlackOverlay()
            if (on) {
                overlay.visibility = View.GONE
            } else {
                overlay.visibility = View.VISIBLE
                overlay.bringToFront()
            }
        } catch (_: Exception) {
        }
        keepWebViewsAlive()
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
        startKeepAliveSafe()
        keepWebViewsAlive()
        mainHandler.post { keepWebViewsAlive() }
    }

    override fun onStop() {
        super.onStop()
        startKeepAliveSafe()
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
    @Volatile private var lastTunnelError: String? = null

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
        loadTunnelSettings()
        val bin = File(applicationInfo.nativeLibraryDir, "libcloudflared.so")
        if (!bin.exists()) {
            val msg = "cloudflared introuvable (${bin.absolutePath})"
            lastTunnelError = msg
            emit("error", msg)
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
                lastTunnelError = lastErr
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
        val named = useNamedTunnel()
        if (named) {
            val url = fixedPublicUrl!!
            gotTunnelUrl = true
            lastPublicUrl = url
            lastTunnelError = null
            persistPublicUrl(url)
            emit("url", url)
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
        if (named) {
            args.add("run")
            args.add("--token")
            args.add(tunnelToken!!)
        } else {
            if (!useHttp) args.add("--no-tls-verify")
            args.add("--url")
            args.add(if (useHttp) "http://127.0.0.1:3001" else "https://127.0.0.1:3000")
        }
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
                    if (named) {
                        if (namedReadyPattern.matcher(text).find()) {
                            val url = fixedPublicUrl!!
                            gotTunnelUrl = true
                            lastPublicUrl = url
                            lastTunnelError = null
                            persistPublicUrl(url)
                            emit("url", url)
                        }
                    } else {
                        val matcher = urlPattern.matcher(text)
                        if (matcher.find()) {
                            val url = matcher.group()
                            if (isAllowedPublicUrl(url)) {
                                gotTunnelUrl = true
                                lastPublicUrl = url
                                lastTunnelError = null
                                persistPublicUrl(url)
                                emit("url", url)
                            }
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

    private fun canInstallPackages(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    private fun requestInstallPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:$packageName"),
        )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
    }

    private fun launchApkInstall(path: String, tag: String = "") {
        val file = File(path)
        if (!file.exists() || file.length() < 1_000_000L) {
            throw IllegalStateException("Fichier APK manquant")
        }
        pendingApkPath = path
        if (tag.isNotBlank()) pendingApkTag = tag
        if (!canInstallPackages()) {
            requestInstallPermission()
            return
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP,
            )
            putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
            putExtra(Intent.EXTRA_RETURN_RESULT, true)
        }
        // Donne la lecture URI au package installer système (Xiaomi / Android 8+).
        try {
            grantUriPermission(
                "com.android.packageinstaller",
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
        } catch (_: Exception) {
        }
        try {
            grantUriPermission(
                "com.google.android.packageinstaller",
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
        } catch (_: Exception) {
        }
        startActivity(intent)
        if (tag.isNotBlank()) {
            GithubUpdate.markInstalled(filesDir, tag)
        }
        pendingApkPath = null
        pendingApkTag = null
    }

    private fun relaunchApp() {
        try {
            stopTunnel()
            stopNodeService()
        } catch (_: Exception) {
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        launch.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP,
        )
        startActivity(launch)
        try {
            finishAffinity()
        } catch (_: Exception) {
        }
        AndroidProcess.killProcess(AndroidProcess.myPid())
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
