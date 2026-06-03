package com.nekobooru.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Response of GET /api/sync/changes (see backend/app/routers/sync.py). */
@Serializable
data class SyncChangesResponse(
    val cursor: Long = 0,
    val hasMore: Boolean = false,
    val changes: List<SyncChange> = emptyList(),
)

/**
 * One collapsed change. ``data`` is present for upserts and shape depends on
 * ``type`` (a post dict, tag dict, etc.); absent for deletes and favorites.
 */
@Serializable
data class SyncChange(
    val type: String,
    val op: String,        // "upsert" | "delete"
    val key: String,
    val data: JsonElement? = null,
)
