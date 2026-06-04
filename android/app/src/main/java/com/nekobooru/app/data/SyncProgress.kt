package com.nekobooru.app.data

import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Process-wide progress for the background offline-cache pass, surfaced in the
 * UI so a long sync shows a live count instead of an opaque spinner.
 */
object SyncProgress {
    data class Info(val phase: String, val done: Int, val total: Int)

    val state = MutableStateFlow<Info?>(null)

    fun report(phase: String, done: Int, total: Int) {
        state.value = if (total > 0) Info(phase, done, total) else null
    }

    fun clear() { state.value = null }
}
