package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.SyncManager
import com.nekobooru.app.data.SyncRepository
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PostEntity
import com.nekobooru.app.sync.SyncScheduler
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class GalleryUiState(
    val query: String = "",
    val visibleSafety: Set<String> = com.nekobooru.app.data.Safety.ALL,
    val posts: List<PostEntity> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val lastSyncedAt: Long = 0,
)

class GalleryViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = AppSettings(app)
    private val repo = SyncRepository(NekoDatabase.get(app))

    private val query = MutableStateFlow("")
    private val safety = MutableStateFlow(settings.visibleSafety)
    private val loading = MutableStateFlow(false)
    private val error = MutableStateFlow<String?>(null)
    private val lastSynced = MutableStateFlow(settings.lastSyncedAt)

    private val filters = combine(query, safety) { q, s -> q to s }

    // UI is backed by Room, so the gallery works offline and updates live.
    val state: StateFlow<GalleryUiState> = combine(
        filters, loading, error, lastSynced, repo.postDao.observeVisible(),
    ) { (q, saf), isLoading, err, synced, posts ->
        GalleryUiState(
            query = q,
            visibleSafety = saf,
            posts = filter(posts, q, saf),
            loading = isLoading,
            error = err,
            lastSyncedAt = synced,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), GalleryUiState())

    val serverUrl: String get() = settings.serverUrl

    fun onQueryChange(q: String) { query.value = q }

    /** Toggle whether a safety level (safe/sketchy/unsafe) is shown; persisted. */
    fun toggleSafety(level: String) {
        val next = safety.value.toMutableSet().apply { if (!add(level)) remove(level) }
        safety.value = next
        settings.visibleSafety = next
    }

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
            // Mirror originals offline in the background per the policy.
            SyncScheduler.requestOneShot(getApplication())
        }
    }

    /**
     * Local filtering: safety/sensitivity gate first, then the site's
     * `tag` / `-tag` include/exclude syntax.
     */
    private fun filter(posts: List<PostEntity>, q: String, safety: Set<String>): List<PostEntity> {
        val bySafety = posts.filter { it.safety in safety }
        val terms = q.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
        if (terms.isEmpty()) return bySafety
        val required = terms.filterNot { it.startsWith("-") }
        val excluded = terms.filter { it.startsWith("-") }.map { it.drop(1) }
        return bySafety.filter { post ->
            val tags = post.tagList
            required.all { it in tags } && excluded.none { it in tags }
        }
    }
}
