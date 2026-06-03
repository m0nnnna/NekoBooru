package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.SyncManager
import com.nekobooru.app.data.SyncRepository
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PostEntity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class GalleryUiState(
    val query: String = "",
    val posts: List<PostEntity> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val lastSyncedAt: Long = 0,
)

class GalleryViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = AppSettings(app)
    private val repo = SyncRepository(NekoDatabase.get(app))

    private val query = MutableStateFlow("")
    private val loading = MutableStateFlow(false)
    private val error = MutableStateFlow<String?>(null)
    private val lastSynced = MutableStateFlow(settings.lastSyncedAt)

    // UI is backed by Room, so the gallery works offline and updates live.
    val state: StateFlow<GalleryUiState> = combine(
        query, loading, error, lastSynced, repo.postDao.observeVisible(),
    ) { q, isLoading, err, synced, posts ->
        GalleryUiState(
            query = q,
            posts = filter(posts, q),
            loading = isLoading,
            error = err,
            lastSyncedAt = synced,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), GalleryUiState())

    val serverUrl: String get() = settings.serverUrl

    fun onQueryChange(q: String) { query.value = q }

    /** Re-read the persisted last-synced time (e.g. after returning from Settings). */
    fun refreshStatus() { lastSynced.value = settings.lastSyncedAt }

    /** Push queued offline changes, pull updates, and refresh the cache. */
    fun sync() {
        loading.value = true
        error.value = null
        viewModelScope.launch {
            SyncManager.sync(getApplication())
                .onFailure { error.value = it.message ?: "Failed to reach server" }
            lastSynced.value = settings.lastSyncedAt
            loading.value = false
        }
    }

    /** Local tag filtering mirroring the site's `tag` / `-tag` syntax. */
    private fun filter(posts: List<PostEntity>, q: String): List<PostEntity> {
        val terms = q.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
        if (terms.isEmpty()) return posts
        val required = terms.filterNot { it.startsWith("-") }
        val excluded = terms.filter { it.startsWith("-") }.map { it.drop(1) }
        return posts.filter { post ->
            val tags = post.tagList
            required.all { it in tags } && excluded.none { it in tags }
        }
    }
}
