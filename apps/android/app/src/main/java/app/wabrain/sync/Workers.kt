package app.wabrain.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import app.wabrain.appContainer
import app.wabrain.data.api.ApiException
import app.wabrain.data.api.NotPairedException
import app.wabrain.data.api.PushEndpointRequest
import app.wabrain.data.repo.OutboxProcessor
import java.io.IOException

/** Maps a failed server call to a WorkManager result, unpairing locally on 401. */
private suspend fun CoroutineWorker.failureResult(context: Context, e: Exception): androidx.work.ListenableWorker.Result = when {
    e is NotPairedException -> androidx.work.ListenableWorker.Result.success()
    e is ApiException && e.isUnauthorized -> {
        context.appContainer.pairing.resetLocal(revoked = true)
        androidx.work.ListenableWorker.Result.failure()
    }
    e is ApiException && !e.isRetryable -> androidx.work.ListenableWorker.Result.failure()
    e is IOException && runAttemptCount < 8 -> androidx.work.ListenableWorker.Result.retry()
    else -> androidx.work.ListenableWorker.Result.failure()
}

/**
 * GET /v1/sync into Room (the widget refreshes through the change hook), then
 * recovers notifications whose push was lost or never sent (R08): the 15-minute
 * periodic run is the fallback when there is no UnifiedPush distributor.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = applicationContext.appContainer
        if (!container.session.isPaired()) return Result.success()
        return try {
            container.sync.sync()
            try {
                container.missedNotifications.reconcile()
            } catch (e: ApiException) {
                // A server without the notifications list: nothing to recover.
                if (e.status != 404 && !e.isNotImplemented) throw e
            }
            Result.success()
        } catch (e: IOException) {
            failureResult(applicationContext, e)
        }
    }
}

/** Sends queued mutations, then syncs. */
class OutboxWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = applicationContext.appContainer
        if (!container.session.isPaired()) return Result.success()
        return when (val result = container.outbox.flush()) {
            is OutboxProcessor.Result.Done -> {
                if (result.sent + result.dropped > 0) WorkScheduler.syncNow(applicationContext)
                Result.success()
            }
            is OutboxProcessor.Result.Retry -> Result.retry()
            OutboxProcessor.Result.NotPaired -> Result.success()
            OutboxProcessor.Result.Unauthorized -> {
                container.pairing.resetLocal(revoked = true)
                Result.failure()
            }
        }
    }
}

/** Registers (or removes) this device's UnifiedPush endpoint with the server. */
class PushEndpointWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = applicationContext.appContainer
        if (!container.session.isPaired()) return Result.success()
        return try {
            if (inputData.getBoolean(KEY_REMOVE, false)) {
                container.api.deletePushEndpoint()
                container.session.markPushRegistered(false)
            } else {
                val state = container.session.pushState()
                val endpoint = state.endpoint ?: return Result.success()
                val p256dh = state.p256dh
                val auth = state.auth
                if (p256dh == null || auth == null) {
                    container.session.setPushError(ERROR_NO_KEYS)
                    return Result.failure()
                }
                container.api.registerPushEndpoint(PushEndpointRequest(endpoint, p256dh, auth))
                container.session.markPushRegistered(true)
                container.session.setPushError(null)
            }
            Result.success()
        } catch (e: IOException) {
            if (e is ApiException && !e.isRetryable && !e.isUnauthorized) {
                container.session.setPushError(e.code ?: "http_${e.status}")
            }
            failureResult(applicationContext, e)
        }
    }

    companion object {
        const val KEY_REMOVE = "remove"
        const val ERROR_NO_KEYS = "no_web_push_keys"
    }
}
