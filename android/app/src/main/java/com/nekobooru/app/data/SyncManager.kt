package com.nekobooru.app.data

import android.content.Context
import com.nekobooru.app.data.db.NekoDatabase

/**
 * One entry point for a full sync cycle: push queued offline changes, pull
 * server changes, stamp the last-synced time, then apply the retention policy.
 * Shared by the manual "Sync" button, per-edit best-effort syncs, and the
 * background [SyncWorker].
 */
object SyncManager {

    /**
     * Run a full sync against the configured server. Returns a [Result]; on
     * failure the queued changes simply stay in the outbox for next time.
     */
    suspend fun sync(context: Context): Result<Unit> {
        val appContext = context.applicationContext
        val settings = AppSettings(appContext)
        val repo = SyncRepository(NekoDatabase.get(appContext))
        val url = settings.serverUrl
        return runCatching {
            repo.push(url)
            repo.pull(url)
            settings.lastSyncedAt = System.currentTimeMillis()
            // Retention is best-effort and must not fail the sync.
            runCatching { RetentionManager(appContext).run(url, settings.retention) }
        }
    }
}
