package com.gamelle.gamelle_chat

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * La tablette en jumelage s'annonce sur le Wi-Fi.
 * La tablette principale la cherche, et reconnaît aussi une caméra ONVIF.
 */
object PairingNsd {
    private const val TYPE = "_gamellecam._tcp."
    private const val PORT = 3000
    private val main = Handler(Looper.getMainLooper())
    private val nearby = ConcurrentHashMap<String, Nearby>()
    private var nsd: NsdManager? = null
    private var regListener: NsdManager.RegistrationListener? = null
    private var discListener: NsdManager.DiscoveryListener? = null
    private var lock: WifiManager.MulticastLock? = null
    private var browsing = false
    private var resolving = false
    private var probing = false
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    @Volatile private var probeStop = false

    data class Nearby(
        val kind: String,
        val name: String,
        val host: String,
        val port: Int,
    )

    fun deviceLabel(context: Context): String {
        val global = Settings.Global.getString(context.contentResolver, "device_name")
        val secure = Settings.Secure.getString(context.contentResolver, "bluetooth_name")
        val raw = global?.trim().orEmpty().ifEmpty { secure?.trim().orEmpty() }.ifEmpty { Build.MODEL ?: "" }
        return clean(raw).ifEmpty { "Caméra" }
    }

    fun advertise(activity: Activity, rawName: String) {
        ensurePermission(activity)
        val name = clean(rawName).ifEmpty { "Caméra" }
        main.post { register(activity.applicationContext, name) }
    }

    fun stopAdvertise(context: Context) {
        main.post { unregister(context.applicationContext) }
    }

    fun startBrowse(activity: Activity) {
        ensurePermission(activity)
        main.post {
            acquireLock(activity.applicationContext)
            discover(activity.applicationContext)
            startProbe()
        }
    }

    fun stopBrowse(context: Context) {
        probeStop = true
        main.post {
            resolveQueue.clear()
            resolving = false
            stopDiscover(context.applicationContext)
            nearby.clear()
            releaseLock()
        }
    }

    fun snapshot(): List<Map<String, Any>> {
        return nearby.values.map {
            mapOf(
                "kind" to it.kind,
                "name" to it.name,
                "host" to it.host,
                "port" to it.port,
            )
        }
    }

    fun sendLink(host: String, port: Int, url: String): Boolean {
        val cleanHost = host.trim()
        val known = nearby.values.any { it.kind == "gamelle" && it.host == cleanHost && it.port == port }
        if (!known || !isJoinUrl(url)) return false
        val endpoint = "http://$cleanHost:$port/api/pair-join"
        val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 3000
            readTimeout = 3000
            doOutput = true
            instanceFollowRedirects = false
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        return try {
            val body = JSONObject().put("url", url).toString().toByteArray(StandardCharsets.UTF_8)
            conn.outputStream.use { it.write(body) }
            conn.responseCode in 200..299
        } catch (_: Exception) {
            false
        } finally {
            conn.disconnect()
        }
    }

    private fun ensurePermission(activity: Activity) {
        if (Build.VERSION.SDK_INT < 33) return
        val perm = Manifest.permission.NEARBY_WIFI_DEVICES
        if (activity.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) return
        activity.requestPermissions(arrayOf(perm), 4401)
    }

    private fun manager(context: Context): NsdManager {
        val have = nsd
        if (have != null) return have
        val created = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
        nsd = created
        return created
    }

    private fun register(context: Context, name: String) {
        val mgr = manager(context)
        val previous = regListener
        if (previous != null) {
            regListener = null
            try {
                mgr.unregisterService(previous)
            } catch (_: Exception) {
            }
        }
        val info = NsdServiceInfo().apply {
            serviceName = serviceTitle(name)
            serviceType = TYPE
            port = PORT
            setAttribute("name", name)
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {}
            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {}
            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
        }
        regListener = listener
        try {
            mgr.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (_: Exception) {
            regListener = null
        }
    }

    private fun unregister(context: Context) {
        val listener = regListener ?: return
        regListener = null
        try {
            manager(context).unregisterService(listener)
        } catch (_: Exception) {
        }
    }

    private fun discover(context: Context) {
        if (browsing) return
        val mgr = manager(context)
        val listener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                browsing = false
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onDiscoveryStarted(serviceType: String) {
                browsing = true
            }
            override fun onDiscoveryStopped(serviceType: String) {
                browsing = false
            }
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (serviceInfo.serviceType?.contains("gamellecam") != true) return
                resolveQueue.addLast(serviceInfo)
                pumpResolve(context)
            }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                val key = serviceInfo.serviceName ?: return
                nearby.remove(key)
            }
        }
        discListener = listener
        try {
            mgr.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (_: Exception) {
            discListener = null
        }
    }

    private fun stopDiscover(context: Context) {
        val listener = discListener ?: return
        discListener = null
        browsing = false
        try {
            manager(context).stopServiceDiscovery(listener)
        } catch (_: Exception) {
        }
    }

    private fun pumpResolve(context: Context) {
        if (resolving) return
        val found = if (resolveQueue.isEmpty()) null else resolveQueue.removeFirst()
        if (found == null) return
        resolving = true
        try {
            manager(context).resolveService(found, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    resolving = false
                    main.post { pumpResolve(context) }
                }
                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val host = hostOf(serviceInfo) ?: ""
                    if (host.isNotEmpty() && !isSelf(host)) {
                        val name = clean(attrName(serviceInfo))
                            .ifEmpty { clean(serviceInfo.serviceName?.removePrefix("Gamelle").orEmpty()) }
                            .ifEmpty { "Caméra" }
                        val key = serviceInfo.serviceName ?: host
                        nearby[key] = Nearby("gamelle", name, host, serviceInfo.port.takeIf { it > 0 } ?: PORT)
                    }
                    resolving = false
                    main.post { pumpResolve(context) }
                }
            })
        } catch (_: Exception) {
            resolving = false
        }
    }

    private fun attrName(info: NsdServiceInfo): String {
        val raw = info.attributes?.get("name") ?: return ""
        return raw.toString(StandardCharsets.UTF_8)
    }

    private fun startProbe() {
        if (probing) return
        probing = true
        probeStop = false
        Thread {
            try {
                while (!probeStop) {
                    probeOnce()
                    var waited = 0
                    while (!probeStop && waited < 8000) {
                        Thread.sleep(200)
                        waited += 200
                    }
                }
            } catch (_: Exception) {
            } finally {
                probing = false
            }
        }.apply {
            name = "gamelle-onvif"
            isDaemon = true
            start()
        }
    }

    private fun probeOnce() {
        val probe = """
            <?xml version="1.0" encoding="UTF-8"?>
            <e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
              <e:Header>
                <w:MessageID>uuid:${UUID.randomUUID()}</w:MessageID>
                <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
                <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
              </e:Header>
              <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
            </e:Envelope>
        """.trimIndent()
        val socket = DatagramSocket()
        try {
            socket.soTimeout = 1200
            socket.broadcast = true
            val bytes = probe.toByteArray(StandardCharsets.UTF_8)
            val addr = InetAddress.getByName("239.255.255.250")
            socket.send(DatagramPacket(bytes, bytes.size, addr, 3702))
            val buf = ByteArray(8192)
            val deadline = System.currentTimeMillis() + 1200
            while (System.currentTimeMillis() < deadline && !probeStop) {
                val packet = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(packet)
                } catch (_: Exception) {
                    break
                }
                val text = String(packet.data, packet.offset, packet.length, StandardCharsets.UTF_8)
                rememberCamera(text, packet.address?.hostAddress)
            }
        } catch (_: Exception) {
        } finally {
            socket.close()
        }
    }

    private fun rememberCamera(xml: String, from: String?) {
        val host = xaddrHost(xml) ?: from ?: return
        if (isSelf(host)) return
        val name = clean(decode(scopeName(xml))).ifEmpty { "Caméra Wi-Fi" }
        nearby["camera:$host"] = Nearby("camera", name, host, xaddrPort(xml))
    }

    private fun scopeName(xml: String): String {
        val scopes = Regex("""Scopes[^>]*>([^<]+)""").find(xml)?.groupValues?.get(1).orEmpty()
        val named = Regex("""/name/([^ ]+)""").find(scopes)?.groupValues?.get(1)
        if (!named.isNullOrBlank()) return named
        return Regex("""/hardware/([^ ]+)""").find(scopes)?.groupValues?.get(1).orEmpty()
    }

    private fun xaddrHost(xml: String): String? {
        val raw = Regex("""https?://([0-9.]+)(?::(\d+))?""").find(xml)?.groupValues?.get(1)
        return raw?.takeIf { it.isNotBlank() }
    }

    private fun xaddrPort(xml: String): Int {
        val port = Regex("""https?://[0-9.]+:(\d+)""").find(xml)?.groupValues?.get(1)?.toIntOrNull()
        return port?.takeIf { it in 1..65535 } ?: 80
    }

    private fun decode(raw: String): String {
        return raw.replace("%20", " ").replace("%2F", "/").replace("%2f", "/")
    }

    private fun hostOf(info: NsdServiceInfo): String? {
        if (Build.VERSION.SDK_INT >= 34) {
            val list = info.hostAddresses
            val picked = list.firstOrNull { it is Inet4Address } ?: list.firstOrNull()
            val addr = picked?.hostAddress
            if (!addr.isNullOrBlank()) return addr
        }
        return info.host?.hostAddress
    }

    private fun isSelf(host: String): Boolean {
        val want = host.trim().removePrefix("[").removeSuffix("]")
        if (want == "127.0.0.1" || want == "::1") return true
        return try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return false
            while (ifaces.hasMoreElements()) {
                val addrs = ifaces.nextElement().inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement().hostAddress ?: continue
                    if (addr.removePrefix("[").removeSuffix("]") == want) return true
                }
            }
            false
        } catch (_: Exception) {
            false
        }
    }

    private fun isJoinUrl(raw: String): Boolean {
        return try {
            val u = URL(raw.trim())
            val proto = u.protocol
            (proto == "http" || proto == "https") &&
                u.path.endsWith("/satellite.html") &&
                (u.query ?: "").contains("k=")
        } catch (_: Exception) {
            false
        }
    }

    private fun serviceTitle(name: String): String {
        val body = name.replace(Regex("[^\\p{L}\\p{N} -]"), "").trim().take(28).ifEmpty { "Camera" }
        return "Gamelle $body"
    }

    private fun clean(raw: String): String {
        return raw.replace(Regex("\\s+"), " ").trim().take(24)
    }

    private fun acquireLock(context: Context) {
        if (lock?.isHeld == true) return
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        lock = wifi.createMulticastLock("gamelle-pair").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseLock() {
        try {
            if (lock?.isHeld == true) lock?.release()
        } catch (_: Exception) {
        }
        lock = null
    }
}
