package app.wabrain.domain

import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.PersonEntity
import app.wabrain.data.db.TaskEntity
import app.wabrain.data.db.links

/**
 * Where a task came from, for the line shown above its title: the group and
 * who in it the task is about, or the contact of a direct chat; and the other
 * chats it involves ("→ Jordan"), with names still to be confirmed ("→ Robin?").
 */
data class TaskSource(
    val groupName: String?,
    val personName: String?,
    val linkedTo: List<String> = emptyList(),
    val unconfirmed: List<String> = emptyList(),
) {
    /** "Family · Mira" for a group, "Sam Carter" for a contact. */
    val label: String get() = listOfNotNull(groupName, personName).joinToString(" · ")

    /** "→ Jordan, Robin?" or null when the task involves no other chat. */
    val linkLabel: String?
        get() = (linkedTo + unconfirmed.map { "$it?" }).takeIf { it.isNotEmpty() }?.joinToString(", ", prefix = "→ ")

    companion object {
        /** Null for tasks with no chat and no person, such as ones added by hand. */
        fun of(task: TaskEntity, chatsById: Map<String, ChatEntity>, peopleById: Map<String, PersonEntity>): TaskSource? {
            val chat = task.chatId?.let(chatsById::get)
            val person = (task.personId ?: chat?.takeUnless { it.isGroup }?.personId)?.let(peopleById::get)?.displayName
            val links = task.links
            val linkedTo = links.mapNotNull { link -> link.chatId?.let { chatName(it, chatsById, peopleById) ?: link.name } }
            val unconfirmed = links.filter { it.chatId == null }.map { it.name }
            val source = when {
                chat == null -> person?.let { TaskSource(null, it) }
                chat.isGroup -> TaskSource(chat.displayName, person)
                else -> TaskSource(null, person ?: chat.displayName)
            }
            if (linkedTo.isEmpty() && unconfirmed.isEmpty()) return source
            return (source ?: TaskSource(null, null)).copy(linkedTo = linkedTo, unconfirmed = unconfirmed)
        }

        /** A chat's name as the owner knows it: the contact's name for a direct chat, else the chat name. */
        fun chatName(chatId: String, chatsById: Map<String, ChatEntity>, peopleById: Map<String, PersonEntity>): String? {
            val chat = chatsById[chatId] ?: return null
            val person = chat.takeUnless { it.isGroup }?.personId?.let(peopleById::get)?.displayName
            return person ?: chat.displayName
        }
    }
}

/** The chat's WhatsApp name, or the number or group id from its JID when it has none. */
private val ChatEntity.displayName: String get() = name?.takeIf { it.isNotBlank() } ?: jid.substringBefore('@')
