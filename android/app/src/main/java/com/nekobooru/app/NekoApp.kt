package com.nekobooru.app

import android.app.Application
import com.nekobooru.app.sync.SyncScheduler

class NekoApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Primary auto-sync trigger; the manual "Sync" button remains available.
        SyncScheduler.ensureScheduled(this)
    }
}
