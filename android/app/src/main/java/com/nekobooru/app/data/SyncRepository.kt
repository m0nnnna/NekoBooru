package com.nekobooru.app.data

import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PendingChangeEntity
import com.nekobooru.app.data.db.PoolEntity
import com.nekobooru.app.data.db.PostEntity
import com.nekobooru.app.data.db.SyncStateEntity
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.time.Instant
import java.util.UUID

/**
 * Drives the client side of sync. This increment implements the **pull** half:
 * consume /api/sync/changes from the saved cursor and apply post/favorite
 * changes into Room. Push (offline writes) arrives in a later increment.
 */
class SyncRepository(private val db: NekoDatabase) {

    val postDao = db.postDao()
    val poolDao = db.poolDao()
    val outboxDao = db.outboxDao()

    /**
     * Queue a newly added post: store the media in a stable local file, add an
     * outbox entry, and insert a placeholder post (keyed ``pending-<clientId>``)
     * so it shows in the gallery immediately, even offline.
     */
    suspend fun enqueueNewPost(
        clientId: String,
        file: File,
        tags: List<String>,
        safety: String,
        source: String?,
    ) {
        val tagStr = tags.joinToString(" ")
        outboxDao.insert(
            PendingChangeEntity(
                type = "post",
                op = "upsert",
                clientId = clientId,
                localMediaPath = file.absolutePath,
                tags = tagStr,
                safety = safety,
                source = source,
            )
        )
        val now = Instant.now().toString()
        postDao.upsertOne(
            PostEntity(
                sha256 = "pending-$clientId",
                serverId = null,
                filename = file.name,
                extension = "." + file.extension.lowercase(),
                fileSize = file.length(),
                width = null, height = null, duration = null,
                safety = safety,
                source = source,
                createdAt = now,
                updatedAt = now,
                deletedAt = null,
                tags = tagStr,
                isFavorited = false,
                thumbUrl = "",
                contentUrl = "",
                dirty = true,
                deleted = false,
                localMediaPath = file.absolutePath,
            )
        )
    }

    /** Edit tags/safety of an existing (synced) post; applies locally + queues. */
    suspend fun enqueueEdit(sha: String, tags: List<String>, safety: String) {
        val tagStr = tags.joinToString(" ")
        postDao.updateMeta(sha, tagStr, safety)
        outboxDao.insert(
            PendingChangeEntity(
                type = "post", op = "upsert", clientId = UUID.randomUUID().toString(),
                sha256 = sha, tags = tagStr, safety = safety,
            )
        )
    }

    /** Soft-delete a post locally + queue the deletion to propagate as a tombstone. */
    suspend fun enqueueDelete(sha: String) {
        postDao.markDeleted(sha)
        outboxDao.insert(
            PendingChangeEntity(
                type = "post", op = "delete", clientId = UUID.randomUUID().toString(),
                sha256 = sha,
            )
        )
    }

    /** Toggle favorite locally + queue. */
    suspend fun enqueueFavorite(sha: String, favorited: Boolean) {
        postDao.setFavorite(sha, favorited)
        outboxDao.insert(
            PendingChangeEntity(
                type = "favorite", op = if (favorited) "upsert" else "delete",
                clientId = UUID.randomUUID().toString(), sha256 = sha,
            )
        )
    }

    /**
     * Create or update a pool locally (marking it dirty) and queue the change.
     * Pass the full ordered member list; the server reconciles membership to it.
     */
    suspend fun enqueuePoolUpsert(
        uuid: String,
        name: String,
        description: String?,
        members: List<String>,
    ) {
        val existing = poolDao.getByUuid(uuid)
        val now = Instant.now().toString()
        poolDao.upsert(
            PoolEntity(
                uuid = uuid,
                serverId = existing?.serverId,
                name = name,
                description = description,
                createdAt = existing?.createdAt ?: now,
                updatedAt = now,
                postSha256sCsv = PoolEntity.csv(members),
                dirty = true,
                deleted = false,
            )
        )
        outboxDao.insert(
            PendingChangeEntity(
                type = "pool", op = "upsert", clientId = UUID.randomUUID().toString(),
                uuid = uuid, name = name, description = description,
                postSha256sCsv = PoolEntity.csv(members),
            )
        )
    }

    /** Add a post to a pool (creating the pool if it doesn't exist) + queue. */
    suspend fun addPostToPool(uuid: String, sha: String) {
        val pool = poolDao.getByUuid(uuid) ?: return
        if (sha in pool.postSha256s) return
        enqueuePoolUpsert(uuid, pool.name, pool.description, pool.postSha256s + sha)
    }

    /** Soft-delete a pool locally + queue the deletion. */
    suspend fun enqueuePoolDelete(uuid: String) {
        poolDao.markDeleted(uuid)
        outboxDao.insert(
            PendingChangeEntity(
                type = "pool", op = "delete", clientId = UUID.randomUUID().toString(),
                uuid = uuid,
            )
        )
    }

    /**
     * Push queued offline changes home. New posts upload their file via
     * /api/uploads, then POST /api/sync/push (server dedups by hash). On
     * success the placeholder is removed and the canonical post arrives via the
     * next [pull]. Returns the number of changes successfully pushed.
     */
    suspend fun push(serverUrl: String): Int {
        val api = ApiFactory.create(serverUrl)
        var pushed = 0
        for (c in outboxDao.all()) {
            val ok = when {
                // New post: upload the file, then create on the server (dedup by hash).
                c.type == "post" && c.op == "upsert" && c.localMediaPath != null -> {
                    val file = File(c.localMediaPath)
                    if (!file.exists()) {
                        outboxDao.delete(c.id); continue
                    }
                    val token = uploadFile(api, file)
                    val status = pushOne(
                        api, PushChangeDto(
                            type = "post", op = "upsert", clientId = c.clientId,
                            contentToken = token, tags = c.tagList,
                            safety = c.safety, source = c.source,
                        )
                    )
                    if (status == "created" || status == "deduped") {
                        postDao.deleteBySha("pending-${c.clientId}")
                        file.delete()
                        true
                    } else false
                }
                // Metadata edit of an existing post (no updatedAt -> client change wins).
                c.type == "post" && c.op == "upsert" && c.sha256 != null -> {
                    val status = pushOne(
                        api, PushChangeDto(
                            type = "post", op = "upsert", sha256 = c.sha256,
                            tags = c.tagList, safety = c.safety,
                        )
                    )
                    status != null && status != "error"
                }
                // Delete (soft-delete on the server, propagates as a tombstone).
                c.type == "post" && c.op == "delete" && c.sha256 != null -> {
                    val status = pushOne(api, PushChangeDto(type = "post", op = "delete", sha256 = c.sha256))
                    status != null && status != "error"
                }
                // Favorite toggle.
                c.type == "favorite" && c.sha256 != null -> {
                    val status = pushOne(api, PushChangeDto(type = "favorite", op = c.op, sha256 = c.sha256))
                    status != null && status != "error"
                }
                // Pool create/update (full membership reconcile) or delete.
                c.type == "pool" && c.op == "upsert" && c.uuid != null -> {
                    val status = pushOne(
                        api, PushChangeDto(
                            type = "pool", op = "upsert", uuid = c.uuid,
                            name = c.name, description = c.description,
                            postSha256s = c.poolMembers,
                        )
                    )
                    if (status != null && status != "error") {
                        // Clear the dirty flag now that the server has it.
                        poolDao.getByUuid(c.uuid)?.let { poolDao.upsert(it.copy(dirty = false)) }
                        true
                    } else false
                }
                c.type == "pool" && c.op == "delete" && c.uuid != null -> {
                    val status = pushOne(api, PushChangeDto(type = "pool", op = "delete", uuid = c.uuid))
                    if (status != null && status != "error") {
                        poolDao.deleteByUuid(c.uuid)
                        true
                    } else false
                }
                else -> true // unknown/empty entry: drop it
            }
            if (ok) {
                outboxDao.delete(c.id)
                pushed++
            }
        }
        return pushed
    }

    private suspend fun pushOne(api: NekoBooruApi, change: PushChangeDto): String? =
        api.push(PushRequestDto(listOf(change))).results.firstOrNull()?.status

    private suspend fun uploadFile(api: NekoBooruApi, file: File): String {
        val mime = when (file.extension.lowercase()) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "mp4" -> "video/mp4"
            "webm" -> "video/webm"
            else -> "application/octet-stream"
        }
        val part = MultipartBody.Part.createFormData(
            "content", file.name, file.asRequestBody(mime.toMediaType()),
        )
        return api.upload(part).token
    }

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
        // Preserve local-only cache columns across upserts (an upsert replaces the
        // whole row, which would otherwise wipe cached thumb/original paths and
        // force a re-download every sync).
        val localPaths = postDao.localPaths().associateBy { it.sha256 }
        val toUpsert = mutableListOf<PostEntity>()
        for (ch in changes) {
            when (ch.type) {
                "post" -> {
                    if (ch.op == "delete") {
                        postDao.markDeleted(ch.key)
                    } else if (ch.data != null) {
                        val dto = ApiFactory.json.decodeFromJsonElement<PostDto>(ch.data)
                        val local = localPaths[dto.sha256]
                        toUpsert += dto.toEntity().copy(
                            localThumbPath = local?.localThumbPath,
                            localOriginalPath = local?.localOriginalPath,
                            lastAccessedAt = local?.lastAccessedAt ?: 0,
                        )
                    }
                }
                "favorite" -> postDao.setFavorite(ch.key, ch.op == "upsert")
                "pool" -> {
                    if (ch.op == "delete") {
                        poolDao.deleteByUuid(ch.key)
                    } else if (ch.data != null) {
                        val dto = ApiFactory.json.decodeFromJsonElement<PoolSyncDto>(ch.data)
                        val local = poolDao.getByUuid(dto.uuid)
                        // Don't clobber a locally dirty pool with the server copy;
                        // our queued push will reconcile it (client edit wins).
                        if (local?.dirty != true) {
                            poolDao.upsert(
                                PoolEntity(
                                    uuid = dto.uuid,
                                    serverId = dto.id,
                                    name = dto.name,
                                    description = dto.description,
                                    createdAt = dto.createdAt,
                                    updatedAt = dto.updatedAt,
                                    postSha256sCsv = PoolEntity.csv(dto.postSha256s),
                                    dirty = false,
                                    deleted = false,
                                )
                            )
                        }
                    }
                }
                // tags / notes / comments: niche on a phone, deferred
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
