package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.SyncRepository
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PostEntity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@OptIn(ExperimentalCoroutinesApi::class)
class DetailViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = AppSettings(app)
    private val repo = SyncRepository(NekoDatabase.get(app))

    private val sha = MutableStateFlow<String?>(null)

    val post: StateFlow<PostEntity?> = sha
        .flatMapLatest { s -> if (s == null) flowOf(null) else repo.postDao.observeBySha(s) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val serverUrl: String get() = settings.serverUrl

    fun load(sha256: String) { sha.value = sha256 }

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

    /** Best-effort sync; offline changes stay queued if the server is unreachable. */
    private suspend fun trySync() {
        runCatching {
            repo.push(settings.serverUrl)
            repo.pull(settings.serverUrl)
        }
    }
}
