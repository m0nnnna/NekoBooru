package com.nekobooru.app.data.db

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Local mirror of a server post. Keyed by sha256 (the cross-device stable id).
 * Some columns (dirty/deleted/localMediaPath) support later offline-write steps
 * and are unused by the read-only pull in this increment.
 */
@Entity(tableName = "posts")
data class PostEntity(
    @PrimaryKey val sha256: String,
    val serverId: Int?,
    val filename: String?,
    val extension: String?,
    val fileSize: Long,
    val width: Int?,
    val height: Int?,
    val duration: Double?,
    val safety: String,
    val source: String?,
    val createdAt: String?,
    val updatedAt: String?,
    val deletedAt: String?,
    val tags: String,          // space-separated tag names
    val isFavorited: Boolean,
    val thumbUrl: String,
    val contentUrl: String,
    // local-only fields (future increments)
    val dirty: Boolean = false,
    val deleted: Boolean = false,
    val localMediaPath: String? = null,
    // retention (step 7): cached original file + LRU access time for ON_DEMAND eviction.
    val localOriginalPath: String? = null,
    val lastAccessedAt: Long = 0,
) {
    val isVideo: Boolean get() = extension == ".mp4" || extension == ".webm"
    val tagList: List<String> get() = if (tags.isBlank()) emptyList() else tags.split(" ")
}

/**
 * Local mirror of a server pool, keyed by uuid (the cross-device stable id).
 * Membership is stored as an ordered CSV of post sha256s (mirrors the server's
 * ``postSha256s``). ``dirty`` marks a locally-changed pool awaiting push.
 */
@Entity(tableName = "pools")
data class PoolEntity(
    @PrimaryKey val uuid: String,
    val serverId: Int?,
    val name: String,
    val description: String?,
    val createdAt: String?,
    val updatedAt: String?,
    val postSha256sCsv: String,   // ordered, comma-separated sha256s
    val dirty: Boolean = false,
    val deleted: Boolean = false,
) {
    val postSha256s: List<String>
        get() = if (postSha256sCsv.isBlank()) emptyList() else postSha256sCsv.split(",")

    companion object {
        fun csv(shas: List<String>): String = shas.filter { it.isNotBlank() }.joinToString(",")
    }
}

/** Single-row table holding the last applied sync cursor. */
@Entity(tableName = "sync_state")
data class SyncStateEntity(
    @PrimaryKey val id: Int = 0,
    val cursor: Long = 0,
)

/**
 * Outbox of changes made while offline, to be pushed when the server is
 * reachable. This increment uses it for newly added posts (op=upsert with a
 * local media file); edits/deletes reuse it in the next increment.
 */
@Entity(tableName = "pending_changes")
data class PendingChangeEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val type: String,                 // "post" | "favorite" | "pool"
    val op: String,                   // "upsert" | "delete"
    val clientId: String,             // stable client id for a new post
    val sha256: String? = null,       // for edits/deletes of known posts
    val localMediaPath: String? = null, // file to upload for new posts
    val tags: String = "",            // space-separated
    val safety: String = "safe",
    val source: String? = null,
    // pool payload (type == "pool")
    val uuid: String? = null,
    val name: String? = null,
    val description: String? = null,
    val postSha256sCsv: String? = null, // ordered, comma-separated members
    val createdAt: Long = System.currentTimeMillis(),
) {
    val tagList: List<String> get() = if (tags.isBlank()) emptyList() else tags.split(" ")
    val poolMembers: List<String>
        get() = postSha256sCsv?.takeIf { it.isNotBlank() }?.split(",") ?: emptyList()
}
