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
            keepRicher(
                File(srcRoot, "data/active-code.json"),
                File(dest, "data/active-code.json"),
            )
        }
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
