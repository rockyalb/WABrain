package app.wabrain.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Cached Task. Instants are epoch milliseconds. */
@Entity(tableName = "tasks", indices = [Index("status"), Index("dueAt")])
data class TaskEntity(
    @PrimaryKey val id: String,
    val kind: String,
    val status: String,
    val title: String,
    val description: String,
    val dueAt: Long?,
    val dueHasTime: Boolean,
    val contextId: String?,
    val chatId: String?,
    val personId: String?,
    val origin: String,
    val language: String?,
    val confidence: Double?,
    /** JSON array of message ids. */
    val evidenceMessageIds: String,
    val createdAt: Long,
    val updatedAt: Long,
    val closedAt: Long?,
)

/** Pending review item. The full action is kept as JSON. */
@Entity(tableName = "review_items")
data class ReviewItemEntity(
    @PrimaryKey val id: String,
    val type: String,
    val taskId: String?,
    val chatId: String?,
    val personId: String?,
    val summary: String,
    val reason: String,
    val createdAt: Long,
    val actionJson: String,
    /** ReviewHandledDto JSON, or null. */
    val handledJson: String? = null,
)

@Entity(tableName = "contexts")
data class ContextEntity(
    @PrimaryKey val id: String,
    val name: String,
    val color: String?,
    val sortOrder: Int,
)

@Entity(tableName = "chats")
data class ChatEntity(
    @PrimaryKey val id: String,
    val jid: String,
    val name: String?,
    val isGroup: Boolean,
    val mode: String,
    val defaultContextId: String?,
    val contextConfirmed: Boolean,
    val autoCreate: Boolean,
    val minimumAutoConfidence: Double?,
    val aliasesJson: String,
    val personId: String?,
    val lastMessageAt: Long?,
)

/** Person; facts and other nested fields live in [json] (the full PersonDto). */
@Entity(tableName = "people")
data class PersonEntity(
    @PrimaryKey val id: String,
    val displayName: String,
    val defaultContextId: String?,
    val updatedAt: Long,
    val json: String,
)

/** Single-row settings cache (id is always 0). */
@Entity(tableName = "settings")
data class SettingsEntity(
    @PrimaryKey val id: Int = 0,
    val json: String,
)

/** Key/value store for the sync cursor and similar bookkeeping. */
@Entity(tableName = "meta")
data class MetaEntity(
    @PrimaryKey val key: String,
    val value: String,
)

/**
 * A mutation waiting to be sent. Processed strictly in insertion order by
 * OutboxProcessor. [entityType]/[entityId] and [relatedTaskId] mark which cached
 * rows must not be overwritten by sync until the operation has been sent.
 */
@Entity(tableName = "outbox", indices = [Index("entityId"), Index("relatedTaskId")])
data class OutboxEntity(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    val idempotencyKey: String,
    val method: String,
    /** Encoded path relative to the server base URL, e.g. "v1/tasks/abc/complete". */
    val path: String,
    val body: String?,
    val entityType: String,
    val entityId: String,
    val relatedTaskId: String?,
    val createdAt: Long,
    val attempts: Int = 0,
    val lastError: String? = null,
) {
    companion object {
        const val TYPE_TASK = "task"
        const val TYPE_REVIEW = "review"
    }
}
