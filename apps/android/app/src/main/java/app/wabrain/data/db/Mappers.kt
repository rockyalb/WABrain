package app.wabrain.data.db

import app.wabrain.data.api.ChatDto
import app.wabrain.data.api.ChatMode
import app.wabrain.data.api.ContextDto
import app.wabrain.data.api.PersonDto
import app.wabrain.data.api.ReviewHandledDto
import app.wabrain.data.api.ReviewItemDto
import app.wabrain.data.api.ReviewItemType
import app.wabrain.data.api.SettingsDto
import app.wabrain.data.api.TaskActionDto
import app.wabrain.data.api.TaskDto
import app.wabrain.data.api.TaskKind
import app.wabrain.data.api.TaskStatus
import app.wabrain.data.api.WabJson
import app.wabrain.data.api.parseTaskAction
import kotlinx.serialization.json.jsonObject
import app.wabrain.domain.Instants
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

private val stringList = ListSerializer(String.serializer())

fun encodeStringList(values: List<String>): String = WabJson.encodeToString(stringList, values)
fun decodeStringList(json: String): List<String> = runCatching { WabJson.decodeFromString(stringList, json) }.getOrDefault(emptyList())

fun TaskDto.toEntity(): TaskEntity = TaskEntity(
    id = id,
    kind = kind.wire,
    status = status.wire,
    title = title,
    description = description,
    dueAt = dueAt?.let(Instants::parseMillis),
    dueHasTime = dueHasTime,
    contextId = contextId,
    chatId = chatId,
    personId = personId,
    origin = origin,
    language = language,
    confidence = confidence,
    evidenceMessageIds = encodeStringList(evidenceMessageIds),
    createdAt = Instants.parseMillis(createdAt),
    updatedAt = Instants.parseMillis(updatedAt),
    closedAt = closedAt?.let(Instants::parseMillis),
)

val TaskEntity.taskKind: TaskKind get() = TaskKind.fromWire(kind)
val TaskEntity.taskStatus: TaskStatus get() = TaskStatus.fromWire(status)
val TaskEntity.evidenceIds: List<String> get() = decodeStringList(evidenceMessageIds)

fun ReviewItemDto.toEntity(): ReviewItemEntity = ReviewItemEntity(
    id = id,
    type = type.wire,
    taskId = taskId,
    chatId = chatId,
    personId = personId,
    summary = summary,
    reason = reason,
    createdAt = Instants.parseMillis(createdAt),
    actionJson = action.toString(),
    handledJson = handled?.let { WabJson.encodeToString(ReviewHandledDto.serializer(), it) },
)

val ReviewItemEntity.reviewType: ReviewItemType get() = ReviewItemType.fromWire(type)
val ReviewItemEntity.action: TaskActionDto?
    get() = runCatching { parseTaskAction(WabJson.parseToJsonElement(actionJson).jsonObject) }.getOrNull()
val ReviewItemEntity.handled: ReviewHandledDto?
    get() = handledJson?.let { json -> runCatching { WabJson.decodeFromString(ReviewHandledDto.serializer(), json) }.getOrNull() }

fun ContextDto.toEntity() = ContextEntity(id = id, name = name, color = color, sortOrder = sortOrder)

fun ChatDto.toEntity() = ChatEntity(
    id = id,
    jid = jid,
    name = name,
    isGroup = isGroup,
    mode = when (mode) {
        ChatMode.OFF -> "off"
        ChatMode.ON -> "on"
        ChatMode.MENTIONS_ONLY -> "mentions_only"
    },
    defaultContextId = defaultContextId,
    contextConfirmed = contextConfirmed,
    autoCreate = autoCreate,
    minimumAutoConfidence = minimumAutoConfidence,
    aliasesJson = encodeStringList(aliases),
    personId = personId,
    lastMessageAt = lastMessageAt?.let(Instants::parseMillis),
)

val ChatEntity.chatMode: ChatMode
    get() = when (mode) {
        "off" -> ChatMode.OFF
        "mentions_only" -> ChatMode.MENTIONS_ONLY
        else -> ChatMode.ON
    }

fun PersonDto.toEntity() = PersonEntity(
    id = id,
    displayName = displayName,
    defaultContextId = defaultContextId,
    updatedAt = Instants.parseMillis(updatedAt),
    json = WabJson.encodeToString(PersonDto.serializer(), this),
)

val PersonEntity.dto: PersonDto?
    get() = runCatching { WabJson.decodeFromString(PersonDto.serializer(), json) }.getOrNull()

fun SettingsDto.toEntity() = SettingsEntity(json = WabJson.encodeToString(SettingsDto.serializer(), this))

val SettingsEntity.dto: SettingsDto
    get() = runCatching { WabJson.decodeFromString(SettingsDto.serializer(), json) }.getOrDefault(SettingsDto())
