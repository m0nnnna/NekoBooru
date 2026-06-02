package com.nekobooru.app.data

import android.content.Context

/**
 * Minimal persisted settings (server URL) backed by SharedPreferences.
 * Default points at the Android emulator's host-loopback so a dev server on
 * the same machine is reachable out of the box.
 */
class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("nekobooru", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value).apply()

    companion object {
        const val DEFAULT_SERVER_URL = "http://10.0.2.2:8000"
        private const val KEY_SERVER_URL = "server_url"
    }
}
