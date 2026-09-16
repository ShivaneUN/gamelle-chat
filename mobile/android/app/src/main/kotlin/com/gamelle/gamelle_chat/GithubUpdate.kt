package com.gamelle.gamelle_chat

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.zip.ZipInputStream

/**
 * Met à jour server.js + public/ depuis le dépôt public, sans jeton ni api.github.com
 * (l’API anonyme tombe en 403 après 60 appels/heure).
 */
object GithubUpdate {
    const val OWNER = "ShivaneUN"
    const val REPO = "gamelle-chat"
    const val BRANCH = "main"

    private fun tokenFile(filesDir: File) = File(filesDir, "gamelle-persist/github-token.txt")
    fun versionFile(filesDir: File) = File(filesDir, "gamelle-persist/ota/version.json")
    fun otaDir(filesDir: File) = File(filesDir, "gamelle-persist/ota")
    fun nodeDir(filesDir: File) = File(filesDir, "nodejs-project")

    private fun forgetStoredToken(filesDir: File) {
        val f = tokenFile(filesDir)
        if (f.exists()) f.delete()
    }

    fun localSha(filesDir: File): String {
        val f = versionFile(filesDir)
        if (!f.exists()) return ""
        return try {
            JSONObject(f.readText(StandardCharsets.UTF_8)).optString("sha")
        } catch (_: Exception) {
            ""
        }
    }

    fun applyStoredOverlay(filesDir: File) {
        val ota = otaDir(filesDir)
        if (!ota.exists()) return
        copyWanted(ota, nodeDir(filesDir))
    }

    fun status(filesDir: File): Map<String, Any?> {
        forgetStoredToken(filesDir)
        val local = localSha(filesDir)
        return try {
            val head = fetchHead()
            val sha = head.sha
            val available = sha.isNotBlank() && sha != local
            mapOf(
                "ok" to true,
                "git" to true,
                "available" to available,
                "local" to short(local),
                "remote" to short(sha),
                "remoteSha" to sha,
                "message" to when {
                    sha.isBlank() -> "Impossible de lire GitHub."
                    local.isBlank() -> "Mise à jour GitHub prête (${short(sha)})."
                    available -> "Une mise à jour est disponible (${short(local)} → ${short(sha)})."
                    else -> "Déjà à jour (${short(sha)})."
                },
                "detail" to head.title,
            )
        } catch (e: Exception) {
            mapOf(
                "ok" to false,
                "git" to true,
                "available" to false,
                "local" to short(local),
                "message" to githubError(e),
            )
        }
    }

    fun apply(filesDir: File): Map<String, Any?> {
        forgetStoredToken(filesDir)
        return try {
            val head = fetchHead()
            val sha = head.sha
            if (sha.isBlank()) {
                return mapOf("ok" to false, "restart" to false, "message" to "Commit GitHub introuvable.")
            }
            if (sha == localSha(filesDir)) {
                applyStoredOverlay(filesDir)
                return mapOf("ok" to true, "restart" to false, "message" to "Déjà à jour.", "available" to false)
            }
            val tmp = File(filesDir, "gamelle-persist/ota-tmp")
            if (tmp.exists()) tmp.deleteRecursively()
            tmp.mkdirs()
            val count = downloadZipWanted(tmp)
            if (count == 0) {
                tmp.deleteRecursively()
                return mapOf("ok" to false, "restart" to false, "message" to "Aucun fichier public/server à tirer.")
            }
            val ota = otaDir(filesDir)
            if (ota.exists()) ota.deleteRecursively()
            tmp.copyRecursively(ota, overwrite = true)
            tmp.deleteRecursively()
            versionFile(filesDir).writeText(
                JSONObject()
                    .put("sha", sha)
                    .put("at", System.currentTimeMillis())
                    .toString(2),
                StandardCharsets.UTF_8,
            )
            applyStoredOverlay(filesDir)
            mapOf(
                "ok" to true,
                "restart" to true,
                "available" to false,
                "remote" to short(sha),
                "message" to "Mise à jour installée (${short(sha)}). Redémarrage du serveur…",
            )
        } catch (e: Exception) {
            mapOf(
                "ok" to false,
                "restart" to false,
                "message" to githubError(e),
            )
        }
    }

    private data class Head(val sha: String, val title: String)

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

    private fun fetchHead(): Head {
        val xml = String(
            httpGet("https://github.com/$OWNER/$REPO/commits/$BRANCH.atom"),
            StandardCharsets.UTF_8,
        )
        val sha = Regex("""Commit/([0-9a-f]{40})""", RegexOption.IGNORE_CASE)
            .find(xml)
            ?.groupValues
            ?.get(1)
            .orEmpty()
        if (sha.isBlank()) {
            throw RuntimeException("Commit introuvable dans le flux GitHub.")
        }
        val titles = Regex("""<title>\s*(?:<!\[CDATA\[)?(.*?)(?:]]>)?\s*</title>""", RegexOption.DOT_MATCHES_ALL)
            .findAll(xml)
            .map { it.groupValues[1].trim() }
            .toList()
        val title = titles.drop(1).firstOrNull().orEmpty()
        return Head(sha, title)
    }

    private fun downloadZipWanted(destRoot: File): Int {
        val url = "https://codeload.github.com/$OWNER/$REPO/zip/refs/heads/$BRANCH"
        var count = 0
        val conn = open(url)
        try {
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = conn.errorStream?.readBytes() ?: ByteArray(0)
                throw RuntimeException("HTTP $code ${String(err, StandardCharsets.UTF_8).take(240)}")
            }
            ZipInputStream(BufferedInputStream(conn.inputStream)).use { zis ->
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
        } finally {
            conn.disconnect()
        }
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

    private fun open(startUrl: String): HttpURLConnection {
        var current = startUrl
        repeat(8) {
            val conn = URL(current).openConnection() as HttpURLConnection
            conn.connectTimeout = 20000
            conn.readTimeout = 120000
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

    private fun short(sha: String) = sha.take(7)

    private fun githubError(e: Exception): String {
        val raw = (e.message ?: e.toString()).take(280)
        return when {
            raw.contains("HTTP 403") && raw.contains("rate limit", ignoreCase = true) ->
                "Limite GitHub atteinte. Réessaie dans une heure."
            raw.contains("HTTP 401") || raw.contains("HTTP 403") ->
                "GitHub a refusé la requête. $raw"
            raw.contains("HTTP 404") ->
                "Dépôt introuvable. Vérifie ShivaneUN/gamelle-chat."
            else -> "Impossible de joindre GitHub. $raw"
        }
    }
}
