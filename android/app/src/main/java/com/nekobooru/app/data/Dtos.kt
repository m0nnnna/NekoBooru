package com.nekobooru.app.data

import kotlinx.serialization.Serializable

/** Mirrors the backend's Post.to_dict() (see backend/app/models/post.py). */
@Serializable
data class PostDto(
    val id: Int,
    val sha256: String,
    val filename: String? = null,
    val extension: String? = null,
    val fileSize: Long = 0,
    val width: Int? = null,
    val height: Int? = null,
    val duration: Double? = null,
    val safety: String = "safe",
    val source: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val deletedAt: String? = null,
    val tags: List<String> = emptyList(),
    val isFavorited: Boolean = false,
    val contentUrl: String = "",
    val thumbUrl: String = "",
) {
    val isVideo: Boolean
        get() = extension == ".mp4" || extension == ".webm"
}

@Serializable
data class PostListResponse(
    val results: List<PostDto> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val limit: Int = 42,
    val pages: Int = 0,
)

@Serializable
data class HealthDto(
    val status: String = "",
    val service: String = "",
)
