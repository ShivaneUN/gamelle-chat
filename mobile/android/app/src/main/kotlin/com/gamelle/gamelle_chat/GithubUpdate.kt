package com.gamelle.gamelle_chat

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Récupère server.js + public/ depuis GitHub (comme un git pull),
 * les pose dans gamelle-persist/ota, puis les recopie sur nodejs-project.
 * Dépôt public : aucun jeton.
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
            val remote = fetchHead()
            val sha = remote.optString("sha")
            val msg = remote.optJSONObject("commit")?.optString("message")?.lineSequence()?.firstOrNull().orEmpty()
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
                "detail" to msg,
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
            val sha = head.optString("sha")
            if (sha.isBlank()) {
                return mapOf("ok" to false, "restart" to false, "message" to "Commit GitHub introuvable.")
            }
            if (sha == localSha(filesDir)) {
                applyStoredOverlay(filesDir)
                return mapOf("ok" to true, "restart" to false, "message" to "Déjà à jour.", "available" to false)
            }
            val files = wantedFiles(sha)
            if (files.isEmpty()) {
                return mapOf("ok" to false, "restart" to false, "message" to "Aucun fichier public/server à tirer.")
            }
            val tmp = File(filesDir, "gamelle-persist/ota-tmp")
            if (tmp.exists()) tmp.deleteRecursively()
            tmp.mkdirs()
            for (path in files) {
                val dest = File(tmp, path)
                dest.parentFile?.mkdirs()
                dest.writeBytes(downloadRaw(path, sha))
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

    private fun fetchHead(): JSONObject {
        val body = httpGet(
            "https://api.github.com/repos/$OWNER/$REPO/commits/$BRANCH",
            "application/vnd.github+json",
        )
        return JSONObject(String(body, StandardCharsets.UTF_8))
    }

    private fun wantedFiles(sha: String): List<String> {
        val body = httpGet(
            "https://api.github.com/repos/$OWNER/$REPO/git/trees/$sha?recursive=1",
            "application/vnd.github+json",
        )
        val json = JSONObject(String(body, StandardCharsets.UTF_8))
        val tree = json.optJSONArray("tree") ?: return emptyList()
        val out = ArrayList<String>()
        for (i in 0 until tree.length()) {
            val item = tree.optJSONObject(i) ?: continue
            if (item.optString("type") != "blob") continue
            val path = item.optString("path")
            if (wanted(path)) out.add(path)
        }
        return out
    }

    private fun downloadRaw(path: String, sha: String): ByteArray {
        val encoded = path.split('/').joinToString("/") { android.net.Uri.encode(it) }
        return httpGet(
            "https://api.github.com/repos/$OWNER/$REPO/contents/$encoded?ref=$sha",
            "application/vnd.github.raw",
        )
    }

    private fun httpGet(url: String, accept: String): ByteArray {
        var current = url
        repeat(6) {
            val conn = URL(current).openConnection() as HttpURLConnection
            conn.connectTimeout = 20000
            conn.readTimeout = 120000
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("User-Agent", "GamelleChat")
            conn.setRequestProperty("Accept", accept)
            val code = conn.responseCode
            if (code in 300..399) {
                val loc = conn.getHeaderField("Location")
                conn.disconnect()
                if (loc.isNullOrBlank()) throw RuntimeException("Redirect sans Location ($code)")
                current = loc
                return@repeat
            }
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val bytes = stream?.readBytes() ?: ByteArray(0)
            conn.disconnect()
            if (code !in 200..299) {
                val err = String(bytes, StandardCharsets.UTF_8).take(240)
                throw RuntimeException("HTTP $code $err")
            }
            return bytes
        }
        throw RuntimeException("Trop de redirections GitHub")
    }

    private fun short(sha: String) = sha.take(7)

    private fun githubError(e: Exception): String {
        val raw = (e.message ?: e.toString()).take(280)
        return when {
            raw.contains("HTTP 401") || raw.contains("HTTP 403") ->
                "GitHub a refusé la requête. Réessaie plus tard."
            raw.contains("HTTP 404") ->
                "Dépôt introuvable. Vérifie ShivaneUN/gamelle-chat."
            else -> "Impossible de joindre GitHub. $raw"
        }
    }
}
