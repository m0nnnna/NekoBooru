package com.nekobooru.app.data

import android.content.Context
import android.net.Uri
import java.io.File

/**
 * Deterministic on-device paths for cached media. Thumbnails are addressed
 * purely by sha (no DB column) so caching them doesn't churn the gallery's live
 * query — the UI just checks whether the file exists.
 */
object MediaPaths {
    // NOTE: these are pure path builders — they must NOT touch the filesystem
    // (no mkdirs), because thumb() is called from grid composition on every item
    // while scrolling. Creating the dirs is the writer's job (RetentionManager).
    fun thumbsDir(context: Context): File = File(context.filesDir, "thumbs")

    fun thumb(context: Context, sha: String): File = File(thumbsDir(context), "$sha.jpg")

    fun originalsDir(context: Context): File = File(context.filesDir, "originals")

    /**
     * Turn a stored original path into a Uri: a ``content://`` string (user's
     * chosen folder) is parsed as-is; anything else is treated as a file path.
     */
    fun toUri(path: String): Uri =
        if (path.startsWith("content://")) Uri.parse(path) else Uri.fromFile(File(path))

    fun isContentUri(path: String): Boolean = path.startsWith("content://")
}
