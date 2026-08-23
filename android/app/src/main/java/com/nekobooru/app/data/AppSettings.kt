package com.nekobooru.app.data

import android.content.Context

/**
 * How much of the library to mirror offline (full original files). Thumbnails
 * for every synced post are always cached regardless, so the whole gallery
 * browses offline; this governs the large originals. ``limit == null`` means a
 * complete mirror of the server's media directory, however large.
 */
enum class OfflinePolicy(val limit: Int?, val label: String) {
    RECENT_50(50, "50 most recent"),
    RECENT_100(100, "100 most recent"),
    RECENT_500(500, "500 most recent"),
    EVERYTHING(null, "Everything");

    companion object {
        fun from(name: String?): OfflinePolicy =
            entries.firstOrNull { it.name == name } ?: RECENT_100
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

    var offlinePolicy: OfflinePolicy
        get() = OfflinePolicy.from(prefs.getString(KEY_OFFLINE, null))
        set(value) = prefs.edit().putString(KEY_OFFLINE, value.name).apply()

    var themeMode: ThemeMode
        get() = ThemeMode.from(prefs.getString(KEY_THEME, null))
        set(value) = prefs.edit().putString(KEY_THEME, value.name).apply()

    /**
     * SAF tree URI of a user-chosen folder where original files are stored so
     * they live in a normal folder accessible by other apps. Null = app-private.
     */
    var exportTreeUri: String?
        get() = prefs.getString(KEY_EXPORT_TREE, null)
        set(value) = prefs.edit().putString(KEY_EXPORT_TREE, value).apply()

    /** Which safety levels are shown in the gallery. Defaults to all visible. */
    var visibleSafety: Set<String>
        get() = prefs.getStringSet(KEY_VISIBLE_SAFETY, null) ?: Safety.ALL
        set(value) = prefs.edit().putStringSet(KEY_VISIBLE_SAFETY, value).apply()

    /** Epoch millis of the last successful pull, or 0 if never synced. */
    var lastSyncedAt: Long
        get() = prefs.getLong(KEY_LAST_SYNCED, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_SYNCED, value).apply()

    /**
     * Bearer token for this account, obtained by logging in against the server
     * (Settings > Account). Every NekoBooru endpoint requires a logged-in user
     * now, so this is attached as `Authorization: Bearer <token>` on every
     * request the app makes - see [com.nekobooru.app.data.ApiFactory].
     */
    var apiToken: String?
        get() = prefs.getString(KEY_API_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_API_TOKEN, value).apply()

    /** Username shown in Settings once logged in; purely cosmetic. */
    var accountUsername: String?
        get() = prefs.getString(KEY_ACCOUNT_USERNAME, null)
        set(value) = prefs.edit().putString(KEY_ACCOUNT_USERNAME, value).apply()

    companion object {
        const val DEFAULT_SERVER_URL = "http://10.0.2.2:8000"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_OFFLINE = "offline_policy"
        private const val KEY_EXPORT_TREE = "export_tree_uri"
        private const val KEY_THEME = "theme_mode"
        private const val KEY_VISIBLE_SAFETY = "visible_safety"
        private const val KEY_LAST_SYNCED = "last_synced_at"
        private const val KEY_API_TOKEN = "api_token"
        private const val KEY_ACCOUNT_USERNAME = "account_username"
    }
}
