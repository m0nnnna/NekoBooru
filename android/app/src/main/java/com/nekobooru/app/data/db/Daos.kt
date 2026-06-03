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

    @Upsert
    suspend fun upsert(posts: List<PostEntity>)

    @Query("UPDATE posts SET deleted = 1 WHERE sha256 = :sha")
    suspend fun markDeleted(sha: String)

    @Query("UPDATE posts SET isFavorited = :favorited WHERE sha256 = :sha")
    suspend fun setFavorite(sha: String, favorited: Boolean)

    @Query("SELECT COUNT(*) FROM posts")
    suspend fun count(): Int
}

@Dao
interface SyncStateDao {
    @Query("SELECT cursor FROM sync_state WHERE id = 0")
    suspend fun getCursor(): Long?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun setState(state: SyncStateEntity)
}
