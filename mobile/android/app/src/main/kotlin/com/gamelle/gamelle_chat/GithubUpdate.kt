package com.gamelle.gamelle_chat

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.zip.ZipInputStream

/**
 * Met à jour server.js + public/ depuis la dernière **release** GitHub,
 * sans jeton ni api.github.com.
 */
object GithubUpdate {
    const val OWNER = "ShivaneUN"
    const val REPO = "gamelle-chat"

    private fun tokenFile(filesDir: File) = File(filesDir, "gamelle-persist/github-token.txt")
    fun versionFile(filesDir: File) = File(filesDir, "gamelle-persist/ota/version.json")
    fun otaDir(filesDir: File) = File(filesDir, "gamelle-persist/ota")
    fun nodeDir(filesDir: File) = File(filesDir, "nodejs-project")

    private fun forgetStoredToken(filesDir: File) {
        val f = tokenFile(filesDir)
        if (f.exists()) f.delete()
    }

    fun localTag(filesDir: File, installedVersion: String): String {
        // Source de vérité = version installée de l’APK. version.json est un cache,
        // jamais plus “avancé” que le package (évite un faux “déjà à jour”).
        val installed = installedVersion.trim()
        val f = versionFile(filesDir)
        if (f.exists()) {
            try {
                val stored = JSONObject(f.readText(StandardCharsets.UTF_8)).optString("tag")
                if (stored.isNotBlank()) {
                    if (installed.isBlank()) return stored
                    // Si le fichier OTA dit plus récent que le package → install ratée : on ignore.
                    if (isNewer(stored, installed)) return installed
                    return stored
                }
            } catch (_: Exception) {
            }
        }
        return installed
    }

    fun markInstalled(filesDir: File, tag: String) {
        if (tag.isBlank()) return
        versionFile(filesDir).parentFile?.mkdirs()
        versionFile(filesDir).writeText(
            JSONObject()
                .put("tag", tag)
                .put("at", System.currentTimeMillis())
                .toString(2),
            StandardCharsets.UTF_8,
        )
    }

    fun applyStoredOverlay(filesDir: File, installedVersion: String = "") {
        val ota = otaDir(filesDir)
        if (!ota.exists()) return
        val installed = installedVersion.trim()
        var otaTag = ""
        try {
            val vf = versionFile(filesDir)
            if (vf.exists()) {
                otaTag = JSONObject(vf.readText(StandardCharsets.UTF_8)).optString("tag").orEmpty()
            }
        } catch (_: Exception) {
        }
        // Si l’APK installé est déjà ≥ overlay OTA, on jette l’overlay (évite de downgrader server.js).
        if (installed.isNotBlank() && otaTag.isNotBlank() && !isNewer(otaTag, installed)) {
            try {
                ota.deleteRecursively()
            } catch (_: Exception) {
            }
            return
        }
        if (installed.isNotBlank() && otaTag.isBlank()) {
            // Overlay sans version connue + APK frais → trop risqué, on ignore.
            try {
                ota.deleteRecursively()
            } catch (_: Exception) {
            }
            return
        }
        copyWanted(ota, nodeDir(filesDir))
    }

    fun status(filesDir: File, installedVersion: String): Map<String, Any?> {
        forgetStoredToken(filesDir)
        val local = localTag(filesDir, installedVersion)
        return try {
            val remote = fetchLatestTag()
            val available = isNewer(remote, local)
            mapOf(
                "ok" to true,
                "git" to true,
                "available" to available,
                "local" to display(local),
                "remote" to display(remote),
                "message" to when {
                    remote.isBlank() -> "Impossible de lire les releases GitHub."
                    local.isBlank() -> "Mise à jour GitHub prête (${display(remote)})."
                    available -> "Mise à jour disponible (${display(local)} → ${display(remote)}). Installation APK."
                    isNewer(local, remote) ->
                        "Installé ${display(local)} (plus récent que GitHub ${display(remote)})."
                    else -> "Déjà à jour — installé ${display(local)}."
                },
            )
        } catch (e: Exception) {
            mapOf(
                "ok" to false,
                "git" to true,
                "available" to false,
                "local" to display(local),
                "message" to githubError(e),
            )
        }
    }

    fun apkFile(filesDir: File) = File(filesDir, "gamelle-persist/GamelleChat.apk")

    fun apply(
        filesDir: File,
        installedVersion: String,
        onProgress: (Double, String) -> Unit = { _, _ -> },
    ): Map<String, Any?> {
        forgetStoredToken(filesDir)
        return try {
            onProgress(0.04, "Recherche de la release…")
            val remote = fetchLatestTag()
            if (remote.isBlank()) {
                return mapOf("ok" to false, "restart" to false, "install" to false, "message" to "Release GitHub introuvable.")
            }
            val local = localTag(filesDir, installedVersion)
            if (!isNewer(remote, local)) {
                onProgress(1.0, "Déjà à jour (${display(remote)}).")
                return mapOf(
                    "ok" to true,
                    "restart" to false,
                    "install" to false,
                    "message" to "Déjà à jour (${display(remote)}).",
                    "available" to false,
                )
            }

            // Gros changements : télécharge l’APK de la release et remplace l’app
            // (même applicationId → pas une 2ᵉ app). Les données restent dans gamelle-persist/.
            // Ne pas écrire version.json avant l’install réussie (sinon “déjà à jour” alors que l’APK n’est pas installé).
            onProgress(0.08, "Téléchargement de l’APK ${display(remote)}…")
            val apk = apkFile(filesDir)
            if (apk.exists()) apk.delete()
            apk.parentFile?.mkdirs()
            val apkUrl = fetchApkUrl(remote)
            downloadToFile(apkUrl, apk, onProgress)
            if (!apk.exists() || apk.length() < 1_000_000L) {
                return mapOf(
                    "ok" to false,
                    "restart" to false,
                    "install" to false,
                    "message" to "APK introuvable ou incomplet dans la release GitHub.",
                )
            }

            onProgress(1.0, "Installation de la mise à jour…")
            mapOf(
                "ok" to true,
                "restart" to false,
                "install" to true,
                "apkPath" to apk.absolutePath,
                "tag" to remote,
                "available" to false,
                "remote" to display(remote),
                "message" to "Installation de ${display(remote)}… Confirme sur l’écran suivant.",
            )
        } catch (e: Exception) {
            mapOf(
                "ok" to false,
                "restart" to false,
                "install" to false,
                "message" to githubError(e),
            )
        }
    }

    private fun wanted(path: String): Boolean {
        if (path.contains("..")) return false
        if (path == "server.js" || path == "update-service.js") return true
        return path.startsWith("public/") && !path.endsWith("/")
    }

    private fun copyWanted(srcRoot: File, destRoot: File) {
        destRoot.mkdirs()
        srcRoot.walkTopDown().forEach { src ->
            if (!src.isFile) return@forEach
            val rel = src.relativeTo(srcRoot).path.replace('\\', '/')
            if (!wanted(rel) && rel != "version.json") return@forEach
            if (rel == "version.json") return@forEach
            val dest = File(destRoot, rel)
            dest.parentFile?.mkdirs()
            src.copyTo(dest, overwrite = true)
        }
    }

    private fun fetchLatestTag(): String {
        val loc = peekLocation("https://github.com/$OWNER/$REPO/releases/latest")
        val fromLoc = loc.substringAfter("/releases/tag/", "").substringBefore("/").substringBefore("?")
        if (fromLoc.isNotBlank()) return fromLoc.trim()
        val xml = String(
            httpGet("https://github.com/$OWNER/$REPO/releases.atom"),
            StandardCharsets.UTF_8,
        )
        val fromId = Regex("""/releases/tag/([^<"\s]+)""")
            .find(xml)
            ?.groupValues
            ?.get(1)
            .orEmpty()
        if (fromId.isNotBlank()) return fromId.trim()
        val titles = Regex("""<title>\s*(?:<!\[CDATA\[)?(.*?)(?:]]>)?\s*</title>""", RegexOption.DOT_MATCHES_ALL)
            .findAll(xml)
            .map { it.groupValues[1].trim() }
            .toList()
        val title = titles.drop(1).firstOrNull().orEmpty()
        if (title.isNotBlank()) return title
        throw RuntimeException("Aucune release GitHub trouvée.")
    }

    private fun fetchApkUrl(tag: String): String {
        val encoded = java.net.URLEncoder.encode(tag, "UTF-8").replace("+", "%20")
        val pages = listOf(
            "https://github.com/$OWNER/$REPO/releases/expanded_assets/$encoded",
            "https://github.com/$OWNER/$REPO/releases/tag/$encoded",
        )
        for (page in pages) {
            try {
                val html = String(httpGet(page), StandardCharsets.UTF_8)
                val rel = Regex("""(/[^"'\\s]+/releases/download/[^"'\\s]+\.apk)""")
                    .find(html)
                    ?.groupValues
                    ?.get(1)
                    .orEmpty()
                if (rel.isNotBlank()) {
                    return if (rel.startsWith("http")) rel else "https://github.com$rel"
                }
            } catch (_: Exception) {
            }
        }
        return "https://github.com/$OWNER/$REPO/releases/download/$tag/GamelleChat-${key(tag)}.apk"
    }

    private fun downloadToFile(
        url: String,
        dest: File,
        onProgress: (Double, String) -> Unit,
    ) {
        val conn = open(url, readTimeoutMs = 600_000)
        try {
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = conn.errorStream?.readBytes() ?: ByteArray(0)
                throw RuntimeException("HTTP $code ${String(err, StandardCharsets.UTF_8).take(240)}")
            }
            val length = conn.contentLengthLong
            val buf = ByteArray(64 * 1024)
            var got = 0L
            conn.inputStream.use { input ->
                dest.outputStream().use { out ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        got += n
                        val frac = if (length > 0L) (got.toDouble() / length).coerceIn(0.0, 1.0) else 0.45
                        onProgress(0.08 + 0.90 * frac, "Téléchargement de l’APK…")
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun peekLocation(url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 20000
        conn.readTimeout = 20000
        conn.instanceFollowRedirects = false
        conn.setRequestProperty("User-Agent", "GamelleChat")
        conn.setRequestProperty("Accept", "*/*")
        try {
            conn.responseCode
            return conn.getHeaderField("Location").orEmpty()
        } finally {
            conn.disconnect()
        }
    }

    private fun downloadZipWanted(
        destRoot: File,
        tag: String,
        onProgress: (Double, String) -> Unit,
    ): Int {
        val encoded = java.net.URLEncoder.encode(tag, "UTF-8").replace("+", "%20")
        val url = "https://codeload.github.com/$OWNER/$REPO/zip/refs/tags/$encoded"
        val zipFile = File(destRoot.parentFile, "ota-download.zip")
        if (zipFile.exists()) zipFile.delete()
        val conn = open(url)
        try {
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = conn.errorStream?.readBytes() ?: ByteArray(0)
                throw RuntimeException("HTTP $code ${String(err, StandardCharsets.UTF_8).take(240)}")
            }
            val length = conn.contentLengthLong
            val buf = ByteArray(64 * 1024)
            var got = 0L
            conn.inputStream.use { input ->
                zipFile.outputStream().use { out ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        got += n
                        val frac = if (length > 0L) (got.toDouble() / length).coerceIn(0.0, 1.0) else 0.45
                        onProgress(0.08 + 0.72 * frac, "Téléchargement…")
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
        onProgress(0.82, "Extraction…")
        var count = 0
        ZipInputStream(BufferedInputStream(zipFile.inputStream())).use { zis ->
            while (true) {
                val entry = zis.nextEntry ?: break
                if (entry.isDirectory) {
                    zis.closeEntry()
                    continue
                }
                val rel = stripZipRoot(entry.name)
                if (!wanted(rel)) {
                    zis.closeEntry()
                    continue
                }
                val out = File(destRoot, rel)
                out.parentFile?.mkdirs()
                out.outputStream().use { zis.copyTo(it) }
                zis.closeEntry()
                count++
            }
        }
        zipFile.delete()
        return count
    }

    private fun stripZipRoot(name: String): String {
        val n = name.replace('\\', '/')
        val i = n.indexOf('/')
        return if (i >= 0) n.substring(i + 1) else n
    }

    private fun httpGet(url: String): ByteArray {
        val conn = open(url)
        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val bytes = stream?.readBytes() ?: ByteArray(0)
            if (code !in 200..299) {
                throw RuntimeException("HTTP $code ${String(bytes, StandardCharsets.UTF_8).take(240)}")
            }
            return bytes
        } finally {
            conn.disconnect()
        }
    }

    private fun open(startUrl: String, readTimeoutMs: Int = 120000): HttpURLConnection {
        var current = startUrl
        repeat(8) {
            val conn = URL(current).openConnection() as HttpURLConnection
            conn.connectTimeout = 20000
            conn.readTimeout = readTimeoutMs
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("User-Agent", "GamelleChat")
            conn.setRequestProperty("Accept", "*/*")
            val code = conn.responseCode
            if (code in 300..399) {
                val loc = conn.getHeaderField("Location")
                conn.disconnect()
                if (loc.isNullOrBlank()) throw RuntimeException("Redirect sans Location ($code)")
                current = if (loc.startsWith("http")) loc else URL(URL(current), loc).toString()
                return@repeat
            }
            return conn
        }
        throw RuntimeException("Trop de redirections GitHub")
    }

    private fun key(tag: String) = tag.trim().removePrefix("v").removePrefix("V")

    private fun display(tag: String): String {
        val t = tag.trim()
        if (t.isEmpty()) return t
        return if (t.startsWith("v", ignoreCase = true)) t else "v$t"
    }

    private fun isNewer(remote: String, local: String): Boolean {
        if (remote.isBlank()) return false
        if (local.isBlank()) return true
        val r = semver(key(remote))
        val l = semver(key(local))
        if (r == null || l == null) return key(remote) != key(local)
        for (i in 0..2) {
            if (r[i] != l[i]) return r[i] > l[i]
        }
        return false
    }

    private fun semver(version: String): IntArray? {
        val parts = version.split(Regex("[.+\\-]"))
        if (parts.isEmpty() || parts[0].toIntOrNull() == null) return null
        return intArrayOf(
            parts.getOrNull(0)?.toIntOrNull() ?: 0,
            parts.getOrNull(1)?.toIntOrNull() ?: 0,
            parts.getOrNull(2)?.toIntOrNull() ?: 0,
        )
    }

    private fun githubError(e: Exception): String {
        val raw = (e.message ?: e.toString()).take(280)
        return when {
            raw.contains("HTTP 403") && raw.contains("rate limit", ignoreCase = true) ->
                "Limite GitHub atteinte. Réessaie dans une heure."
            raw.contains("HTTP 401") || raw.contains("HTTP 403") ->
                "GitHub a refusé la requête. $raw"
            raw.contains("HTTP 404") ->
                "Release introuvable. Vérifie ShivaneUN/gamelle-chat."
            else -> "Impossible de joindre GitHub. $raw"
        }
    }
}
