package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.AppSettings
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
    val serverUrl: String = AppSettings.DEFAULT_SERVER_URL,
    val query: String = "",
    val posts: List<PostEntity> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

class GalleryViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = AppSettings(app)
    private val repo = SyncRepository(NekoDatabase.get(app))

    private val serverUrl = MutableStateFlow(settings.serverUrl)
    private val query = MutableStateFlow("")
    private val loading = MutableStateFlow(false)
    private val error = MutableStateFlow<String?>(null)

    // UI is backed by Room, so the gallery works offline and updates live.
    val state: StateFlow<GalleryUiState> = combine(
        serverUrl, query, loading, error, repo.postDao.observeVisible(),
    ) { url, q, isLoading, err, posts ->
        GalleryUiState(
            serverUrl = url,
            query = q,
            posts = filter(posts, q),
            loading = isLoading,
            error = err,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), GalleryUiState())

    fun onServerUrlChange(url: String) { serverUrl.value = url }
    fun onQueryChange(q: String) { query.value = q }

    /** Persist the server URL, push queued offline changes, then pull updates. */
    fun sync() {
        settings.serverUrl = serverUrl.value
        loading.value = true
        error.value = null
        viewModelScope.launch {
            try {
                repo.push(serverUrl.value)
                repo.pull(serverUrl.value)
            } catch (e: Exception) {
                error.value = e.message ?: "Failed to reach server"
            } finally {
                loading.value = false
            }
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
