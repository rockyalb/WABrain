package app.wabrain.ui.chats

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.wabrain.data.api.ChatMode
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.ContextEntity
import app.wabrain.data.db.chatMode
import app.wabrain.data.repo.ChatActions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** List filter chips on the Chats screen. */
enum class ChatFilter { ALL, TO_CONFIRM, ON, MENTIONS_ONLY, OFF }

/** A destructive change waiting for the owner's confirmation. */
sealed class ChatConfirmation {
    abstract val chatId: String

    /** Switching to Off purges the chat's stored messages and media on the server. */
    data class TurnOff(override val chatId: String) : ChatConfirmation()

    /** DELETE /v1/chats/:id/data. */
    data class DeleteData(override val chatId: String) : ChatConfirmation()
}

data class ChatsUiState(
    val loaded: Boolean = false,
    val chats: List<ChatEntity> = emptyList(),
    val contexts: List<ContextEntity> = emptyList(),
    val query: String = "",
    val filter: ChatFilter = ChatFilter.ALL,
    /** Chats with a suggested but unconfirmed default context. */
    val toConfirmCount: Int = 0,
    /** Chat whose settings sheet is open. */
    val open: ChatEntity? = null,
    val busy: Boolean = false,
    val error: Throwable? = null,
    val confirmation: ChatConfirmation? = null,
)

/** Pure chat-list rules, kept separate so they are unit-testable. */
object ChatRules {
    /** Direct chats offer Off / On; groups also offer Mentions only. A chat already in a mode always offers it. */
    fun modesFor(chat: ChatEntity): List<ChatMode> {
        val base = if (chat.isGroup) listOf(ChatMode.OFF, ChatMode.ON, ChatMode.MENTIONS_ONLY) else listOf(ChatMode.OFF, ChatMode.ON)
        return if (chat.chatMode in base) base else base + chat.chatMode
    }

    /** True when the default context is only a suggestion the owner has not confirmed. */
    fun needsContextConfirmation(chat: ChatEntity): Boolean = chat.defaultContextId != null && !chat.contextConfirmed

    fun matches(chat: ChatEntity, filter: ChatFilter): Boolean = when (filter) {
        ChatFilter.ALL -> true
        ChatFilter.TO_CONFIRM -> needsContextConfirmation(chat)
        ChatFilter.ON -> chat.chatMode == ChatMode.ON
        ChatFilter.MENTIONS_ONLY -> chat.chatMode == ChatMode.MENTIONS_ONLY
        ChatFilter.OFF -> chat.chatMode == ChatMode.OFF
    }

    fun filter(chats: List<ChatEntity>, query: String, filter: ChatFilter): List<ChatEntity> {
        val q = query.trim()
        return chats.filter { chat ->
            matches(chat, filter) &&
                (q.isEmpty() || (chat.name ?: "").contains(q, ignoreCase = true) || chat.jid.contains(q, ignoreCase = true))
        }
    }
}

/**
 * Chats screen state: search, filter, and the per-chat settings sheet. Every
 * change goes straight to the server through [actions]; turning a chat Off and
 * deleting its data both need an explicit confirmation first.
 */
class ChatsViewModel(
    chats: Flow<List<ChatEntity>>,
    contexts: Flow<List<ContextEntity>>,
    private val actions: ChatActions,
) : ViewModel() {
    private val ui = MutableStateFlow(Local())

    val state: StateFlow<ChatsUiState> = combine(chats, contexts, ui) { all, ctx, local ->
        ChatsUiState(
            loaded = true,
            chats = ChatRules.filter(all, local.query, local.filter),
            contexts = ctx,
            query = local.query,
            filter = local.filter,
            toConfirmCount = all.count(ChatRules::needsContextConfirmation),
            open = local.openChatId?.let { id -> all.firstOrNull { it.id == id } },
            busy = local.busy,
            error = local.error,
            confirmation = local.confirmation,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ChatsUiState())

    fun setQuery(query: String) = ui.update { it.copy(query = query) }

    fun setFilter(filter: ChatFilter) = ui.update { it.copy(filter = filter) }

    fun open(chatId: String) = ui.update { it.copy(openChatId = chatId, error = null, confirmation = null) }

    fun close() = ui.update { it.copy(openChatId = null, error = null, confirmation = null) }

    fun dismissError() = ui.update { it.copy(error = null) }

    /** Off asks for confirmation first; other modes apply at once. Re-selecting the current mode does nothing. */
    fun selectMode(chat: ChatEntity, mode: ChatMode) {
        if (mode == chat.chatMode) return
        if (mode == ChatMode.OFF) {
            ui.update { it.copy(confirmation = ChatConfirmation.TurnOff(chat.id)) }
        } else {
            perform { actions.setChatMode(chat.id, mode) }
        }
    }

    /** Picking a context is itself a confirmation of it. */
    fun selectContext(chatId: String, contextId: String?) = perform { actions.setChatContext(chatId, contextId) }

    fun confirmSuggestedContext(chatId: String) = perform { actions.confirmChatContext(chatId) }

    fun setAutoCreate(chatId: String, enabled: Boolean) = perform { actions.setChatAutoCreate(chatId, enabled) }

    fun requestDeleteData(chatId: String) = ui.update { it.copy(confirmation = ChatConfirmation.DeleteData(chatId)) }

    fun dismissConfirmation() = ui.update { it.copy(confirmation = null) }

    /** Carries out the pending confirmation. Deleting data closes the sheet once it succeeds. */
    fun confirm() {
        val pending = ui.value.confirmation ?: return
        ui.update { it.copy(confirmation = null) }
        when (pending) {
            is ChatConfirmation.TurnOff -> perform { actions.setChatMode(pending.chatId, ChatMode.OFF) }
            is ChatConfirmation.DeleteData -> perform(onSuccess = { close() }) { actions.deleteChatData(pending.chatId) }
        }
    }

    private fun perform(onSuccess: () -> Unit = {}, block: suspend () -> Unit) {
        if (ui.value.busy) return
        ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                block()
                ui.update { it.copy(busy = false) }
                onSuccess()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                ui.update { it.copy(busy = false, error = e) }
            }
        }
    }

    private data class Local(
        val query: String = "",
        val filter: ChatFilter = ChatFilter.ALL,
        val openChatId: String? = null,
        val busy: Boolean = false,
        val error: Throwable? = null,
        val confirmation: ChatConfirmation? = null,
    )
}
