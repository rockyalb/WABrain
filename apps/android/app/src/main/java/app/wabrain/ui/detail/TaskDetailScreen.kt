package app.wabrain.ui.detail

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.wabrain.AppContainer
import app.wabrain.R
import app.wabrain.data.api.MessageViewDto
import app.wabrain.data.api.TaskEventDto
import app.wabrain.data.api.TaskKind
import app.wabrain.data.db.TaskEntity
import app.wabrain.data.repo.DueInput
import app.wabrain.data.repo.TaskEdit
import app.wabrain.domain.DueFormatter
import app.wabrain.ui.common.DueEditor
import app.wabrain.ui.common.Dropdown
import app.wabrain.ui.common.EmptyState
import app.wabrain.ui.common.ErrorBanner
import app.wabrain.ui.common.KindSelector
import app.wabrain.ui.common.LoadingBox
import app.wabrain.ui.common.SectionHeader
import app.wabrain.ui.common.contextOptions
import app.wabrain.ui.common.errorText
import app.wabrain.ui.common.rememberDueFormatter
import java.time.Instant
import java.time.ZoneId

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(
    container: AppContainer,
    taskId: String,
    onBack: () -> Unit,
    onOpenConversation: (String, String?) -> Unit,
) {
    val vm: TaskDetailViewModel = viewModel(key = "task-$taskId") { TaskDetailViewModel(container, taskId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val remote by vm.remote.collectAsStateWithLifecycle()
    val actionError by vm.actionError.collectAsStateWithLifecycle()
    val formatter = rememberDueFormatter(state.zone)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.task_detail_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back)) }
                },
            )
        },
    ) { padding ->
        val task = state.task
        when {
            !state.loaded -> LoadingBox(Modifier.padding(padding))
            task == null -> EmptyState(stringResource(R.string.task_not_found), Modifier.padding(padding))
            else -> Column(
                Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()),
            ) {
                actionError?.let { ErrorBanner(errorText(it), Modifier.clickable { vm.dismissError() }) }
                TaskEditor(task, state, vm)
                StatusButtons(task, vm)

                SectionHeader(stringResource(R.string.task_evidence))
                when {
                    remote.loading -> CircularProgressIndicator(Modifier.padding(16.dp))
                    remote.error != null -> Column(Modifier.padding(horizontal = 16.dp)) {
                        Text(errorText(remote.error!!), color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = vm::load) { Text(stringResource(R.string.action_retry)) }
                    }
                    remote.evidence.isEmpty() -> Text(stringResource(R.string.task_no_evidence), Modifier.padding(horizontal = 16.dp))
                    else -> remote.evidence.forEach { msg ->
                        MessageCard(msg, formatter, highlighted = false) { onOpenConversation(msg.chatId, msg.id) }
                    }
                }

                SectionHeader(stringResource(R.string.task_history))
                val undoable = remember(remote.events) { TaskDetailViewModel.undoableEventIds(remote.events, Instant.now()) }
                remote.events.forEach { event -> EventRow(event, formatter, event.id in undoable) { vm.undo(event.id) } }
                if (!remote.loading && remote.events.isEmpty() && remote.error == null) {
                    Text(stringResource(R.string.task_no_history), Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                }
            }
        }
    }
}

@Composable
private fun TaskEditor(task: TaskEntity, state: TaskDetailState, vm: TaskDetailViewModel) {
    val zone: ZoneId = state.zone
    val originalDue = task.dueAt?.let { Instant.ofEpochMilli(it).atZone(zone) }
    var title by remember(task.id, task.title) { mutableStateOf(task.title) }
    var description by remember(task.id, task.description) { mutableStateOf(task.description) }
    var kind by remember(task.id, task.kind) { mutableStateOf(TaskKind.fromWire(task.kind)) }
    var dueDate by remember(task.id, task.dueAt) { mutableStateOf(originalDue?.toLocalDate()) }
    var dueTime by remember(task.id, task.dueAt, task.dueHasTime) { mutableStateOf(if (task.dueHasTime) originalDue?.toLocalTime() else null) }
    var contextId by remember(task.id, task.contextId) { mutableStateOf(task.contextId) }

    val dueChanged = dueDate != originalDue?.toLocalDate() || dueTime != (if (task.dueHasTime) originalDue?.toLocalTime() else null)
    val changed = title != task.title || description != task.description || kind.wire != task.kind || dueChanged || contextId != task.contextId

    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(title, { title = it.take(180) }, label = { Text(stringResource(R.string.task_title)) }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(
            description,
            { description = it.take(4000) },
            label = { Text(stringResource(R.string.task_description)) },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
        )
        KindSelector(kind) { kind = it }
        DueEditor(dueDate, dueTime, onChange = { d, t -> dueDate = d; dueTime = t })
        Dropdown(
            label = stringResource(R.string.task_context_override),
            options = contextOptions(state.contexts, stringResource(R.string.context_inherit)),
            selected = contextId,
            onSelect = { contextId = it },
        )
        task.chatId?.let { id ->
            val chat = state.chats.firstOrNull { it.id == id }
            Text(stringResource(R.string.task_linked_chat, chat?.name ?: chat?.jid ?: id), style = MaterialTheme.typography.bodyMedium)
        }
        task.personId?.let { id ->
            val person = state.people.firstOrNull { it.id == id }
            Text(stringResource(R.string.task_linked_person, person?.displayName ?: id), style = MaterialTheme.typography.bodyMedium)
        }
        Button(
            enabled = changed && title.isNotBlank(),
            onClick = {
                vm.save(
                    TaskEdit(
                        title = title.takeIf { it != task.title },
                        description = description.takeIf { it != task.description },
                        kind = kind.takeIf { it.wire != task.kind },
                        dueChanged = dueChanged,
                        due = dueDate?.let { DueInput(it, dueTime) },
                        contextChanged = contextId != task.contextId,
                        contextId = contextId,
                    ),
                )
            },
        ) { Text(stringResource(R.string.action_save)) }
    }
}

@Composable
private fun StatusButtons(task: TaskEntity, vm: TaskDetailViewModel) {
    Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (task.status == "open") {
            Button(onClick = { vm.complete() }) { Text(stringResource(R.string.action_complete)) }
            OutlinedButton(onClick = { vm.cancel() }) { Text(stringResource(R.string.action_cancel_task)) }
        } else {
            Text(
                stringResource(if (task.status == "done") R.string.status_done else R.string.status_cancelled),
                modifier = Modifier.padding(top = 12.dp),
            )
            OutlinedButton(onClick = { vm.reopen() }) { Text(stringResource(R.string.action_reopen)) }
        }
    }
}

@Composable
fun MessageCard(msg: MessageViewDto, formatter: DueFormatter, highlighted: Boolean, onClick: (() -> Unit)?) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
        colors = if (highlighted) {
            androidx.compose.material3.CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
        } else {
            androidx.compose.material3.CardDefaults.cardColors()
        },
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val sender = if (msg.fromOwner) stringResource(R.string.message_you) else msg.senderName ?: stringResource(R.string.message_unknown_sender)
            Text("$sender · ${formatter.formatInstant(msg.at)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (msg.body.isNotBlank()) Text(msg.body, style = MaterialTheme.typography.bodyMedium)
            if (msg.kind != "text" && msg.body.isBlank()) {
                Text(stringResource(R.string.message_media, msg.kind), style = MaterialTheme.typography.bodySmall)
            }
            msg.derivedText?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic)
            }
        }
    }
}

@Composable
private fun EventRow(event: TaskEventDto, formatter: DueFormatter, undoable: Boolean, onUndo: () -> Unit) {
    ListItem(
        headlineContent = { Text(stringResource(eventLabel(event.type))) },
        supportingContent = {
            val actor = stringResource(
                when (event.actor) {
                    "ai" -> R.string.actor_ai
                    "owner" -> R.string.actor_owner
                    else -> R.string.actor_system
                },
            )
            val undone = if (event.undoneAt != null) " · " + stringResource(R.string.event_undone_marker) else ""
            Text("$actor · ${formatter.formatInstant(event.createdAt)}$undone")
        },
        trailingContent = {
            if (undoable) TextButton(onClick = onUndo) { Text(stringResource(R.string.action_undo)) }
        },
    )
}

private fun eventLabel(type: String): Int = when (type) {
    "created" -> R.string.event_created
    "edited" -> R.string.event_edited
    "completed" -> R.string.event_completed
    "reopened" -> R.string.event_reopened
    "cancelled" -> R.string.event_cancelled
    "rescheduled" -> R.string.event_rescheduled
    "merged" -> R.string.event_merged
    "undone" -> R.string.event_undone
    else -> R.string.event_other
}
