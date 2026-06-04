package com.nekobooru.app.data

import android.content.Context
import java.io.File

/**
 * Deterministic on-device paths for cached media. Thumbnails are addressed
 * purely by sha (no DB column) so caching them doesn't churn the gallery's live
 * query — the UI just checks whether the file exists.
 */
object MediaPaths {
    fun thumbsDir(context: Context): File =
        File(context.filesDir, "thumbs").apply { mkdirs() }

    fun thumb(context: Context, sha: String): File =
        File(thumbsDir(context), "$sha.jpg")

    fun originalsDir(context: Context): File =
        File(context.filesDir, "originals").apply { mkdirs() }
}
