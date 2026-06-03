package com.nekobooru.app.data

import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PostEntity
import com.nekobooru.app.data.db.SyncStateEntity
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * Drives the client side of sync. This increment implements the **pull** half:
 * consume /api/sync/changes from the saved cursor and apply post/favorite
 * changes into Room. Push (offline writes) arrives in a later increment.
 */
class SyncRepository(private val db: NekoDatabase) {

    val postDao = db.postDao()

    /** Pull all changes since the saved cursor into the local DB. */
    suspend fun pull(serverUrl: String) {
        val api = ApiFactory.create(serverUrl)
        val syncDao = db.syncStateDao()
        var cursor = syncDao.getCursor() ?: 0L

        while (true) {
            val resp = api.getChanges(since = cursor, limit = 500)
            applyChanges(resp.changes)
            cursor = resp.cursor
            syncDao.setState(SyncStateEntity(id = 0, cursor = cursor))
            if (!resp.hasMore) break
        }
    }

    private suspend fun applyChanges(changes: List<SyncChange>) {
        val toUpsert = mutableListOf<PostEntity>()
        for (ch in changes) {
            when (ch.type) {
                "post" -> {
                    if (ch.op == "delete") {
                        postDao.markDeleted(ch.key)
                    } else if (ch.data != null) {
                        val dto = ApiFactory.json.decodeFromJsonElement<PostDto>(ch.data)
                        toUpsert += dto.toEntity()
                    }
                }
                "favorite" -> postDao.setFavorite(ch.key, ch.op == "upsert")
                // tags / pools / notes / comments: applied in later increments
                else -> Unit
            }
        }
        if (toUpsert.isNotEmpty()) postDao.upsert(toUpsert)
    }
}

private fun PostDto.toEntity(): PostEntity = PostEntity(
    sha256 = sha256,
    serverId = id,
    filename = filename,
    extension = extension,
    fileSize = fileSize,
    width = width,
    height = height,
    duration = duration,
    safety = safety,
    source = source,
    createdAt = createdAt,
    updatedAt = updatedAt,
    deletedAt = deletedAt,
    tags = tags.joinToString(" "),
    isFavorited = isFavorited,
    thumbUrl = thumbUrl,
    contentUrl = contentUrl,
)
