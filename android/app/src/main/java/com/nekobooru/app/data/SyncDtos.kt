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

/** Token returned by POST /api/uploads. */
@Serializable
data class UploadTokenDto(val token: String)

/** One change pushed to POST /api/sync/push (see backend PushChange). */
@Serializable
data class PushChangeDto(
    val type: String,
    val op: String = "upsert",
    val clientId: String? = null,
    val sha256: String? = null,
    val contentToken: String? = null,
    val tags: List<String>? = null,
    val safety: String? = null,
    val source: String? = null,
    // pool / note / comment stable id + linkage
    val uuid: String? = null,
    val name: String? = null,
    val description: String? = null,
    val postSha256: String? = null,
    val postSha256s: List<String>? = null,
    val text: String? = null,
    val x: Float? = null,
    val y: Float? = null,
    val width: Float? = null,
    val height: Float? = null,
    val updatedAt: String? = null,
)

/** Shape of a ``pool`` change's ``data`` from GET /api/sync/changes (see _serialize_pool). */
@Serializable
data class PoolSyncDto(
    val id: Int? = null,
    val uuid: String,
    val name: String,
    val description: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val postSha256s: List<String> = emptyList(),
)

@Serializable
data class PushRequestDto(val changes: List<PushChangeDto>)

@Serializable
data class PushResultDto(
    val clientId: String? = null,
    val type: String = "",
    val sha256: String? = null,
    val serverId: Int? = null,
    val status: String = "",
    val message: String? = null,
)

@Serializable
data class PushResponseDto(
    val cursor: Long = 0,
    val results: List<PushResultDto> = emptyList(),
)
