package com.nekobooru.app.data

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PostEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Mirrors the library offline per the [OfflinePolicy]. Thumbnails for every
 * synced post are always cached (small) so the whole gallery browses offline;
 * this also keeps the N most-recent posts' full-resolution originals (or all of
 * them, for EVERYTHING) under ``filesDir/originals``, evicting the rest.
 * Best-effort: failures are swallowed so a flaky download never breaks a sync.
 */
class RetentionManager(context: Context) {
    private val appContext = context.applicationContext
    private val db = NekoDatabase.get(appContext)
    private val postDao = db.postDao()
    private val originalsDir = MediaPaths.originalsDir(appContext)
    private val thumbsDir = MediaPaths.thumbsDir(appContext)

    /**
     * Run the offline-cache pass after a successful pull.
     *
     * Eviction is cheap and always runs. The downloads (thumbnails + originals)
     * only happen when [downloadOriginals] is true — i.e. from the background
     * [com.nekobooru.app.sync.SyncWorker] — so the interactive "Sync" button
     * never blocks on caching hundreds of files. The gallery falls back to server
     * thumbnails until the background pass has cached them.
     */
    suspend fun run(
        serverUrl: String,
        policy: OfflinePolicy,
        downloadOriginals: Boolean,
    ) = withContext(Dispatchers.IO) {
        val posts = postDao.allVisible().filter { !it.sha256.startsWith("pending-") }

        // Which posts keep their original: the N most recent (by createdAt), or all.
        val keep = if (policy.limit == null) posts
        else posts.sortedByDescending { it.createdAt ?: "" }.take(policy.limit)
        val keepShas = keep.mapTo(HashSet()) { it.sha256 }

        // Evict originals that fall outside the window (cheap; always runs).
        posts.forEach { if (it.sha256 !in keepShas && it.localOriginalPath != null) evict(it) }

        if (!downloadOriginals) return@withContext
        try {
            cacheThumbnails(serverUrl, posts)   // offline gallery
            downloadOriginals(serverUrl, keep)  // full-res mirror per policy
        } finally {
            SyncProgress.clear()
        }
    }

    /**
     * Ensure the original for [sha] is cached locally, downloading it if needed.
     * Returns the local path or null. Used for on-demand viewing (the next sync
     * may evict it again if it's outside the offline window).
     */
    suspend fun fetchOriginal(serverUrl: String, sha: String): String? = withContext(Dispatchers.IO) {
        val post = postDao.getBySha(sha) ?: return@withContext null
        if (post.sha256.startsWith("pending-")) return@withContext post.localMediaPath
        val path = ensureDownloaded(serverUrl, post, exportTree())
        postDao.touchAccess(sha, System.currentTimeMillis())
        path
    }

    /**
     * Download any missing thumbnails to ``thumbs/<sha>.jpg``. Deliberately does
     * NOT touch the DB — the UI finds thumbnails by file existence — so caching
     * hundreds of thumbs doesn't re-fire the gallery's live query (which made
     * scrolling lag).
     */
    private suspend fun cacheThumbnails(serverUrl: String, posts: List<PostEntity>) {
        thumbsDir.mkdirs()
        val api = ApiFactory.create(serverUrl, AppSettings(appContext).apiToken)
        val missing = posts.filter {
            it.thumbUrl.isNotBlank() && !File(thumbsDir, it.sha256 + ".jpg").exists()
        }
        var done = 0
        for (post in missing) {
            try {
                val url = ApiFactory.absoluteUrl(serverUrl, post.thumbUrl)
                val dest = File(thumbsDir, post.sha256 + ".jpg")
                api.download(url).byteStream().use { input ->
                    dest.outputStream().use { output -> input.copyTo(output) }
                }
            } catch (e: Exception) {
                // Leave it for the next sync; the server thumbnail is still used meanwhile.
            }
            SyncProgress.report("Caching thumbnails", ++done, missing.size)
        }
    }

    /** Download the in-window originals that aren't cached yet, reporting progress. */
    private suspend fun downloadOriginals(serverUrl: String, keep: List<PostEntity>) {
        val tree = exportTree()
        val missing = keep.filter {
            it.contentUrl.isNotBlank() && !isCached(it.localOriginalPath)
        }
        var done = 0
        for (post in missing) {
            ensureDownloaded(serverUrl, post, tree)
            SyncProgress.report("Saving originals", ++done, missing.size)
        }
    }

    /**
     * Download the original if not already present; returns a file path or a
     * ``content://`` URI string depending on whether a user storage folder is set.
     */
    private suspend fun ensureDownloaded(
        serverUrl: String,
        post: PostEntity,
        tree: DocumentFile?,
    ): String? {
        if (isCached(post.localOriginalPath)) return post.localOriginalPath
        if (post.contentUrl.isBlank()) return null
        return try {
            val api = ApiFactory.create(serverUrl, AppSettings(appContext).apiToken)
            val url = ApiFactory.absoluteUrl(serverUrl, post.contentUrl)
            val body = api.download(url)
            val out: String = if (tree != null) {
                // Store in the user-chosen folder so files live in a real folder.
                val name = post.filename?.takeIf { it.isNotBlank() }
                    ?: (post.sha256 + (post.extension ?: ""))
                val doc = tree.createFile(mimeFor(post.extension), name)
                    ?: return null
                appContext.contentResolver.openOutputStream(doc.uri)?.use { o ->
                    body.byteStream().use { it.copyTo(o) }
                } ?: return null
                doc.uri.toString()
            } else {
                originalsDir.mkdirs()
                val dest = File(originalsDir, post.sha256 + (post.extension ?: ""))
                body.byteStream().use { input ->
                    dest.outputStream().use { output -> input.copyTo(output) }
                }
                dest.absolutePath
            }
            postDao.setLocalOriginal(post.sha256, out)
            out
        } catch (e: Exception) {
            null
        }
    }

    private suspend fun evict(post: PostEntity) {
        val p = post.localOriginalPath ?: return
        runCatching {
            if (p.startsWith("content://")) DocumentFile.fromSingleUri(appContext, Uri.parse(p))?.delete()
            else File(p).delete()
        }
        postDao.setLocalOriginal(post.sha256, null)
    }

    /**
     * Move every app-private original into the user's chosen folder (copy then
     * delete the private file, repointing the DB at the new ``content://`` URI).
     * Returns the number moved. No-op if no folder is set.
     */
    suspend fun migrateToExportFolder(): Int = withContext(Dispatchers.IO) {
        val tree = exportTree() ?: return@withContext 0
        val candidates = postDao.allVisible().filter {
            val p = it.localOriginalPath
            p != null && !p.startsWith("content://") && File(p).exists()
        }
        var moved = 0
        try {
            candidates.forEachIndexed { i, post ->
                runCatching {
                    val src = File(post.localOriginalPath!!)
                    val name = post.filename?.takeIf { it.isNotBlank() } ?: src.name
                    val doc = tree.createFile(mimeFor(post.extension), name)
                    if (doc != null) {
                        appContext.contentResolver.openOutputStream(doc.uri)?.use { o ->
                            src.inputStream().use { it.copyTo(o) }
                        }
                        postDao.setLocalOriginal(post.sha256, doc.uri.toString())
                        src.delete()
                        moved++
                    }
                }
                SyncProgress.report("Moving to folder", i + 1, candidates.size)
            }
        } finally {
            SyncProgress.clear()
        }
        moved
    }

    /** The user's chosen storage folder, if any (writable). */
    private fun exportTree(): DocumentFile? {
        val uri = AppSettings(appContext).exportTreeUri ?: return null
        return runCatching { DocumentFile.fromTreeUri(appContext, Uri.parse(uri)) }
            .getOrNull()?.takeIf { it.canWrite() }
    }

    /** True if the original at [path] (file path or content URI) is present. */
    private fun isCached(path: String?): Boolean {
        if (path == null) return false
        return if (path.startsWith("content://"))
            runCatching { DocumentFile.fromSingleUri(appContext, Uri.parse(path))?.exists() == true }
                .getOrDefault(false)
        else File(path).exists()
    }

    private fun mimeFor(ext: String?): String = when (ext?.lowercase()) {
        ".jpg", ".jpeg" -> "image/jpeg"
        ".png" -> "image/png"
        ".gif" -> "image/gif"
        ".webp" -> "image/webp"
        ".mp4" -> "video/mp4"
        ".webm" -> "video/webm"
        else -> "application/octet-stream"
    }
}
