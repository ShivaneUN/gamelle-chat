package com.gamelle.gamelle_chat

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import java.io.File
import java.io.FileOutputStream

object MediaSaver {
    data class Result(val ok: Boolean, val path: String = "", val message: String = "")

    fun saveBase64(
        ctx: Context,
        fileName: String,
        mime: String,
        base64: String,
    ): Result {
        val safeName = fileName.substringAfterLast('/').substringAfterLast('\\')
            .ifBlank { "gamelle_${System.currentTimeMillis()}" }
        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (e: Exception) {
            return Result(false, message = "Données invalides")
        }
        if (bytes.isEmpty()) return Result(false, message = "Fichier vide")
        val isVideo = mime.startsWith("video") || safeName.endsWith(".webm") || safeName.endsWith(".mp4")
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveMediaStore(ctx, safeName, mime.ifBlank {
                    if (isVideo) "video/webm" else "image/jpeg"
                }, bytes, isVideo)
            } else {
                saveLegacy(safeName, bytes, isVideo)
            }
        } catch (e: Exception) {
            Result(false, message = e.message ?: "Erreur enregistrement")
        }
    }

    private fun saveMediaStore(
        ctx: Context,
        name: String,
        mime: String,
        bytes: ByteArray,
        isVideo: Boolean,
    ): Result {
        val collection = if (isVideo) {
            MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        } else {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                if (isVideo) Environment.DIRECTORY_MOVIES + "/GamelleChat"
                else Environment.DIRECTORY_PICTURES + "/GamelleChat",
            )
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val resolver = ctx.contentResolver
        val uri = resolver.insert(collection, values)
            ?: return Result(false, message = "Impossible de créer le fichier")
        resolver.openOutputStream(uri)?.use { it.write(bytes) }
            ?: return Result(false, message = "Écriture impossible")
        values.clear()
        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return Result(ok = true, path = uri.toString(), message = "Enregistré dans ${if (isVideo) "Films" else "Photos"}/GamelleChat")
    }

    @Suppress("DEPRECATION")
    private fun saveLegacy(name: String, bytes: ByteArray, isVideo: Boolean): Result {
        val dir = Environment.getExternalStoragePublicDirectory(
            if (isVideo) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES,
        )
        val folder = File(dir, "GamelleChat")
        if (!folder.exists()) folder.mkdirs()
        val out = File(folder, name)
        FileOutputStream(out).use { it.write(bytes) }
        return Result(ok = true, path = out.absolutePath, message = "Enregistré : ${out.absolutePath}")
    }
}
