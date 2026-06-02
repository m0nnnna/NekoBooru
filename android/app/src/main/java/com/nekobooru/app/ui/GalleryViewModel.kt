package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.ApiFactory
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.PostDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class GalleryUiState(
    val serverUrl: String = AppSettings.DEFAULT_SERVER_URL,
    val query: String = "",
    val posts: List<PostDto> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

class GalleryViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = AppSettings(app)

    private val _state = MutableStateFlow(GalleryUiState(serverUrl = settings.serverUrl))
    val state: StateFlow<GalleryUiState> = _state.asStateFlow()

    fun onServerUrlChange(url: String) {
        _state.value = _state.value.copy(serverUrl = url)
    }

    fun onQueryChange(q: String) {
        _state.value = _state.value.copy(query = q)
    }

    fun refresh() {
        val current = _state.value
        settings.serverUrl = current.serverUrl
        _state.value = current.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                val api = ApiFactory.create(current.serverUrl)
                val resp = api.listPosts(q = current.query, page = 1, limit = 60)
                _state.value = _state.value.copy(loading = false, posts = resp.results)
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    loading = false,
                    error = e.message ?: "Failed to reach server",
                )
            }
        }
    }
}
