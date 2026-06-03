package com.nekobooru.app.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface PostDao {
    @Query("SELECT * FROM posts WHERE deleted = 0 AND deletedAt IS NULL ORDER BY createdAt DESC")
    fun observeVisible(): Flow<List<PostEntity>>

    @Query("SELECT * FROM posts WHERE sha256 = :sha")
    fun observeBySha(sha: String): Flow<PostEntity?>

    @Query("UPDATE posts SET tags = :tags, safety = :safety, dirty = 1 WHERE sha256 = :sha")
    suspend fun updateMeta(sha: String, tags: String, safety: String)

    @Upsert
    suspend fun upsert(posts: List<PostEntity>)

    @Upsert
    suspend fun upsertOne(post: PostEntity)

    @Query("DELETE FROM posts WHERE sha256 = :sha")
    suspend fun deleteBySha(sha: String)

    @Query("UPDATE posts SET deleted = 1 WHERE sha256 = :sha")
    suspend fun markDeleted(sha: String)

    @Query("UPDATE posts SET isFavorited = :favorited WHERE sha256 = :sha")
    suspend fun setFavorite(sha: String, favorited: Boolean)

    @Query("SELECT COUNT(*) FROM posts")
    suspend fun count(): Int

    // --- retention (step 7) ---

    @Query("SELECT * FROM posts WHERE deleted = 0 AND deletedAt IS NULL")
    suspend fun allVisible(): List<PostEntity>

    @Query("SELECT * FROM posts WHERE sha256 = :sha")
    suspend fun getBySha(sha: String): PostEntity?

    @Query("UPDATE posts SET localOriginalPath = :path WHERE sha256 = :sha")
    suspend fun setLocalOriginal(sha: String, path: String?)

    @Query("UPDATE posts SET lastAccessedAt = :ts WHERE sha256 = :sha")
    suspend fun touchAccess(sha: String, ts: Long)
}

@Dao
interface PoolDao {
    @Query("SELECT * FROM pools WHERE deleted = 0 ORDER BY name COLLATE NOCASE ASC")
    fun observeVisible(): Flow<List<PoolEntity>>

    @Query("SELECT * FROM pools WHERE uuid = :uuid")
    fun observeByUuid(uuid: String): Flow<PoolEntity?>

    @Query("SELECT * FROM pools WHERE uuid = :uuid")
    suspend fun getByUuid(uuid: String): PoolEntity?

    @Query("SELECT * FROM pools WHERE deleted = 0")
    suspend fun getAll(): List<PoolEntity>

    @Upsert
    suspend fun upsert(pool: PoolEntity)

    @Query("DELETE FROM pools WHERE uuid = :uuid")
    suspend fun deleteByUuid(uuid: String)

    @Query("UPDATE pools SET deleted = 1 WHERE uuid = :uuid")
    suspend fun markDeleted(uuid: String)
}

@Dao
interface SyncStateDao {
    @Query("SELECT cursor FROM sync_state WHERE id = 0")
    suspend fun getCursor(): Long?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun setState(state: SyncStateEntity)
}

@Dao
interface OutboxDao {
    @Insert
    suspend fun insert(change: PendingChangeEntity): Long

    @Query("SELECT * FROM pending_changes ORDER BY id ASC")
    suspend fun all(): List<PendingChangeEntity>

    @Query("SELECT COUNT(*) FROM pending_changes")
    fun observeCount(): Flow<Int>

    @Query("DELETE FROM pending_changes WHERE id = :id")
    suspend fun delete(id: Long)
}
