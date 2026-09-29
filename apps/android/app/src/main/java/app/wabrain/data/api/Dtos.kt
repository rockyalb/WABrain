package app.wabrain.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/*
 * Kotlin mirrors of packages/contracts/src/domain.ts (Zod) and the request and
 * response envelopes of docs/API.md. Field names must match the contract
 * exactly; ContractFieldNamesTest checks them against the OpenAPI export when
 * packages/contracts/openapi.json exists.
 *
 * Nullable fields and arrays carry defaults so that a server omitting an
 * optional field does not break decoding.
 */

// ---------------------------------------------------------------------------
// Contexts and settings
// ---------------------------------------------------------------------------

@Serializable
data class ContextDto(
    val id: String,
    val name: String,
    val color: String? = null,
    val sortOrder: Int = 0,
)

@Serializable
data class SettingsDto(
    val timezone: String = DEFAULT_TIMEZONE,
    val endOfWorkDay: String = DEFAULT_END_OF_WORK_DAY,
    val dailySummaryTime: String? = null,
    val remindersEnabled: Boolean = true,
    val reminderLeadMinutes: Int = 0,
    val trialStartedAt: String? = null,
    val trialDays: Int = 7,
    val autoCreateThreshold: Double = 0.0,
) {
    companion object {
        const val DEFAULT_TIMEZONE = "UTC"
        const val DEFAULT_END_OF_WORK_DAY = "17:00"
    }
}

// ---------------------------------------------------------------------------
// Chats and people
// ---------------------------------------------------------------------------

@Serializable
enum class ChatMode {
    @SerialName("off") OFF,
    @SerialName("on") ON,
    @SerialName("mentions_only") MENTIONS_ONLY,
}

@Serializable
data class ChatDto(
    val id: String,
    val jid: String,
    val name: String? = null,
    val isGroup: Boolean = false,
    val mode: ChatMode = ChatMode.ON,
    val defaultContextId: String? = null,
    val contextConfirmed: Boolean = false,
    val autoCreate: Boolean = true,
    val minimumAutoConfidence: Double? = null,
    val aliases: List<String> = emptyList(),
    val personId: String? = null,
    val lastMessageAt: String? = null,
)

/** One of name, company, role, relationship, language, topic, location, other. */
@Serializable
data class PersonFactDto(
    val id: String,
    val key: String,
    val value: String,
    val confidence: Double = 1.0,
    val verified: Boolean = false,
    val selfClaimed: Boolean = false,
    /** "ai" or "owner". */
    val source: String = "ai",
    val sourceMessageIds: List<String> = emptyList(),
    val updatedAt: String,
)

@Serializable
data class PersonDto(
    val id: String,
    val displayName: String,
    val jids: List<String> = emptyList(),
    val languages: List<String> = emptyList(),
    val defaultContextId: String? = null,
    val facts: List<PersonFactDto> = emptyList(),
    val updatedAt: String,
)

val PERSON_FACT_KEYS = listOf("name", "company", "role", "relationship", "language", "topic", "location", "other")

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

@Serializable
enum class TaskKind(val wire: String) {
    @SerialName("todo") TODO("todo"),
    @SerialName("waiting_on") WAITING_ON("waiting_on"),
    ;

    companion object {
        fun fromWire(value: String): TaskKind = entries.firstOrNull { it.wire == value } ?: TODO
    }
}

@Serializable
enum class TaskStatus(val wire: String) {
    @SerialName("open") OPEN("open"),
    @SerialName("done") DONE("done"),
    @SerialName("cancelled") CANCELLED("cancelled"),
    ;

    companion object {
        fun fromWire(value: String): TaskStatus = entries.firstOrNull { it.wire == value } ?: OPEN
    }
}

@Serializable
data class TaskDto(
    val id: String,
    val kind: TaskKind = TaskKind.TODO,
    val status: TaskStatus = TaskStatus.OPEN,
    val title: String,
    val description: String = "",
    val dueAt: String? = null,
    val dueHasTime: Boolean = false,
    val contextId: String? = null,
    val chatId: String? = null,
    val personId: String? = null,
    /** "ai", "manual" or "import". */
    val origin: String = "manual",
    val language: String? = null,
    val confidence: Double? = null,
    val evidenceMessageIds: List<String> = emptyList(),
    val createdAt: String,
    val updatedAt: String,
    val closedAt: String? = null,
)

@Serializable
data class TaskEventDto(
    val id: String,
    val taskId: String,
    /** created, edited, completed, reopened, cancelled, rescheduled, merged, undone. */
    val type: String,
    /** "ai", "owner" or "system". */
    val actor: String,
    val evidenceMessageIds: List<String> = emptyList(),
    val before: JsonObject? = null,
    val after: JsonObject? = null,
    val undoableUntil: String? = null,
    val undoneAt: String? = null,
    /** Events sharing a groupId (e.g. a merge) are undone together: show one Undo. */
    val groupId: String? = null,
    val createdAt: String,
)

// ---------------------------------------------------------------------------
// Agent task actions: discriminated union on "type".
// ---------------------------------------------------------------------------

@Serializable
sealed class TaskActionDto {
    abstract val confidence: Double
    abstract val ambiguityReasons: List<String>
    abstract val evidenceMessageIds: List<String>

    @Serializable
    @SerialName("create")
    data class Create(
        val kind: TaskKind = TaskKind.TODO,
        val title: String,
        val description: String = "",
        val dueAt: String? = null,
        val dueHasTime: Boolean = false,
        val contextId: String? = null,
        val language: String? = null,
        override val confidence: Double = 0.0,
        override val ambiguityReasons: List<String> = emptyList(),
        override val evidenceMessageIds: List<String> = emptyList(),
    ) : TaskActionDto()

    @Serializable
    @SerialName("complete")
    data class Complete(
        val taskId: String,
        override val confidence: Double = 0.0,
        override val ambiguityReasons: List<String> = emptyList(),
        override val evidenceMessageIds: List<String> = emptyList(),
    ) : TaskActionDto()

    @Serializable
    @SerialName("cancel")
    data class Cancel(
        val taskId: String,
        override val confidence: Double = 0.0,
        override val ambiguityReasons: List<String> = emptyList(),
        override val evidenceMessageIds: List<String> = emptyList(),
    ) : TaskActionDto()

    @Serializable
    @SerialName("reschedule")
    data class Reschedule(
        val taskId: String,
        val dueAt: String,
        val dueHasTime: Boolean = false,
        override val confidence: Double = 0.0,
        override val ambiguityReasons: List<String> = emptyList(),
        override val evidenceMessageIds: List<String> = emptyList(),
    ) : TaskActionDto()

    @Serializable
    @SerialName("merge")
    data class Merge(
        val taskIds: List<String>,
        override val confidence: Double = 0.0,
        override val ambiguityReasons: List<String> = emptyList(),
        override val evidenceMessageIds: List<String> = emptyList(),
    ) : TaskActionDto()
}

// ---------------------------------------------------------------------------
// Review inbox
// ---------------------------------------------------------------------------

@Serializable
enum class ReviewItemType(val wire: String) {
    @SerialName("create") CREATE("create"),
    @SerialName("possibly_done") POSSIBLY_DONE("possibly_done"),
    @SerialName("possibly_cancelled") POSSIBLY_CANCELLED("possibly_cancelled"),
    @SerialName("reschedule") RESCHEDULE("reschedule"),
    @SerialName("merge") MERGE("merge"),

    /** Fallback for values added to the contract after this build. */
    @SerialName("unknown") UNKNOWN("unknown"),
    ;

    /** possibly_done / possibly_cancelled use Done / Not yet instead of Accept / Reject. */
    val isConfirmation: Boolean get() = this == POSSIBLY_DONE || this == POSSIBLY_CANCELLED

    companion object {
        fun fromWire(value: String?): ReviewItemType = entries.firstOrNull { it.wire == value } ?: UNKNOWN
    }
}

@Serializable
data class ReviewItemDto(
    val id: String,
    val type: ReviewItemType = ReviewItemType.UNKNOWN,
    /** "pending", "accepted" or "rejected". */
    val state: String = "pending",
    val taskId: String? = null,
    /**
     * TaskAction kept raw so an action type added later does not break sync;
     * see [parsedAction].
     */
    val action: JsonObject = JsonObject(emptyMap()),
    val reason: String = "",
    val chatId: String? = null,
    val personId: String? = null,
    val summary: String = "",
    /** create only: a later message suggests it was already handled. */
    val handled: ReviewHandledDto? = null,
    val createdAt: String,
    val decidedAt: String? = null,
) {
    val parsedAction: TaskActionDto? get() = parseTaskAction(action)
}

/**
 * A later message suggests a pending create was already dealt with before the owner reviewed it.
 * [status] is "done" or "cancelled"; accepting with that closeAs keeps it as a closed task.
 */
@Serializable
data class ReviewHandledDto(
    val status: String,
    val evidenceMessageIds: List<String> = emptyList(),
    val confidence: Double = 0.0,
    val excerpt: String = "",
    val fromOwner: Boolean = false,
    val at: String? = null,
)

/** Decodes a TaskAction, or null when its type is unknown to this build. */
fun parseTaskAction(json: JsonObject): TaskActionDto? =
    runCatching { WabJson.decodeFromJsonElement(TaskActionDto.serializer(), json) }.getOrNull()

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

@Serializable
data class MessageViewDto(
    val id: String,
    val chatId: String,
    val senderName: String? = null,
    val fromOwner: Boolean = false,
    val body: String = "",
    val kind: String = "text",
    val derivedText: String? = null,
    val language: String? = null,
    val quotedMessageId: String? = null,
    val at: String,
)

// ---------------------------------------------------------------------------
// Ask your chats (phase 3)
// ---------------------------------------------------------------------------

@Serializable
data class AskRequestDto(
    val question: String,
    val personId: String? = null,
    val contextId: String? = null,
    val from: String? = null,
    val to: String? = null,
)

@Serializable
data class AskCitationDto(
    val messageId: String,
    val chatId: String,
    val excerpt: String = "",
    val at: String,
)

@Serializable
data class AskResponseDto(
    val found: Boolean,
    val answer: String = "",
    val citations: List<AskCitationDto> = emptyList(),
    val suggestedAction: TaskActionDto.Create? = null,
)

// ---------------------------------------------------------------------------
// Envelopes (docs/API.md)
// ---------------------------------------------------------------------------

@Serializable
data class ErrorEnvelope(val error: ErrorBody)

@Serializable
data class ErrorBody(val code: String, val message: String = "")

@Serializable
data class PageDto<T>(val items: List<T> = emptyList(), val nextCursor: String? = null)

@Serializable
data class PairRequest(val code: String, val deviceName: String)

@Serializable
data class PairResponse(val deviceId: String, val token: String)

@Serializable
data class DeletedIds(
    val tasks: List<String> = emptyList(),
    val reviewItems: List<String> = emptyList(),
    val contexts: List<String> = emptyList(),
    val chats: List<String> = emptyList(),
    val people: List<String> = emptyList(),
)

@Serializable
data class SyncResponse(
    val cursor: String,
    val full: Boolean = false,
    val tasks: List<TaskDto> = emptyList(),
    val reviewItems: List<ReviewItemDto> = emptyList(),
    val contexts: List<ContextDto> = emptyList(),
    val chats: List<ChatDto> = emptyList(),
    val people: List<PersonDto> = emptyList(),
    val settings: SettingsDto? = null,
    val deleted: DeletedIds = DeletedIds(),
)

@Serializable
data class TaskDetailResponse(
    val task: TaskDto,
    val events: List<TaskEventDto> = emptyList(),
    val evidence: List<MessageViewDto> = emptyList(),
)

@Serializable
data class CreateTaskRequest(
    val id: String? = null,
    val kind: TaskKind,
    val title: String,
    val description: String? = null,
    /** Full ISO instant, or YYYY-MM-DD for a date-only due. */
    val dueAt: String? = null,
    val dueHasTime: Boolean? = null,
    val contextId: String? = null,
    val chatId: String? = null,
    val personId: String? = null,
)

@Serializable
data class ReviewDecisionResponse(val reviewItem: ReviewItemDto? = null, val task: TaskDto? = null)

@Serializable
data class MessagesResponse(val items: List<MessageViewDto> = emptyList())

@Serializable
data class PushEndpointRequest(val endpoint: String, val p256dh: String, val auth: String)

/** One durable notification; [payload] has the push payload shape (PushPayload.parse). */
@Serializable
data class NotificationEventDto(val id: String, val createdAt: String = "", val payload: JsonObject)

@Serializable
data class NotificationsResponse(val items: List<NotificationEventDto> = emptyList())

@Serializable
data class NotificationAckRequest(val ids: List<String>)

@Serializable
data class CreateContextRequest(val name: String, val color: String? = null)

@Serializable
data class AddFactRequest(val key: String, val value: String)
