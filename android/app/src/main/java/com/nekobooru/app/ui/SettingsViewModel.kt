package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.ConnectionTester
import com.nekobooru.app.data.Retention
import com.nekobooru.app.data.SyncManager
import com.nekobooru.app.data.ThemeMode
import com.nekobooru.app.sync.SyncScheduler
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class SettingsUiState(
    val serverUrl: String = AppSettings.DEFAULT_SERVER_URL,
    val retention: Retention = Retention.ON_DEMAND,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val syncing: Boolean = false,
    val testing: Boolean = false,
    val lastSyncedAt: Long = 0,
    val message: String? = null,
)

class SettingsViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = AppSettings(app)

    private val _state = MutableStateFlow(
        SettingsUiState(
            serverUrl = settings.serverUrl,
            retention = settings.retention,
            themeMode = settings.themeMode,
            lastSyncedAt = settings.lastSyncedAt,
        )
    )
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    fun onThemeChange(mode: ThemeMode) {
        _state.value = _state.value.copy(themeMode = mode)
        settings.themeMode = mode
        AppThemeState.mode.value = mode   // apply immediately app-wide
    }

    fun onServerUrlChange(url: String) {
        _state.value = _state.value.copy(serverUrl = url)
        settings.serverUrl = url
    }

    fun onRetentionChange(retention: Retention) {
        _state.value = _state.value.copy(retention = retention)
        settings.retention = retention
    }

    /** Probe the server and report a precise diagnosis (does not change data). */
    fun testConnection() {
        _state.value = _state.value.copy(testing = true, message = null)
        viewModelScope.launch {
            val result = ConnectionTester.test(_state.value.serverUrl)
            _state.value = _state.value.copy(testing = false, message = result)
        }
    }

    /** Manual "Sync now"; reschedules retention as a side effect of the policy. */
    fun syncNow() {
        _state.value = _state.value.copy(syncing = true, message = null)
        viewModelScope.launch {
            val result = SyncManager.sync(getApplication())
            _state.value = _state.value.copy(
                syncing = false,
                lastSyncedAt = settings.lastSyncedAt,
                message = result.fold({ "Synced" }, { it.message ?: "Sync failed" }),
            )
            // Make sure background sync is scheduled (idempotent).
            SyncScheduler.ensureScheduled(getApplication())
        }
    }
}
