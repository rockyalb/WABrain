package app.wabrain.data.repo

import app.wabrain.data.api.ApiClient
import app.wabrain.data.api.AskRequestDto
import app.wabrain.data.api.AskResponseDto
import app.wabrain.data.api.ChatMode
import app.wabrain.data.api.MessageViewDto
import app.wabrain.data.db.AppDatabase
import app.wabrain.data.db.toEntity
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Per-chat settings changes used by the Chats screen (an interface so the view model can be tested). */
interface ChatActions {
    suspend fun setChatMode(id: String, mode: ChatMode)
    suspend fun setChatContext(id: String, contextId: String?)
    suspend fun confirmChatContext(id: String)
    suspend fun setChatAutoCreate(id: String, enabled: Boolean)
    suspend fun deleteChatData(id: String)
}

/**
 * Online-only operations on chats, people, contexts and settings. Each call
 * goes straight to the API (with a fresh Idempotency-Key) and writes the
 * result back to Room. Errors propagate to the caller to show.
 */
class DirectoryRepository(
    private val db: AppDatabase,
    private val api: ApiClient,
    private val sync: SyncRepository,
    private val hooks: ChangeHooks,
) : ChatActions {
    // ------------------------------------------------------------ chats

    suspend fun patchChat(id: String, patch: JsonObject) {
        val chat = api.patchChat(id, patch)
        db.chats().upsert(listOf(chat.toEntity()))
        hooks.localDataChanged()
    }

    /** Setting [ChatMode.OFF] purges the chat's stored messages and media on the server. */
    override suspend fun setChatMode(id: String, mode: ChatMode) {
        patchChat(
            id,
            buildJsonObject {
                put(
                    "mode",
                    when (mode) {
                        ChatMode.OFF -> "off"
                        ChatMode.ON -> "on"
                        ChatMode.MENTIONS_ONLY -> "mentions_only"
                    },
                )
            },
        )
        // The purge removes evidence links from tasks server-side. The change itself
        // succeeded, so a failed refresh is left to the next scheduled sync.
        if (mode == ChatMode.OFF) refreshQuietly()
    }

    override suspend fun setChatContext(id: String, contextId: String?) = patchChat(
        id,
        buildJsonObject {
            put("defaultContextId", contextId)
            put("contextConfirmed", true)
        },
    )

    override suspend fun confirmChatContext(id: String) = patchChat(id, buildJsonObject { put("contextConfirmed", true) })

    override suspend fun setChatAutoCreate(id: String, enabled: Boolean) = patchChat(id, buildJsonObject { put("autoCreate", enabled) })

    override suspend fun deleteChatData(id: String) {
        api.deleteChatData(id)
        // Evidence links on tasks are removed server-side: refresh.
        refreshQuietly()
    }

    private suspend fun refreshQuietly() {
        try {
            sync.sync()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The next scheduled sync catches up.
        }
    }

    // ------------------------------------------------------------ people

    private suspend fun refreshPerson(id: String) {
        db.people().upsert(listOf(api.person(id).toEntity()))
        hooks.localDataChanged()
    }

    suspend fun setPersonContext(id: String, contextId: String?) {
        api.patchPerson(id, buildJsonObject { put("defaultContextId", contextId) })
        refreshPerson(id)
    }

    suspend fun renamePerson(id: String, displayName: String) {
        api.patchPerson(id, buildJsonObject { put("displayName", displayName.trim()) })
        refreshPerson(id)
    }

    suspend fun addFact(personId: String, key: String, value: String) {
        api.addFact(personId, key, value.trim())
        refreshPerson(personId)
    }

    suspend fun editFact(personId: String, factId: String, value: String?, verified: Boolean?) {
        api.patchFact(
            personId,
            factId,
            buildJsonObject {
                value?.let { put("value", it.trim()) }
                verified?.let { put("verified", it) }
            },
        )
        refreshPerson(personId)
    }

    suspend fun deleteFact(personId: String, factId: String) {
        api.deleteFact(personId, factId)
        refreshPerson(personId)
    }

    suspend fun deletePersonData(id: String) {
        api.deletePersonData(id)
        db.people().delete(listOf(id))
        sync.sync()
    }

    // ------------------------------------------------------------ contexts

    suspend fun createContext(name: String, color: String?) {
        db.contexts().upsert(listOf(api.createContext(name.trim(), color).toEntity()))
        hooks.localDataChanged()
    }

    suspend fun updateContext(id: String, name: String, color: String?) {
        val ctx = api.patchContext(
            id,
            buildJsonObject {
                put("name", name.trim())
                put("color", color)
            },
        )
        db.contexts().upsert(listOf(ctx.toEntity()))
        hooks.localDataChanged()
    }

    suspend fun deleteContext(id: String, reassignTo: String?) {
        api.deleteContext(id, reassignTo)
        db.contexts().delete(listOf(id))
        // Tasks, chats and people may have been reassigned.
        sync.sync()
    }

    // ------------------------------------------------------------ settings

    suspend fun patchSettings(patch: JsonObject) {
        db.settings().upsert(api.patchSettings(patch).toEntity())
        hooks.localDataChanged()
    }

    // ------------------------------------------------------------ messages / ask

    suspend fun messagesAround(chatId: String, messageId: String?): List<MessageViewDto> =
        api.messagesAround(chatId, messageId).items

    suspend fun ask(request: AskRequestDto): AskResponseDto = api.ask(request)
}
