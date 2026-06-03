package com.nekobooru.app.data

import android.content.Context
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PostEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Applies the original-file [Retention] policy to the local cache. Thumbnails
 * are always cached by Coil; this manages the (large) full-resolution originals
 * stored under ``filesDir/originals``. Best-effort: failures are swallowed so a
 * flaky download never breaks a sync.
 */
class RetentionManager(context: Context) {
    private val appContext = context.applicationContext
    private val db = NekoDatabase.get(appContext)
    private val postDao = db.postDao()
    private val poolDao = db.poolDao()
    private val originalsDir = File(appContext.filesDir, "originals").apply { mkdirs() }

    /** Run the maintenance pass for [retention]; call after a successful pull. */
    suspend fun run(serverUrl: String, retention: Retention) = withContext(Dispatchers.IO) {
        val posts = postDao.allVisible().filter { !it.sha256.startsWith("pending-") }
        when (retention) {
            Retention.EVERYTHING -> posts.forEach { ensureDownloaded(serverUrl, it) }

            Retention.FAVORITES_POOLS -> {
                val pooled = poolDao.getAll().flatMap { it.postSha256s }.toSet()
                val (keep, drop) = posts.partition { it.isFavorited || it.sha256 in pooled }
                keep.forEach { ensureDownloaded(serverUrl, it) }
                drop.forEach { evict(it) }
            }

            Retention.ON_DEMAND -> {
                // Don't pre-fetch; just cap the cache, evicting least-recently-used.
                val cached = posts.filter { it.localOriginalPath != null }
                if (cached.size > ON_DEMAND_CAP) {
                    cached.sortedBy { it.lastAccessedAt }
                        .take(cached.size - ON_DEMAND_CAP)
                        .forEach { evict(it) }
                }
            }
        }
    }

    /**
     * Ensure the original for [sha] is cached locally, downloading it if needed,
     * and record the access time (for LRU). Returns the local path or null.
     * Used for on-demand viewing.
     */
    suspend fun fetchOriginal(serverUrl: String, sha: String): String? = withContext(Dispatchers.IO) {
        val post = postDao.getBySha(sha) ?: return@withContext null
        if (post.sha256.startsWith("pending-")) return@withContext post.localMediaPath
        val path = ensureDownloaded(serverUrl, post)
        postDao.touchAccess(sha, System.currentTimeMillis())
        path
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

    companion object {
        /** Max originals kept under ON_DEMAND before LRU eviction kicks in. */
        private const val ON_DEMAND_CAP = 60
    }
}
