package com.nekobooru.app.ui

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.SyncManager
import com.nekobooru.app.data.SyncRepository
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.sync.SyncScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

data class AddUiState(
    val pickedUri: Uri? = null,
    val tags: String = "",
    val safety: String = "safe",
    val saving: Boolean = false,
    val error: String? = null,
    val done: Boolean = false,
)

class AddViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = SyncRepository(NekoDatabase.get(app))

    private val _state = MutableStateFlow(AddUiState())
    val state: StateFlow<AddUiState> = _state.asStateFlow()

    /** Clear state so the screen is fresh next time it's opened. */
    fun reset() { _state.value = AddUiState() }

    fun onPicked(uri: Uri) { _state.value = _state.value.copy(pickedUri = uri, error = null) }
    fun onTagsChange(t: String) { _state.value = _state.value.copy(tags = t) }
    fun onSafetyChange(s: String) { _state.value = _state.value.copy(safety = s) }

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
                val tags = cur.tags.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
                repo.enqueueNewPost(clientId, file, tags, cur.safety, source = null)

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
