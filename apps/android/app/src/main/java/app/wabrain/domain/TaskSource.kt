package app.wabrain.domain

import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.PersonEntity
import app.wabrain.data.db.TaskEntity

/**
 * Where a task came from, for the line shown above its title: the group and
 * who in it the task is about, or the contact of a direct chat.
 */
data class TaskSource(val groupName: String?, val personName: String?) {
    /** "Family · Mira" for a group, "Sam Carter" for a contact. */
    val label: String get() = listOfNotNull(groupName, personName).joinToString(" · ")

    companion object {
        /** Null for tasks with no chat and no person, such as ones added by hand. */
        fun of(task: TaskEntity, chatsById: Map<String, ChatEntity>, peopleById: Map<String, PersonEntity>): TaskSource? {
            val chat = task.chatId?.let(chatsById::get)
            val person = (task.personId ?: chat?.takeUnless { it.isGroup }?.personId)?.let(peopleById::get)?.displayName
            return when {
                chat == null -> person?.let { TaskSource(null, it) }
                chat.isGroup -> TaskSource(chat.displayName, person)
                else -> TaskSource(null, person ?: chat.displayName)
            }
        }
    }
}

/** The chat's WhatsApp name, or the number or group id from its JID when it has none. */
private val ChatEntity.displayName: String get() = name?.takeIf { it.isNotBlank() } ?: jid.substringBefore('@')
