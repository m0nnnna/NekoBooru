package com.nekobooru.app.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Schedules background sync. A periodic job is the primary auto-sync trigger
 * (replacing the manual button as the main path, though the button stays); a
 * one-shot request flushes queued offline changes as soon as the network is
 * back. Both require connectivity.
 */
object SyncScheduler {
    private const val PERIODIC_WORK = "nekobooru-periodic-sync"
    private const val ONESHOT_WORK = "nekobooru-oneshot-sync"

    private val networkConstraint = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /** Idempotently schedule the periodic sync. Safe to call on every app start. */
    fun ensureScheduled(context: Context) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(3, TimeUnit.HOURS)
            .setConstraints(networkConstraint)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    /** Request a one-shot sync (e.g. after a local change) once online. */
    fun requestOneShot(context: Context) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(networkConstraint)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            ONESHOT_WORK,
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }
}
