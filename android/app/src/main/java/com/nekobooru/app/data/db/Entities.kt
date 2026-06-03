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
) {
    val isVideo: Boolean get() = extension == ".mp4" || extension == ".webm"
    val tagList: List<String> get() = if (tags.isBlank()) emptyList() else tags.split(" ")
}

/** Single-row table holding the last applied sync cursor. */
@Entity(tableName = "sync_state")
data class SyncStateEntity(
    @PrimaryKey val id: Int = 0,
    val cursor: Long = 0,
)
