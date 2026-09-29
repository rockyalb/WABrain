package app.wabrain.data.repo

import androidx.room.withTransaction
import app.wabrain.data.api.ApiClient
import app.wabrain.data.api.CreateTaskRequest
import app.wabrain.data.api.ReviewItemType
import app.wabrain.data.api.TaskActionDto
import app.wabrain.data.api.TaskDetailResponse
import app.wabrain.data.api.TaskKind
import app.wabrain.data.api.WabJson
import app.wabrain.data.db.AppDatabase
import app.wabrain.data.db.OutboxEntity
import app.wabrain.data.db.TaskEntity
import app.wabrain.data.db.action
import app.wabrain.data.db.dto
import app.wabrain.data.db.encodeStringList
import app.wabrain.data.db.reviewType
import app.wabrain.data.db.toEntity
import app.wabrain.domain.Instants
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/** A due date with an optional time. Without a time the server uses endOfWorkDay. */
data class DueInput(val date: LocalDate, val time: LocalTime?) {
    val hasTime: Boolean get() = time != null

    /** "YYYY-MM-DD" for a date-only due, else an ISO instant with offset in [zone]. */
    fun wireValue(zone: ZoneId): String =
        if (time == null) date.toString() else date.atTime(time).atZone(zone).toOffsetDateTime().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)

    fun toMillis(zone: ZoneId, endOfWorkDay: LocalTime): Long =
        date.atTime(time ?: endOfWorkDay).atZone(zone).toInstant().toEpochMilli()
}

data class NewTask(
    val title: String,
    val kind: TaskKind = TaskKind.TODO,
    val description: String = "",
    val due: DueInput? = null,
    val contextId: String? = null,
    val chatId: String? = null,
    val personId: String? = null,
)

/** Only the fields marked as changed are sent in the PATCH. */
data class TaskEdit(
    val title: String? = null,
    val description: String? = null,
    val kind: TaskKind? = null,
    val dueChanged: Boolean = false,
    val due: DueInput? = null,
    val contextChanged: Boolean = false,
    val contextId: String? = null,
)

/**
 * Offline-first task and review mutations: each one updates Room at once and
 * queues the HTTP request in the outbox.
 */
class TaskRepository(
    private val db: AppDatabase,
    private val api: ApiClient,
    private val hooks: ChangeHooks,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun complete(id: String) = transition(id, "done", "complete")
    suspend fun reopen(id: String) = transition(id, "open", "reopen")
    suspend fun cancel(id: String) = transition(id, "cancelled", "cancel")

    private suspend fun transition(id: String, status: String, verb: String) {
        val now = clock()
        db.withTransaction {
            val task = db.tasks().get(id) ?: return@withTransaction
            db.tasks().upsert(
                task.copy(status = status, closedAt = if (status == "open") null else now, updatedAt = now),
            )
            enqueue("POST", ApiClient.path("v1", "tasks", id, verb), "{}", OutboxEntity.TYPE_TASK, id, null)
        }
        afterMutation()
    }

    /** Creates a manual task with a client-generated UUID; returns its id. */
    suspend fun create(input: NewTask): String {
        val id = UUID.randomUUID().toString()
        val now = clock()
        db.withTransaction {
            val (zone, eod) = zoneAndEndOfWorkDay()
            val request = CreateTaskRequest(
                id = id,
                kind = input.kind,
                title = input.title.trim(),
                description = input.description.trim().ifEmpty { null },
                dueAt = input.due?.wireValue(zone),
                dueHasTime = input.due?.hasTime,
                contextId = input.contextId,
                chatId = input.chatId,
                personId = input.personId,
            )
            db.tasks().upsert(
                TaskEntity(
                    id = id,
                    kind = input.kind.wire,
                    status = "open",
                    title = request.title,
                    description = input.description.trim(),
                    dueAt = input.due?.toMillis(zone, eod),
                    dueHasTime = input.due?.hasTime ?: false,
                    contextId = input.contextId,
                    chatId = input.chatId,
                    personId = input.personId,
                    origin = "manual",
                    language = null,
                    confidence = null,
                    evidenceMessageIds = encodeStringList(emptyList()),
                    createdAt = now,
                    updatedAt = now,
                    closedAt = null,
                ),
            )
            val body = WabJson.encodeToString(CreateTaskRequest.serializer(), request)
            enqueue("POST", ApiClient.path("v1", "tasks"), body, OutboxEntity.TYPE_TASK, id, null)
        }
        afterMutation()
        return id
    }

    suspend fun update(id: String, edit: TaskEdit) {
        val now = clock()
        db.withTransaction {
            val task = db.tasks().get(id) ?: return@withTransaction
            val (zone, eod) = zoneAndEndOfWorkDay()
            val patch = buildJsonObject {
                edit.title?.let { put("title", it.trim()) }
                edit.description?.let { put("description", it.trim()) }
                edit.kind?.let { put("kind", it.wire) }
                if (edit.dueChanged) {
                    val due = edit.due
                    if (due == null) {
                        put("dueAt", JsonNull)
                    } else {
                        put("dueAt", due.wireValue(zone))
                        put("dueHasTime", due.hasTime)
                    }
                }
                if (edit.contextChanged) put("contextId", edit.contextId)
            }
            if (patch.isEmpty()) return@withTransaction
            db.tasks().upsert(
                task.copy(
                    title = edit.title?.trim() ?: task.title,
                    description = edit.description?.trim() ?: task.description,
                    kind = edit.kind?.wire ?: task.kind,
                    dueAt = if (edit.dueChanged) edit.due?.toMillis(zone, eod) else task.dueAt,
                    dueHasTime = if (edit.dueChanged) edit.due?.hasTime ?: false else task.dueHasTime,
                    contextId = if (edit.contextChanged) edit.contextId else task.contextId,
                    updatedAt = now,
                ),
            )
            enqueue("PATCH", ApiClient.path("v1", "tasks", id), patch.toString(), OutboxEntity.TYPE_TASK, id, null)
        }
        afterMutation()
    }

    /**
     * Accepts or rejects a review item. For possibly_done / possibly_cancelled,
     * accept means Done and reject means Not yet. [edits] may override
     * title, description, dueAt, contextId or kind of a create. [closeAs] ("done" or
     * "cancelled", creates only) accepts and closes the new task at once, for a
     * proposal a later message says was already handled.
     */
    suspend fun decideReview(itemId: String, accept: Boolean, edits: JsonObject? = null, closeAs: String? = null) {
        val now = clock()
        db.withTransaction {
            val item = db.reviews().get(itemId)
            db.reviews().delete(listOf(itemId))
            val taskId = item?.taskId
            if (accept && item != null && taskId != null) {
                val task = db.tasks().get(taskId)
                if (task != null) {
                    val updated = when (item.reviewType) {
                        ReviewItemType.POSSIBLY_DONE -> task.copy(status = "done", closedAt = now, updatedAt = now)
                        ReviewItemType.POSSIBLY_CANCELLED -> task.copy(status = "cancelled", closedAt = now, updatedAt = now)
                        ReviewItemType.RESCHEDULE -> (item.action as? TaskActionDto.Reschedule)?.let {
                            task.copy(dueAt = Instants.parseMillis(it.dueAt), dueHasTime = it.dueHasTime, updatedAt = now)
                        }
                        else -> null
                    }
                    if (updated != null) db.tasks().upsert(updated)
                }
            }
            val body = if (accept) {
                buildJsonObject {
                    if (edits != null && edits.isNotEmpty()) put("edits", edits)
                    if (closeAs != null) put("closeAs", closeAs)
                }.toString()
            } else {
                "{}"
            }
            enqueue(
                method = "POST",
                path = ApiClient.path("v1", "review", itemId, if (accept) "accept" else "reject"),
                body = body,
                entityType = OutboxEntity.TYPE_REVIEW,
                entityId = itemId,
                relatedTaskId = if (accept) taskId else null,
            )
        }
        afterMutation()
    }

    /** Online only: task detail with events and evidence. */
    suspend fun loadDetail(id: String): TaskDetailResponse {
        val detail = api.taskDetail(id)
        db.withTransaction {
            if (id !in db.outbox().pendingTaskIds()) db.tasks().upsert(detail.task.toEntity())
        }
        return detail
    }

    /** Online only: undoes a TaskEvent (and its group). */
    suspend fun undoEvent(eventId: String) {
        val task = api.undoEvent(eventId)
        db.tasks().upsert(task.toEntity())
        hooks.localDataChanged()
    }

    private suspend fun zoneAndEndOfWorkDay(): Pair<ZoneId, LocalTime> {
        val settings = db.settings().get()?.dto
        return Instants.zoneOrDefault(settings?.timezone) to Instants.localTimeOrDefault(settings?.endOfWorkDay)
    }

    private suspend fun enqueue(
        method: String,
        path: String,
        body: String?,
        entityType: String,
        entityId: String,
        relatedTaskId: String?,
    ) {
        db.outbox().insert(
            OutboxEntity(
                idempotencyKey = ApiClient.newKey(),
                method = method,
                path = path,
                body = body,
                entityType = entityType,
                entityId = entityId,
                relatedTaskId = relatedTaskId,
                createdAt = clock(),
            ),
        )
    }

    private suspend fun afterMutation() {
        hooks.localDataChanged()
        hooks.outboxEnqueued()
    }
}
