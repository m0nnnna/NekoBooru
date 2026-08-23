package com.nekobooru.app.ui

import android.app.Application
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.ApiFactory
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.ConnectionTester
import com.nekobooru.app.data.OfflinePolicy
import com.nekobooru.app.data.RetentionManager
import com.nekobooru.app.data.SyncManager
import com.nekobooru.app.data.ThemeMode
import com.nekobooru.app.data.TokenLoginRequestDto
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.sync.SyncScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import retrofit2.HttpException

data class SettingsUiState(
    val serverUrl: String = AppSettings.DEFAULT_SERVER_URL,
    val accountUsername: String? = null,
    val loginUsername: String = "",
    val loginPassword: String = "",
    val loggingIn: Boolean = false,
    val offlinePolicy: OfflinePolicy = OfflinePolicy.RECENT_100,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val storageLabel: String = "App storage (private)",
    val cachedOriginals: Int = 0,
    val syncing: Boolean = false,
    val testing: Boolean = false,
    val migrating: Boolean = false,
    val lastSyncedAt: Long = 0,
    val message: String? = null,
) {
    val loggedIn: Boolean get() = !accountUsername.isNullOrBlank()
}

class SettingsViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = AppSettings(app)
    private val postDao = NekoDatabase.get(app).postDao()

    private val _state = MutableStateFlow(
        SettingsUiState(
            serverUrl = settings.serverUrl,
            accountUsername = settings.accountUsername,
            offlinePolicy = settings.offlinePolicy,
            themeMode = settings.themeMode,
            storageLabel = storageLabel(),
            lastSyncedAt = settings.lastSyncedAt,
        )
    )
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    init { refreshCachedCount() }

    /** Set (or clear, with null) the user storage folder; mirror into it next pass. */
    fun onStorageFolderChange(treeUri: String?) {
        settings.exportTreeUri = treeUri
        _state.value = _state.value.copy(storageLabel = storageLabel())
        SyncScheduler.requestOneShot(getApplication())
    }

    /** Move existing app-private originals into the chosen folder. */
    fun migrateToFolder() {
        _state.value = _state.value.copy(migrating = true, message = null)
        viewModelScope.launch {
            val moved = RetentionManager(getApplication()).migrateToExportFolder()
            refreshCachedCount()
            _state.value = _state.value.copy(
                migrating = false,
                message = "Moved $moved file(s) into the folder",
            )
        }
    }

    private fun storageLabel(): String {
        val uri = settings.exportTreeUri ?: return "App storage (private)"
        val name = runCatching {
            DocumentFile.fromTreeUri(getApplication(), Uri.parse(uri))?.name
        }.getOrNull()
        return name ?: "Custom folder"
    }

    fun onThemeChange(mode: ThemeMode) {
        _state.value = _state.value.copy(themeMode = mode)
        settings.themeMode = mode
        AppThemeState.mode.value = mode   // apply immediately app-wide
    }

    fun onServerUrlChange(url: String) {
        _state.value = _state.value.copy(serverUrl = url)
        settings.serverUrl = url
    }

    /** Change how much is mirrored offline; kicks a background pass to apply it. */
    fun onOfflinePolicyChange(policy: OfflinePolicy) {
        _state.value = _state.value.copy(offlinePolicy = policy)
        settings.offlinePolicy = policy
        // Download newly-needed originals (or evict) in the background.
        SyncScheduler.requestOneShot(getApplication())
    }

    /** Probe the server and report a precise diagnosis (does not change data). */
    fun testConnection() {
        _state.value = _state.value.copy(testing = true, message = null)
        viewModelScope.launch {
            val result = ConnectionTester.test(_state.value.serverUrl, settings.apiToken)
            _state.value = _state.value.copy(testing = false, message = result)
        }
    }

    fun onLoginUsernameChange(username: String) {
        _state.value = _state.value.copy(loginUsername = username)
    }

    fun onLoginPasswordChange(password: String) {
        _state.value = _state.value.copy(loginPassword = password)
    }

    /**
     * Log in against the configured server and store the token it returns.
     * Every endpoint (including sync and media) requires this now - there's
     * no session cookie fallback here, unlike the web UI, since a mobile app
     * has no cookie jar shared with a browser.
     */
    fun login() {
        val cur = _state.value
        val username = cur.loginUsername.trim()
        if (username.isEmpty() || cur.loginPassword.isEmpty()) {
            _state.value = cur.copy(message = "Enter your username and password.")
            return
        }
        _state.value = cur.copy(loggingIn = true, message = null)
        viewModelScope.launch {
            try {
                val api = ApiFactory.create(cur.serverUrl)
                val result = withContext(Dispatchers.IO) {
                    api.tokenLogin(TokenLoginRequestDto(username, cur.loginPassword, label = "Android"))
                }
                settings.apiToken = result.token
                settings.accountUsername = result.username
                _state.value = _state.value.copy(
                    loggingIn = false,
                    accountUsername = result.username,
                    loginPassword = "",
                    message = "Logged in as ${result.username}.",
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(loggingIn = false, message = "Could not log in: ${loginErrorMessage(e)}")
            }
        }
    }

    fun logout() {
        settings.apiToken = null
        settings.accountUsername = null
        _state.value = _state.value.copy(accountUsername = null, message = "Logged out.")
    }

    private fun loginErrorMessage(e: Exception): String = when {
        e is HttpException && e.code() == 401 -> "invalid username or password"
        e is HttpException && e.code() == 403 -> "that account has been deactivated"
        else -> e.message ?: e.javaClass.simpleName
    }

    /**
     * Manual "Sync now": runs the quick interactive pass (push/pull + thumbnails)
     * and enqueues the background worker to mirror originals per the policy.
     */
    fun syncNow() {
        _state.value = _state.value.copy(syncing = true, message = null)
        viewModelScope.launch {
            val result = SyncManager.sync(getApplication())
            _state.value = _state.value.copy(
                syncing = false,
                lastSyncedAt = settings.lastSyncedAt,
                message = result.fold({ "Synced" }, { it.message ?: "Sync failed" }),
            )
            refreshCachedCount()
            SyncScheduler.ensureScheduled(getApplication())
            SyncScheduler.requestOneShot(getApplication())   // mirror originals in the background
        }
    }

    private fun refreshCachedCount() {
        viewModelScope.launch {
            _state.value = _state.value.copy(cachedOriginals = postDao.cachedOriginalCount())
        }
    }
}
