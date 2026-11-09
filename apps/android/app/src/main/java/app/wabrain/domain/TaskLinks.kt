package app.wabrain.domain

import app.wabrain.data.api.TaskLinkDto
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One entry of the link list sent to PATCH /v1/tasks/{id} ("links"): [chatId] links that chat;
 * [chatId] null keeps the unconfirmed link called [name]. The list replaces the task's links.
 */
data class LinkInput(val name: String?, val chatId: String?)

/**
 * Owner edits of a task's links, mirroring the server (TaskService.ownerLinks) so the change shows at
 * once while the request waits in the outbox.
 */
object TaskLinks {
    private const val MAX_LINKS = 5

    /** The "links" value of a task PATCH or a Review accept's edits. */
    fun toJson(inputs: List<LinkInput>): JsonArray = buildJsonArray {
        inputs.forEach { input ->
            add(
                buildJsonObject {
                    input.name?.let { put("name", it) }
                    put("chatId", input.chatId?.let(::JsonPrimitive) ?: JsonNull)
                },
            )
        }
    }

    /** The list as it stands, as inputs. */
    fun inputsOf(links: List<TaskLinkDto>): List<LinkInput> = links.map { LinkInput(it.name, it.chatId) }

    /** Answers "Who is [link]?" with [chatId], keeping the name as written. */
    fun pick(links: List<TaskLinkDto>, link: TaskLinkDto, chatId: String): List<LinkInput> =
        links.map { if (it == link) LinkInput(it.name, chatId) else LinkInput(it.name, it.chatId) }

    /** Removes [link] (a wrong link, or a name the owner does not want linked). */
    fun remove(links: List<TaskLinkDto>, link: TaskLinkDto): List<LinkInput> = inputsOf(links - link)

    /** Links one more chat by hand; null when it is already linked or the list is full. */
    fun add(links: List<TaskLinkDto>, chatId: String): List<LinkInput>? =
        if (links.any { it.chatId == chatId } || links.size >= MAX_LINKS) null else inputsOf(links) + LinkInput(null, chatId)

    /** The links the server will store for [inputs]; [chatName] names a chat the owner links. */
    fun apply(existing: List<TaskLinkDto>, inputs: List<LinkInput>, ownChatId: String?, chatName: (String) -> String?): List<TaskLinkDto> {
        val result = mutableListOf<TaskLinkDto>()
        for (input in inputs.take(MAX_LINKS)) {
            val name = input.name?.trim()?.takeIf { it.isNotEmpty() }?.take(80)
            val chatId = input.chatId
            if (chatId != null) {
                if (chatId == ownChatId || result.any { it.chatId == chatId }) continue
                result += existing.firstOrNull { it.chatId == chatId }
                    ?: TaskLinkDto(name = name ?: chatName(chatId) ?: "Chat", chatId = chatId, source = "owner")
            } else {
                existing.firstOrNull { it.chatId == null && it.name == name }?.takeIf { it !in result }?.let { result += it }
            }
        }
        return result
    }
}
