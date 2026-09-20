package com.gamelle.gamelle_chat

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import org.json.JSONObject
import java.io.File

/**
 * node_flutter recopie `nodejs-project` depuis l’APK à chaque mise à jour
 * et vide `nodejs-project-trash`. On sauve data/certs/uploads AVANT.
 * Le ContentProvider tourne avant Application.onCreate et avant les plugins.
 */
object PersistRescue {
    fun rescue(filesDir: File) {
        val dest = File(filesDir, "gamelle-persist")
        listOf(
            File(filesDir, "nodejs-project"),
            File(filesDir, "nodejs-project-trash"),
        ).forEach { srcRoot ->
            copyTreeMissing(File(srcRoot, "certs"), File(dest, "certs"))
            copyTreeMissing(File(srcRoot, "uploads"), File(dest, "uploads"))
            copyTreeMissing(File(srcRoot, "data"), File(dest, "data"))
            mergeSchedules(File(srcRoot, "data/schedules.json"), File(dest, "data/schedules.json"))
            mergeAccounts(File(srcRoot, "data/accounts.json"), File(dest, "data/accounts.json"))
            keepRicher(
                File(srcRoot, "data/active-code.json"),
                File(dest, "data/active-code.json"),
            )
            keepRicher(
                File(srcRoot, "data/sessions.json"),
                File(dest, "data/sessions.json"),
            )
            // Tunnel perso : sauver hors APK (les releases publiques n’embarquent plus les secrets).
            rescueTunnelFile(File(srcRoot, "tunnel.config.json"), File(dest, "tunnel.config.json"), tunnelConfig = true)
            rescueTunnelFile(File(srcRoot, "tunnel.token"), File(dest, "tunnel.token"), tunnelConfig = false)
        }
    }

    /** Copie token/config réels vers gamelle-persist ; n’écrase jamais un secret déjà présent. */
    private fun rescueTunnelFile(src: File, dest: File, tunnelConfig: Boolean) {
        if (!src.exists() || src.length() < 8L) return
        val text = try {
            src.readText()
        } catch (_: Exception) {
            return
        }
        if (tunnelConfig) {
            if (isPlaceholderTunnelConfig(text)) return
        } else if (isPlaceholderTunnelToken(text)) {
            return
        }
        dest.parentFile?.mkdirs()
        if (!dest.exists() || dest.length() < 8L) {
            try {
                src.copyTo(dest, overwrite = true)
            } catch (_: Exception) {
            }
            return
        }
        val existing = try {
            dest.readText()
        } catch (_: Exception) {
            ""
        }
        val destIsPlaceholder = if (tunnelConfig) {
            isPlaceholderTunnelConfig(existing)
        } else {
            isPlaceholderTunnelToken(existing)
        }
        if (destIsPlaceholder) {
            try {
                src.copyTo(dest, overwrite = true)
            } catch (_: Exception) {
            }
        }
    }

    private fun isPlaceholderTunnelConfig(text: String): Boolean {
        val t = text.trim()
        if (t.isEmpty()) return true
        if (t.contains("TON-SOUS-DOMAINE") || t.contains("TON-DOMAINE")) return true
        return try {
            val url = JSONObject(t).optString("publicUrl").trim()
            url.isEmpty() || url.contains("TON-")
        } catch (_: Exception) {
            true
        }
    }

    private fun isPlaceholderTunnelToken(text: String): Boolean {
        val line = text.lineSequence()
            .map { it.trim() }
            .firstOrNull { it.isNotEmpty() && !it.startsWith("#") }
        return line.isNullOrBlank() ||
            line.contains("REMPLACE") ||
            line.contains("TON-") ||
            line.length < 40
    }

    private fun copyTreeMissing(src: File, dest: File) {
        if (!src.exists()) return
        dest.mkdirs()
        src.listFiles()?.forEach { child ->
            val target = File(dest, child.name)
            if (child.isDirectory) {
                copyTreeMissing(child, target)
            } else if (child.name == "public-url.json") {
                // Lien Cloudflare éphémère.
            } else if (!target.exists()) {
                try {
                    child.copyTo(target, overwrite = false)
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun keepRicher(src: File, dest: File) {
        if (!src.exists()) return
        dest.parentFile?.mkdirs()
        if (!dest.exists() || dest.length() < src.length()) {
            try {
                src.copyTo(dest, overwrite = true)
            } catch (_: Exception) {
            }
        }
    }

    private fun mergeSchedules(src: File, dest: File) {
        if (!src.exists()) return
        dest.parentFile?.mkdirs()
        if (!dest.exists() || dest.length() <= 4L) {
            keepRicher(src, dest)
            return
        }
        try {
            val incoming = JSONObject(src.readText())
            val current = JSONObject(dest.readText())
            var changed = false
            incoming.keys().forEach { code ->
                val srcRoom = incoming.optJSONObject(code) ?: return@forEach
                val dstRoom = current.optJSONObject(code)
                if (roomWeight(srcRoom) > roomWeight(dstRoom)) {
                    current.put(code, srcRoom)
                    changed = true
                }
            }
            if (changed) dest.writeText(current.toString(2))
        } catch (_: Exception) {
            keepRicher(src, dest)
        }
    }

    /** Fusionne accounts.json (union par id / username) pour ne pas perdre les comptes à l’OTA. */
    private fun mergeAccounts(src: File, dest: File) {
        if (!src.exists()) return
        dest.parentFile?.mkdirs()
        if (!dest.exists() || dest.length() <= 4L) {
            keepRicher(src, dest)
            return
        }
        try {
            val incoming = JSONObject(src.readText())
            val current = JSONObject(dest.readText())
            val inUsers = incoming.optJSONArray("users") ?: return
            val curUsers = current.optJSONArray("users") ?: org.json.JSONArray()
            val seenIds = mutableSetOf<String>()
            val seenNames = mutableSetOf<String>()
            for (i in 0 until curUsers.length()) {
                val u = curUsers.optJSONObject(i) ?: continue
                val id = u.optString("id")
                val name = u.optString("username").lowercase()
                if (id.isNotBlank()) seenIds.add(id)
                if (name.isNotBlank()) seenNames.add(name)
            }
            var changed = false
            for (i in 0 until inUsers.length()) {
                val u = inUsers.optJSONObject(i) ?: continue
                val id = u.optString("id")
                val name = u.optString("username").lowercase()
                if (u.optString("passHash").isBlank() || u.optString("salt").isBlank()) continue
                if (id.isNotBlank() && seenIds.contains(id)) continue
                if (name.isNotBlank() && seenNames.contains(name)) continue
                curUsers.put(u)
                if (id.isNotBlank()) seenIds.add(id)
                if (name.isNotBlank()) seenNames.add(name)
                changed = true
            }
            if (changed) {
                current.put("users", curUsers)
                dest.writeText(current.toString(2))
            }
        } catch (_: Exception) {
            keepRicher(src, dest)
        }
    }

    private fun roomWeight(room: JSONObject?): Int {
        if (room == null) return 0
        val schedules = room.optJSONArray("schedules")
        val messages = room.optJSONArray("messages")
        return (schedules?.length() ?: 0) + (messages?.length() ?: 0)
    }
}

class PersistRescueProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        context?.filesDir?.let { PersistRescue.rescue(it) }
        return true
    }

    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, s: String?, a: Array<out String>?): Int = 0
}
