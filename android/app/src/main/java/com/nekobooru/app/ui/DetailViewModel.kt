package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.RetentionManager
import com.nekobooru.app.data.SyncManager
import com.nekobooru.app.data.SyncRepository
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

    /** Locally cached original file path for the loaded post, if downloaded. */
    val localOriginal = MutableStateFlow<String?>(null)

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

    /** Best-effort immediate sync; if offline, a one-shot worker retries online. */
    private suspend fun trySync() {
        SyncManager.sync(getApplication())
        SyncScheduler.requestOneShot(getApplication())
    }
}
