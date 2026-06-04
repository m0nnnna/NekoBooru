package com.nekobooru.app.data

import android.content.Context
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
        val path = ensureDownloaded(serverUrl, post)
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
        val api = ApiFactory.create(serverUrl)
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
        val missing = keep.filter {
            it.contentUrl.isNotBlank() &&
                (it.localOriginalPath == null || !File(it.localOriginalPath).exists())
        }
        var done = 0
        for (post in missing) {
            ensureDownloaded(serverUrl, post)
            SyncProgress.report("Saving originals", ++done, missing.size)
        }
    }

    /** Download the original if not already present; returns the local path or null. */
    private suspend fun ensureDownloaded(serverUrl: String, post: PostEntity): String? {
        post.localOriginalPath?.let { existing ->
            if (File(existing).exists()) return existing
        }
        if (post.contentUrl.isBlank()) return null
        return try {
            val api = ApiFactory.create(serverUrl)
            val url = ApiFactory.absoluteUrl(serverUrl, post.contentUrl)
            val body = api.download(url)
            val dest = File(originalsDir, post.sha256 + (post.extension ?: ""))
            body.byteStream().use { input ->
                dest.outputStream().use { output -> input.copyTo(output) }
            }
            postDao.setLocalOriginal(post.sha256, dest.absolutePath)
            dest.absolutePath
        } catch (e: Exception) {
            null
        }
    }

    private suspend fun evict(post: PostEntity) {
        post.localOriginalPath?.let { File(it).delete() }
        if (post.localOriginalPath != null) postDao.setLocalOriginal(post.sha256, null)
    }
}
