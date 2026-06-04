package com.nekobooru.app

import android.app.Application
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.sync.SyncScheduler
import com.nekobooru.app.ui.AppThemeState

class NekoApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Seed the theme from saved settings before any UI is drawn.
        AppThemeState.mode.value = AppSettings(this).themeMode
        // Primary auto-sync trigger; the manual "Sync" button remains available.
        SyncScheduler.ensureScheduled(this)
    }
}
