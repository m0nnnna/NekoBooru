package com.nekobooru.app.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [PostEntity::class, PoolEntity::class, SyncStateEntity::class, PendingChangeEntity::class],
    version = 3,
    exportSchema = false,
)
abstract class NekoDatabase : RoomDatabase() {
    abstract fun postDao(): PostDao
    abstract fun poolDao(): PoolDao
    abstract fun syncStateDao(): SyncStateDao
    abstract fun outboxDao(): OutboxDao

    companion object {
        @Volatile
        private var instance: NekoDatabase? = null

        fun get(context: Context): NekoDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    NekoDatabase::class.java,
                    "nekobooru.db",
                ).fallbackToDestructiveMigration().build().also { instance = it }
            }
    }
}
