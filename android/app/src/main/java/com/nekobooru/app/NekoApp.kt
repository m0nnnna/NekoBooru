package com.nekobooru.app

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.sync.SyncScheduler
import com.nekobooru.app.ui.AppThemeState
import okhttp3.OkHttpClient

class NekoApp : Application(), ImageLoaderFactory {
    override fun onCreate() {
        super.onCreate()
        // Seed the theme from saved settings before any UI is drawn.
        AppThemeState.mode.value = AppSettings(this).themeMode
        // Primary auto-sync trigger; the manual "Sync" button remains available.
        SyncScheduler.ensureScheduled(this)
    }

    /**
     * App-wide Coil loader with generous caches so the thumbnail grid stays
     * smooth over a large library: decoded thumbnails stay in memory while
     * scrolling, and the disk cache avoids re-reads. Crossfade off to cut
     * per-frame work during fling.
     */
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .okHttpClient {
                // Thumbnails/originals require a logged-in user now (see
                // /api/media/*). Re-reads the token per request rather than
                // baking one client in at startup, so logging in/out takes
                // effect without rebuilding this loader.
                OkHttpClient.Builder()
                    .addInterceptor { chain ->
                        val token = AppSettings(this).apiToken
                        val request = if (!token.isNullOrBlank()) {
                            chain.request().newBuilder().header("Authorization", "Bearer $token").build()
                        } else {
                            chain.request()
                        }
                        chain.proceed(request)
                    }
                    .build()
            }
            .memoryCache {
                MemoryCache.Builder(this).maxSizePercent(0.30).build()
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(cacheDir.resolve("image_cache"))
                    .maxSizeBytes(256L * 1024 * 1024)
                    .build()
            }
            .crossfade(false)
            .build()
}
