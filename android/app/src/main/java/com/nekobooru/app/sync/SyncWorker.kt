package com.nekobooru.app.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.nekobooru.app.data.SyncManager
import java.io.IOException

/**
 * Background sync job: push queued offline changes, pull server changes, and
 * apply the retention policy (all via [SyncManager]). Retried on network errors
 * so offline edits flush automatically once the server is reachable again.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        // Background pass mirrors originals offline per the policy (can be large).
        val result = SyncManager.sync(applicationContext, downloadOriginals = true)
        return result.fold(
            onSuccess = { Result.success() },
            onFailure = { e -> if (e is IOException) Result.retry() else Result.failure() },
        )
    }
}
