package app.wabrain.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

/** All background work: periodic and on-demand sync, the outbox flush, and push endpoint registration. */
object WorkScheduler {
    private const val PERIODIC_SYNC = "periodic-sync"
    private const val SYNC_NOW = "sync-now"
    private const val OUTBOX = "outbox-flush"
    private const val PUSH = "push-endpoint"

    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** The 15-minute fallback sync (the minimum WorkManager allows). */
    fun schedulePeriodicSync(context: Context) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC_SYNC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** Sync as soon as there is network: on app open, on push, after an outbox flush. */
    fun syncNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(SYNC_NOW, ExistingWorkPolicy.REPLACE, request)
    }

    /** Sends queued mutations; retried with exponential backoff while offline or on server errors. */
    fun flushOutbox(context: Context) {
        val request = OneTimeWorkRequestBuilder<OutboxWorker>()
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(OUTBOX, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    fun registerPushEndpoint(context: Context) = enqueuePush(context, remove = false)

    fun removePushEndpoint(context: Context) = enqueuePush(context, remove = true)

    private fun enqueuePush(context: Context, remove: Boolean) {
        val request = OneTimeWorkRequestBuilder<PushEndpointWorker>()
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(workDataOf(PushEndpointWorker.KEY_REMOVE to remove))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(PUSH, ExistingWorkPolicy.REPLACE, request)
    }

    fun cancelAll(context: Context) {
        val wm = WorkManager.getInstance(context)
        listOf(PERIODIC_SYNC, SYNC_NOW, OUTBOX, PUSH).forEach(wm::cancelUniqueWork)
    }
}
