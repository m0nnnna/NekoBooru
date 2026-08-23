package com.nekobooru.app.ui

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.SyncManager
import com.nekobooru.app.data.SyncRepository
import com.nekobooru.app.data.UrlClassifier
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.sync.SyncScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

data class AddUiState(
    val pickedUri: Uri? = null,
    val url: String = "",
    val tags: List<String> = emptyList(),
    val safety: String = "safe",
    val saving: Boolean = false,
    val fetching: Boolean = false,
    val error: String? = null,
    val done: Boolean = false,
) {
    /** Whether the pasted text looks like a link the server can fetch. */
    val urlSupported: Boolean get() = url.isNotBlank() && UrlClassifier.looksLikeSupportedUrl(url)
}

class AddViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = SyncRepository(NekoDatabase.get(app))

    private val _state = MutableStateFlow(AddUiState())
    val state: StateFlow<AddUiState> = _state.asStateFlow()

    /** Known tags for autocomplete. */
    val allTags: StateFlow<List<String>> = repo.observeAllTags()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Clear state so the screen is fresh next time it's opened. */
    fun reset() { _state.value = AddUiState() }

    fun onPicked(uri: Uri) { _state.value = _state.value.copy(pickedUri = uri, error = null) }
    fun onUrlChange(u: String) { _state.value = _state.value.copy(url = u, error = null) }
    fun onTagsChange(t: List<String>) { _state.value = _state.value.copy(tags = t) }
    fun onSafetyChange(s: String) { _state.value = _state.value.copy(safety = s) }

    /**
     * Submit a pasted image/video/post link. The server downloads the media —
     * using its configured yt-dlp cookies for video sites — then the new post is
     * pulled into the local library. Requires the server to be online.
     */
    fun submitUrl() {
        val cur = _state.value
        val url = cur.url.trim()
        if (url.isEmpty()) {
            _state.value = cur.copy(error = "Paste an image or video link first")
            return
        }
        _state.value = cur.copy(fetching = true, error = null)
        viewModelScope.launch {
            try {
                val appSettings = AppSettings(getApplication())
                val created = withContext(Dispatchers.IO) {
                    repo.submitUrlPost(appSettings.serverUrl, url, cur.tags, cur.safety, appSettings.apiToken)
                }
                if (created == 0) {
                    _state.value = _state.value.copy(
                        fetching = false,
                        error = "The server couldn't fetch any media from that link",
                    )
                    return@launch
                }
                // Bring the freshly-created post(s) down into the local library.
                SyncManager.sync(getApplication())
                SyncScheduler.requestOneShot(getApplication())
                _state.value = _state.value.copy(fetching = false, done = true)
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    fetching = false,
                    error = e.message ?: "Failed to fetch link",
                )
            }
        }
    }

    /**
     * Copy the picked media into app storage, queue it in the outbox (with an
     * offline-visible placeholder), then best-effort push+pull. Works offline:
     * if the server is unreachable the item stays queued and visible.
     */
    fun save() {
        val cur = _state.value
        val uri = cur.pickedUri ?: run {
            _state.value = cur.copy(error = "Pick an image or video first")
            return
        }
        _state.value = cur.copy(saving = true, error = null)
        viewModelScope.launch {
            try {
                val clientId = UUID.randomUUID().toString()
                val file = withContext(Dispatchers.IO) { copyToStorage(uri, clientId) }
                repo.enqueueNewPost(clientId, file, cur.tags, cur.safety, source = null)

                // Best-effort immediate sync; if offline, a worker retries online.
                SyncManager.sync(getApplication())
                SyncScheduler.requestOneShot(getApplication())
                _state.value = _state.value.copy(saving = false, done = true)
            } catch (e: Exception) {
                _state.value = _state.value.copy(saving = false, error = e.message ?: "Failed to save")
            }
        }
    }

    private fun copyToStorage(uri: Uri, clientId: String): File {
        val resolver = getApplication<Application>().contentResolver
        val mime = resolver.getType(uri) ?: "application/octet-stream"
        val ext = mimeToExt(mime)
            ?: throw IllegalArgumentException("Unsupported file type: $mime")
        val dir = File(getApplication<Application>().filesDir, "pending").apply { mkdirs() }
        val file = File(dir, "$clientId$ext")
        resolver.openInputStream(uri)?.use { input ->
            file.outputStream().use { output -> input.copyTo(output) }
        } ?: throw IllegalStateException("Could not read selected file")
        return file
    }

    private fun mimeToExt(mime: String): String? = when (mime) {
        "image/jpeg" -> ".jpg"
        "image/png" -> ".png"
        "image/gif" -> ".gif"
        "image/webp" -> ".webp"
        "video/mp4" -> ".mp4"
        "video/webm" -> ".webm"
        else -> null
    }
}
