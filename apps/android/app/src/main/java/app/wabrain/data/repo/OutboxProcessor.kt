package app.wabrain.data.repo

import androidx.room.withTransaction
import app.wabrain.data.api.ApiClient
import app.wabrain.data.api.ApiException
import app.wabrain.data.api.NotPairedException
import app.wabrain.data.api.ReviewDecisionResponse
import app.wabrain.data.api.TaskDto
import app.wabrain.data.api.WabJson
import app.wabrain.data.db.AppDatabase
import app.wabrain.data.db.OutboxEntity
import app.wabrain.data.db.toEntity
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

/**
 * Sends queued mutations in order. Each operation keeps the Idempotency-Key it
 * was created with, so a retry after a lost response is replayed by the server
 * instead of applied twice.
 *
 * - Network errors, 408/425/429 and 5xx stop the flush; WorkManager retries with backoff.
 * - Other 4xx errors drop the operation and reconcile the affected row with the server.
 */
class OutboxProcessor(
    private val db: AppDatabase,
    private val api: ApiClient,
    private val sync: SyncRepository,
) {
    sealed class Result {
        data class Done(val sent: Int, val dropped: Int) : Result()
        data class Retry(val reason: String?) : Result()
        data object NotPaired : Result()
        data object Unauthorized : Result()
    }

    private val mutex = Mutex()

    suspend fun flush(): Result = mutex.withLock {
        var sent = 0
        var dropped = 0
        while (true) {
            val op = db.outbox().first() ?: return Result.Done(sent, dropped)
            try {
                val response = api.raw(op.method, op.path, op.body, op.idempotencyKey)
                db.outbox().delete(op.seq)
                sent++
                applyResponse(op, response)
            } catch (e: NotPairedException) {
                return Result.NotPaired
            } catch (e: ApiException) {
                when {
                    e.isUnauthorized -> return Result.Unauthorized
                    e.isRetryable -> {
                        db.outbox().markFailed(op.seq, e.message)
                        return Result.Retry(e.message)
                    }
                    else -> {
                        db.outbox().delete(op.seq)
                        dropped++
                        reconcile(op)
                    }
                }
            } catch (e: IOException) {
                db.outbox().markFailed(op.seq, e.message)
                return Result.Retry(e.message)
            }
        }
        @Suppress("UNREACHABLE_CODE")
        Result.Done(sent, dropped)
    }

    /** Upserts the task the server returned, unless newer local changes are still queued for it. */
    private suspend fun applyResponse(op: OutboxEntity, body: String) {
        val task: TaskDto? = when (op.entityType) {
            OutboxEntity.TYPE_TASK -> runCatching { WabJson.decodeFromString(TaskDto.serializer(), body) }.getOrNull()
            OutboxEntity.TYPE_REVIEW ->
                runCatching { WabJson.decodeFromString(ReviewDecisionResponse.serializer(), body).task }.getOrNull()
            else -> null
        }
        if (task != null) {
            db.withTransaction {
                if (task.id !in db.outbox().pendingTaskIds()) db.tasks().upsert(task.toEntity())
            }
        }
    }

    /** The server refused the operation: bring the local row back in line with the server. */
    private suspend fun reconcile(op: OutboxEntity) {
        val taskId = if (op.entityType == OutboxEntity.TYPE_TASK) op.entityId else op.relatedTaskId
        if (taskId != null && taskId !in db.outbox().pendingTaskIds()) {
            try {
                db.tasks().upsert(api.taskDetail(taskId).task.toEntity())
            } catch (e: ApiException) {
                if (e.status == 404) db.tasks().delete(listOf(taskId))
            } catch (_: IOException) {
                // Offline again; the next full sync will correct it.
                sync.resetCursor()
            }
        }
        if (op.entityType == OutboxEntity.TYPE_REVIEW) {
            // The item was hidden optimistically; a full snapshot restores it if it is still pending.
            sync.resetCursor()
        }
    }
}
