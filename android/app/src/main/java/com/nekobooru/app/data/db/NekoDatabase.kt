package com.nekobooru.app.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [PostEntity::class, SyncStateEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class NekoDatabase : RoomDatabase() {
    abstract fun postDao(): PostDao
    abstract fun syncStateDao(): SyncStateDao

    companion object {
        @Volatile
        private var instance: NekoDatabase? = null

        fun get(context: Context): NekoDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    NekoDatabase::class.java,
                    "nekobooru.db",
                ).build().also { instance = it }
            }
    }
}
