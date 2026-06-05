package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.MediaExport
import com.nekobooru.app.data.RetentionManager
import com.nekobooru.app.data.SyncManager
import com.nekobooru.app.data.SyncRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PoolEntity
import com.nekobooru.app.data.db.PostEntity
import com.nekobooru.app.sync.SyncScheduler
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID

/** A file ready to hand to the Android share sheet (ACTION_SEND). */
data class ShareData(val path: String, val mime: String)

@OptIn(ExperimentalCoroutinesApi::class)
class DetailViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = AppSettings(app)
    private val repo = SyncRepository(NekoDatabase.get(app))

    private val sha = MutableStateFlow<String?>(null)

    val post: StateFlow<PostEntity?> = sha
        .flatMapLatest { s -> if (s == null) flowOf(null) else repo.postDao.observeBySha(s) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val serverUrl: String get() = settings.serverUrl

    /** Pools the user can add this post to (offline-aware, live from Room). */
    val pools: StateFlow<List<PoolEntity>> = repo.poolDao.observeVisible()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Known tags for autocomplete when editing. */
    val allTags: StateFlow<List<String>> = repo.observeAllTags()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Locally cached original file path for the loaded post, if downloaded. */
    val localOriginal = MutableStateFlow<String?>(null)

    /** Share/export state: a non-null [ShareData] signals the UI to open the sheet. */
    val sharing = MutableStateFlow(false)
    val shareEvent = MutableStateFlow<ShareData?>(null)

    /** "Save to device" state: spinner while copying; [saveResult] is a one-shot
     *  event (true = saved, false = failed) the UI shows as a toast then clears. */
    val savingToDevice = MutableStateFlow(false)
    val saveResult = MutableStateFlow<Boolean?>(null)

    fun load(sha256: String) {
        sha.value = sha256
        localOriginal.value = null
        // Cache the full-res original for images on view (video streams instead,
        // and is mirrored offline by the background policy rather than per-view).
        viewModelScope.launch {
            val p = repo.postDao.getBySha(sha256) ?: return@launch
            if (!p.isVideo && !p.sha256.startsWith("pending-")) {
                localOriginal.value = RetentionManager(getApplication())
                    .fetchOriginal(settings.serverUrl, sha256)
            }
        }
    }

    /** Add the current post to an existing pool (or a freshly created one), then sync. */
    fun addToPool(poolUuid: String) {
        val p = post.value ?: return
        viewModelScope.launch {
            repo.addPostToPool(poolUuid, p.sha256)
            trySync()
        }
    }

    fun addToNewPool(name: String) {
        val p = post.value ?: return
        val trimmed = name.trim()
        if (trimmed.isBlank()) return
        viewModelScope.launch {
            repo.enqueuePoolUpsert(UUID.randomUUID().toString(), trimmed, null, listOf(p.sha256))
            trySync()
        }
    }

    /** A pending (not-yet-synced new) post can't be edited/deleted on the server yet. */
    val isPending: Boolean get() = post.value?.sha256?.startsWith("pending-") == true

    fun toggleFavorite() {
        val p = post.value ?: return
        viewModelScope.launch {
            repo.enqueueFavorite(p.sha256, !p.isFavorited)
            trySync()
        }
    }

    fun saveEdit(tags: String, safety: String) {
        val p = post.value ?: return
        viewModelScope.launch {
            val list = tags.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
            repo.enqueueEdit(p.sha256, list, safety)
            trySync()
        }
    }

    fun delete(onDone: () -> Unit) {
        val p = post.value ?: return
        viewModelScope.launch {
            repo.enqueueDelete(p.sha256)
            trySync()
            onDone()
        }
    }

    /**
     * Export the post's original file to the Android share sheet (to post it to
     * any app). Downloads the original first if it isn't cached yet (videos can
     * be large), showing a spinner; emits a [ShareData] the screen turns into an
     * ACTION_SEND intent.
     */
    fun share() {
        val p = post.value ?: return
        viewModelScope.launch {
            sharing.value = true
            val path = if (p.sha256.startsWith("pending-")) p.localMediaPath
            else RetentionManager(getApplication()).fetchOriginal(settings.serverUrl, p.sha256)
            sharing.value = false
            if (path != null) shareEvent.value = ShareData(path, mimeForExtension(p.extension))
        }
    }

    fun clearShare() { shareEvent.value = null }

    /**
     * Copy the post's original into the device gallery (a "NekoBooru" album) so
     * apps using the system photo picker (e.g. an X reply) can attach it.
     * Downloads the original first if needed. On API < 29 the caller must have
     * obtained WRITE_EXTERNAL_STORAGE before invoking this.
     */
    fun saveToDevice() {
        val p = post.value ?: return
        viewModelScope.launch {
            savingToDevice.value = true
            val path = if (p.sha256.startsWith("pending-")) p.localMediaPath
            else RetentionManager(getApplication()).fetchOriginal(settings.serverUrl, p.sha256)
            val ok = path != null && withContext(Dispatchers.IO) {
                MediaExport.saveToGallery(
                    getApplication(), path, displayName(p), p.isVideo, mimeForExtension(p.extension),
                )
            }
            savingToDevice.value = false
            saveResult.value = ok
        }
    }

    fun clearSaveResult() { saveResult.value = null }

    /** A gallery-friendly filename: the post's own name, else sha + extension. */
    private fun displayName(p: PostEntity): String =
        p.filename?.takeIf { it.isNotBlank() } ?: (p.sha256 + (p.extension ?: ""))

    private fun mimeForExtension(ext: String?): String = when (ext?.lowercase()) {
        ".jpg", ".jpeg" -> "image/jpeg"
        ".png" -> "image/png"
        ".gif" -> "image/gif"
        ".webp" -> "image/webp"
        ".mp4" -> "video/mp4"
        ".webm" -> "video/webm"
        else -> "application/octet-stream"
    }

    /** Best-effort immediate sync; if offline, a one-shot worker retries online. */
    private suspend fun trySync() {
        SyncManager.sync(getApplication())
        SyncScheduler.requestOneShot(getApplication())
    }
}
