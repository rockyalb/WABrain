package app.wabrain.data.repo

import androidx.room.withTransaction
import app.wabrain.data.api.ApiClient
import app.wabrain.data.api.ApiException
import app.wabrain.data.api.SyncResponse
import app.wabrain.data.db.AppDatabase
import app.wabrain.data.db.MetaEntity
import app.wabrain.data.db.toEntity
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Applies GET /v1/sync into Room.
 *
 * - `full = true` replaces the cache (after a server wipe too), keeping only
 *   rows with unsent local mutations.
 * - Deltas upsert changed rows and apply `deleted` tombstones.
 * - Rows with pending outbox operations are never overwritten, so an
 *   optimistic local change is not reverted before the server has seen it.
 * - Review items that are no longer pending are removed.
 */
class SyncRepository(
    private val db: AppDatabase,
    private val api: ApiClient,
    private val hooks: ChangeHooks,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()

    suspend fun sync(): SyncResponse = mutex.withLock {
        val cursor = db.meta().get(KEY_CURSOR)
        val response = try {
            api.sync(cursor)
        } catch (e: ApiException) {
            // An expired or unknown cursor: fall back to a full snapshot once.
            if (cursor != null && (e.status == 400 || e.status == 404 || e.status == 410)) {
                db.meta().remove(KEY_CURSOR)
                api.sync(null)
            } else {
                throw e
            }
        }
        apply(response)
        hooks.localDataChanged()
        response
    }

    /** Forces the next sync to be a full snapshot. */
    suspend fun resetCursor() {
        db.meta().remove(KEY_CURSOR)
    }

    suspend fun lastSyncAt(): Long? = db.meta().get(KEY_LAST_SYNC)?.toLongOrNull()

    suspend fun apply(response: SyncResponse) = db.withTransaction {
        val pendingTasks = db.outbox().pendingTaskIds().toSet()
        val pendingReviews = db.outbox().pendingReviewIds().toSet()

        if (response.full) {
            db.tasks().deleteAllExcept(pendingTasks.toList())
            db.reviews().deleteAll()
            db.contexts().deleteAll()
            db.chats().deleteAll()
            db.people().deleteAll()
        } else {
            val deleted = response.deleted
            if (deleted.tasks.isNotEmpty()) db.tasks().delete(deleted.tasks)
            if (deleted.reviewItems.isNotEmpty()) db.reviews().delete(deleted.reviewItems)
            if (deleted.contexts.isNotEmpty()) db.contexts().delete(deleted.contexts)
            if (deleted.chats.isNotEmpty()) db.chats().delete(deleted.chats)
            if (deleted.people.isNotEmpty()) db.people().delete(deleted.people)
        }

        db.tasks().upsert(response.tasks.filter { it.id !in pendingTasks }.map { it.toEntity() })

        val (pending, decided) = response.reviewItems.partition { it.state == "pending" }
        if (decided.isNotEmpty()) db.reviews().delete(decided.map { it.id })
        db.reviews().upsert(pending.filter { it.id !in pendingReviews }.map { it.toEntity() })

        db.contexts().upsert(response.contexts.map { it.toEntity() })
        db.chats().upsert(response.chats.map { it.toEntity() })
        db.people().upsert(response.people.map { it.toEntity() })
        response.settings?.let { db.settings().upsert(it.toEntity()) }

        db.meta().put(MetaEntity(KEY_CURSOR, response.cursor))
        db.meta().put(MetaEntity(KEY_LAST_SYNC, clock().toString()))
    }

    companion object {
        const val KEY_CURSOR = "sync_cursor"
        const val KEY_LAST_SYNC = "last_sync_at"
    }
}
