package com.nekobooru.app.data

import android.content.Context

/** Original-file caching policy (thumbnails are always cached via Coil). */
enum class Retention {
    /** Keep originals for every post locally. */
    EVERYTHING,
    /** Keep originals only for favorited or pooled posts; evict the rest. */
    FAVORITES_POOLS,
    /** Don't pre-fetch; download originals when viewed and evict by LRU. */
    ON_DEMAND;

    companion object {
        fun from(name: String?): Retention =
            entries.firstOrNull { it.name == name } ?: FAVORITES_POOLS
    }
}

/**
 * Minimal persisted settings backed by SharedPreferences.
 * Default server URL points at the Android emulator's host-loopback so a dev
 * server on the same machine is reachable out of the box.
 */
class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("nekobooru", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value).apply()

    var retention: Retention
        get() = Retention.from(prefs.getString(KEY_RETENTION, null))
        set(value) = prefs.edit().putString(KEY_RETENTION, value.name).apply()

    /** Epoch millis of the last successful pull, or 0 if never synced. */
    var lastSyncedAt: Long
        get() = prefs.getLong(KEY_LAST_SYNCED, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_SYNCED, value).apply()

    companion object {
        const val DEFAULT_SERVER_URL = "http://10.0.2.2:8000"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_RETENTION = "retention"
        private const val KEY_LAST_SYNCED = "last_synced_at"
    }
}
