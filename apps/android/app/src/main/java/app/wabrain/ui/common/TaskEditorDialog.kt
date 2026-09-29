package app.wabrain.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.wabrain.R
import app.wabrain.data.api.TaskKind
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.ContextEntity
import app.wabrain.data.db.PersonEntity
import java.time.LocalDate
import java.time.LocalTime

/** Values edited by [TaskEditorDialog]. */
data class TaskDraft(
    val title: String = "",
    val description: String = "",
    val kind: TaskKind = TaskKind.TODO,
    val dueDate: LocalDate? = null,
    val dueTime: LocalTime? = null,
    val contextId: String? = null,
    val chatId: String? = null,
    val personId: String? = null,
)

/** A chat or a person a manual task can be linked to. */
sealed class LinkTarget {
    data object None : LinkTarget()
    data class Chat(val id: String) : LinkTarget()
    data class Person(val id: String) : LinkTarget()
}

/**
 * Task create/edit form: title, kind, due date with optional time, context,
 * and (optionally) a linked chat or person.
 */
@Composable
fun TaskEditorDialog(
    title: String,
    initial: TaskDraft,
    contexts: List<ContextEntity>,
    chats: List<ChatEntity>,
    people: List<PersonEntity>,
    showLink: Boolean,
    confirmLabel: String,
    onConfirm: (TaskDraft) -> Unit,
    onDismiss: () -> Unit,
) {
    var draft by remember { mutableStateOf(initial) }
    var pickLink by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = draft.title,
                    onValueChange = { draft = draft.copy(title = it.take(180)) },
                    label = { Text(stringResource(R.string.task_title)) },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = draft.description,
                    onValueChange = { draft = draft.copy(description = it.take(4000)) },
                    label = { Text(stringResource(R.string.task_description)) },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                )
                KindSelector(draft.kind) { draft = draft.copy(kind = it) }
                DueEditor(draft.dueDate, draft.dueTime, onChange = { d, t -> draft = draft.copy(dueDate = d, dueTime = t) })
                Dropdown(
                    label = stringResource(R.string.task_context),
                    options = contextOptions(contexts, stringResource(R.string.context_inherit)),
                    selected = draft.contextId,
                    onSelect = { draft = draft.copy(contextId = it) },
                )
                if (showLink) {
                    val linkLabel = when {
                        draft.chatId != null -> chats.firstOrNull { it.id == draft.chatId }?.let { it.name ?: it.jid }
                        draft.personId != null -> people.firstOrNull { it.id == draft.personId }?.displayName
                        else -> null
                    }
                    Text(stringResource(R.string.task_link_label, linkLabel ?: stringResource(R.string.task_link_none)))
                    TextButton(onClick = { pickLink = true }) { Text(stringResource(R.string.task_link_pick)) }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = draft.title.isNotBlank(),
                onClick = { onConfirm(draft); onDismiss() },
            ) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
    if (pickLink) {
        val personPrefix = stringResource(R.string.link_person_prefix)
        val chatPrefix = stringResource(R.string.link_chat_prefix)
        val options = listOf<Pair<LinkTarget, String>>(LinkTarget.None to stringResource(R.string.task_link_none)) +
            people.map { LinkTarget.Person(it.id) to "$personPrefix ${it.displayName}" } +
            chats.map { LinkTarget.Chat(it.id) to "$chatPrefix ${it.name ?: it.jid}" }
        SearchPickerDialog(
            title = stringResource(R.string.task_link_pick),
            options = options,
            onPick = { target ->
                draft = when (target) {
                    LinkTarget.None -> draft.copy(chatId = null, personId = null)
                    is LinkTarget.Chat -> draft.copy(chatId = target.id, personId = chats.firstOrNull { it.id == target.id }?.personId)
                    is LinkTarget.Person -> draft.copy(personId = target.id, chatId = null)
                }
            },
            onDismiss = { pickLink = false },
        )
    }
}

@Composable
fun KindSelector(kind: TaskKind, onChange: (TaskKind) -> Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        SegmentedButton(
            selected = kind == TaskKind.TODO,
            onClick = { onChange(TaskKind.TODO) },
            shape = SegmentedButtonDefaults.itemShape(0, 2),
        ) { Text(stringResource(R.string.kind_todo)) }
        SegmentedButton(
            selected = kind == TaskKind.WAITING_ON,
            onClick = { onChange(TaskKind.WAITING_ON) },
            shape = SegmentedButtonDefaults.itemShape(1, 2),
        ) { Text(stringResource(R.string.kind_waiting_on)) }
    }
}
