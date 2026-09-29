package app.wabrain.ui.people

import app.wabrain.data.api.MessageViewDto
import app.wabrain.data.db.ChatEntity

/**
 * One source of a person fact. [message] is null when the server no longer
 * stores it (for example after the chat's data was deleted); such a source is
 * listed but cannot be opened.
 */
data class FactSource(
    val messageId: String,
    val message: MessageViewDto?,
    /** The chat the message actually belongs to (from the message, never guessed from the person). */
    val chatId: String?,
    val chatName: String?,
) {
    val canOpen: Boolean get() = message != null && chatId != null
}

/** The expandable evidence list of one fact on the person screen. */
data class FactEvidenceUi(
    val expanded: Boolean = false,
    val loading: Boolean = false,
    /** What the server returned; null until loaded. Mapped with [factSources] when shown. */
    val messages: List<MessageViewDto>? = null,
    val error: Throwable? = null,
)

/**
 * Maps a fact's source IDs to the messages the server returned for
 * `GET /v1/people/:id/facts/:factId/sources`, keeping the fact's order and
 * dropping duplicate IDs. Each source opens in its own message's chat;
 * messages the server did not return are kept as not-openable entries.
 */
fun factSources(sourceMessageIds: List<String>, messages: List<MessageViewDto>, chats: List<ChatEntity>): List<FactSource> {
    val byId = messages.associateBy { it.id }
    val chatsById = chats.associateBy { it.id }
    return sourceMessageIds.distinct().map { id ->
        val message = byId[id]
        val chat = message?.chatId?.let(chatsById::get)
        FactSource(
            messageId = id,
            message = message,
            chatId = message?.chatId,
            chatName = chat?.let { it.name ?: it.jid },
        )
    }
}
