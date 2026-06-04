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
    private val originalsDir = File(appContext.filesDir, "originals").apply { mkdirs() }
    private val thumbsDir = File(appContext.filesDir, "thumbs").apply { mkdirs() }

    /**
     * Run the offline-cache pass after a successful pull.
     *
     * Thumbnail caching and eviction are cheap and always run. Downloading the
     * (large) originals only happens when [downloadOriginals] is true — i.e. from
     * the background [com.nekobooru.app.sync.SyncWorker] — so the interactive
     * "Sync" button never blocks on a multi-GB mirror.
     */
    suspend fun run(
        serverUrl: String,
        policy: OfflinePolicy,
        downloadOriginals: Boolean,
    ) = withContext(Dispatchers.IO) {
        val posts = postDao.allVisible().filter { !it.sha256.startsWith("pending-") }

        // Thumbnails define the offline gallery — always cache them locally.
        cacheThumbnails(serverUrl, posts)

        // Which posts keep their original: the N most recent (by createdAt), or all.
        val keep = if (policy.limit == null) posts
        else posts.sortedByDescending { it.createdAt ?: "" }.take(policy.limit)
        val keepShas = keep.mapTo(HashSet()) { it.sha256 }

        // Evict originals that fall outside the window (cheap; always runs).
        posts.forEach { if (it.sha256 !in keepShas && it.localOriginalPath != null) evict(it) }

        // Download the in-window originals (heavy; background passes only).
        if (downloadOriginals) keep.forEach { ensureDownloaded(serverUrl, it) }
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

    /** Download any missing thumbnails to local storage (never evicted). */
    private suspend fun cacheThumbnails(serverUrl: String, posts: List<PostEntity>) {
        val api = ApiFactory.create(serverUrl)
        for (post in posts) {
            if (post.thumbUrl.isBlank()) continue
            if (post.localThumbPath != null && File(post.localThumbPath).exists()) continue
            try {
                val url = ApiFactory.absoluteUrl(serverUrl, post.thumbUrl)
                val dest = File(thumbsDir, post.sha256 + ".jpg")
                api.download(url).byteStream().use { input ->
                    dest.outputStream().use { output -> input.copyTo(output) }
                }
                postDao.setLocalThumb(post.sha256, dest.absolutePath)
            } catch (e: Exception) {
                // Leave it for the next sync; the server thumbnail is still used meanwhile.
            }
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
