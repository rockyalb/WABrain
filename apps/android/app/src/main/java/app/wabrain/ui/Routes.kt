package app.wabrain.ui

import kotlinx.serialization.Serializable

@Serializable data class TasksRoute(val tab: Int = 0, val reviewItemId: String? = null)
@Serializable data class TaskDetailRoute(val id: String)
@Serializable data object PeopleRoute
@Serializable data class PersonRoute(val id: String)
@Serializable data object ChatsRoute
@Serializable data object AskRoute
@Serializable data object SettingsRoute
@Serializable data class ConversationRoute(val chatId: String, val messageId: String? = null)

object TaskTabs {
    const val TODAY = 0
    const val UPCOMING = 1
    const val WAITING = 2
    const val REVIEW = 3
    const val CLOSED = 4
}
