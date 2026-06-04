package com.nekobooru.app.data

import android.content.Context

/** Original-file caching policy (thumbnails are always cached locally on sync). */
enum class Retention {
    /** Pre-download originals for every post. */
    EVERYTHING,
    /** Pre-download favorited/pooled originals; cache others on view (LRU). */
    FAVORITES_POOLS,
    /** Don't pre-fetch; download originals when viewed and evict by LRU. */
    ON_DEMAND;

    companion object {
        fun from(name: String?): Retention =
            entries.firstOrNull { it.name == name } ?: ON_DEMAND
    }
}

/** App theme, mirroring the website's light/dark toggle. */
enum class ThemeMode {
    SYSTEM, LIGHT, DARK;

    companion object {
        fun from(name: String?): ThemeMode = entries.firstOrNull { it.name == name } ?: SYSTEM
    }
}

/** Safety/sensitivity levels a post can have (matches the backend). */
enum class Safety(val label: String) {
    SAFE("safe"), SKETCHY("sketchy"), UNSAFE("unsafe");

    companion object {
        val ALL: Set<String> = entries.map { it.label }.toSet()
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

    var themeMode: ThemeMode
        get() = ThemeMode.from(prefs.getString(KEY_THEME, null))
        set(value) = prefs.edit().putString(KEY_THEME, value.name).apply()

    /** Which safety levels are shown in the gallery. Defaults to all visible. */
    var visibleSafety: Set<String>
        get() = prefs.getStringSet(KEY_VISIBLE_SAFETY, null) ?: Safety.ALL
        set(value) = prefs.edit().putStringSet(KEY_VISIBLE_SAFETY, value).apply()

    /** Epoch millis of the last successful pull, or 0 if never synced. */
    var lastSyncedAt: Long
        get() = prefs.getLong(KEY_LAST_SYNCED, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_SYNCED, value).apply()

    companion object {
        const val DEFAULT_SERVER_URL = "http://10.0.2.2:8000"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_RETENTION = "retention"
        private const val KEY_THEME = "theme_mode"
        private const val KEY_VISIBLE_SAFETY = "visible_safety"
        private const val KEY_LAST_SYNCED = "last_synced_at"
    }
}
