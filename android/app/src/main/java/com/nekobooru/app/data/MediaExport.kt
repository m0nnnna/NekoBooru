package com.nekobooru.app.data

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.InputStream

/**
 * Copies a post's original into the device's shared media collection (a
 * "NekoBooru" album in Pictures/Movies) so apps that use the sealed system photo
 * picker — e.g. attaching to an X reply — can see it. This is the one deliberate
 * path by which library content leaves the app and becomes visible in the device
 * gallery; everything else stays app-private.
 */
object MediaExport {
    /**
     * Save [source] (an app-private file path or a `content://` URI) into the
     * gallery as [displayName]. Returns true on success. Pre-Android 10 this
     * requires WRITE_EXTERNAL_STORAGE to have been granted by the caller.
     */
    fun saveToGallery(
        context: Context,
        source: String,
        displayName: String,
        isVideo: Boolean,
        mime: String,
    ): Boolean {
        val resolver = context.contentResolver
        val collection = if (isVideo) MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        else MediaStore.Images.Media.EXTERNAL_CONTENT_URI

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val base = if (isVideo) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES
                put(MediaStore.MediaColumns.RELATIVE_PATH, "$base/NekoBooru")
                // Hide the item until the bytes are fully written.
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }

        val item: Uri = resolver.insert(collection, values) ?: return false
        return try {
            resolver.openOutputStream(item)?.use { out ->
                openSource(context, source).use { input -> input.copyTo(out) }
            } ?: throw IllegalStateException("no output stream")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(item, values, null, null)
            }
            true
        } catch (e: Exception) {
            // Roll back the half-written placeholder so a failure leaves nothing behind.
            runCatching { resolver.delete(item, null, null) }
            false
        }
    }

    private fun openSource(context: Context, source: String): InputStream =
        if (source.startsWith("content://"))
            context.contentResolver.openInputStream(Uri.parse(source))
                ?: throw IllegalStateException("can't open $source")
        else File(source).inputStream()
}
