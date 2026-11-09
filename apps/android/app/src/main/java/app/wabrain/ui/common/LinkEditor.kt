package app.wabrain.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.wabrain.R
import app.wabrain.data.api.TaskLinkDto
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.PersonEntity
import app.wabrain.domain.ComboFilter
import app.wabrain.domain.ComboOption
import app.wabrain.domain.LinkInput
import app.wabrain.domain.TaskLinks
import app.wabrain.domain.TaskSource

/**
 * The contacts a task involves, any of whose chats may close it: "→ Jordan" with a remove button,
 * "Who is “Robin”?" with the suggested chats first for a name the analysis could not match to one chat,
 * and "Add contact" for one more (telling Anja "I let him know" can close it too).
 * [onChange] gets the whole new list; the caller saves it at once or keeps it as a draft.
 */
@Composable
fun LinkEditor(
    links: List<TaskLinkDto>,
    ownChatId: String?,
    chats: List<ChatEntity>,
    people: List<PersonEntity>,
    onChange: (List<LinkInput>) -> Unit,
    modifier: Modifier = Modifier,
) {
    val chatsById = remember(chats) { chats.associateBy { it.id } }
    val peopleById = remember(people) { people.associateBy { it.id } }
    val nameOf = { chatId: String -> TaskSource.chatName(chatId, chatsById, peopleById) ?: chatId }
    // A direct chat's number lets "069…" find it as well as the name.
    val phoneOf = { chatId: String -> chatsById[chatId]?.takeUnless { it.isGroup }?.let { ComboFilter.jidPhone(it.jid) } }
    // Chats that could close it: not the task's own chat and not Off (Off chats are never read).
    val linkable = chats.filter { it.id != ownChatId && it.mode != "off" }.map { it.id }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        links.forEach { link ->
            val chatId = link.chatId
            val label = chatId?.let(nameOf) ?: link.name
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (chatId != null) {
                    Text("→ $label", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                } else {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(stringResource(R.string.task_links_who, link.name), style = MaterialTheme.typography.bodyLarge)
                        val suggested = link.candidates.map { it.chatId }.filter { it in linkable }
                        val options = suggested.map { ComboOption(it, stringResource(R.string.task_links_suggested, nameOf(it)), phoneOf(it)) } +
                            linkable.filter { it !in suggested && links.none { other -> other.chatId == it } }.map { ComboOption(it, nameOf(it), phoneOf(it)) }
                        SearchableDropdown(
                            label = stringResource(R.string.task_links_choose),
                            options = options,
                            selected = null,
                            onSelect = { picked -> picked?.let { onChange(TaskLinks.pick(links, link, it)) } },
                        )
                    }
                }
                IconButton(onClick = { onChange(TaskLinks.remove(links, link)) }) {
                    Icon(Icons.Filled.Close, stringResource(R.string.task_links_remove, label))
                }
            }
        }
        val addable = linkable.filter { id -> links.none { it.chatId == id } }
        if (links.size < 5 && addable.isNotEmpty()) {
            SearchableDropdown(
                label = stringResource(R.string.task_links_add),
                options = addable.map { ComboOption(it, nameOf(it), phoneOf(it)) },
                selected = null,
                onSelect = { chatId -> chatId?.let { TaskLinks.add(links, it) }?.let(onChange) },
            )
        }
    }
}
