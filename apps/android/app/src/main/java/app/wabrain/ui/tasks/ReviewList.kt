package app.wabrain.ui.tasks

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.wabrain.R
import app.wabrain.data.api.ReviewHandledDto
import app.wabrain.data.api.ReviewItemType
import app.wabrain.data.api.TaskActionDto
import app.wabrain.data.api.TaskLinkDto
import app.wabrain.data.db.links
import app.wabrain.data.db.handled
import app.wabrain.data.db.reviewType
import app.wabrain.domain.DueFormatter
import app.wabrain.domain.Instants
import app.wabrain.domain.LinkInput
import app.wabrain.domain.TaskLinks
import app.wabrain.domain.TaskSource
import app.wabrain.ui.common.Badge
import app.wabrain.ui.common.BadgeRow
import app.wabrain.ui.common.EmptyState
import app.wabrain.ui.common.LinkEditor
import app.wabrain.ui.common.TaskDraft
import app.wabrain.ui.common.TaskEditorDialog
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import kotlin.math.roundToInt

@Composable
fun ReviewList(
    cards: List<ReviewCard>,
    state: TasksUiState,
    formatter: DueFormatter,
    onDecide: (String, Boolean, JsonObject?) -> Unit,
    onAcceptClosed: (String, String) -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenConversation: (String, String?) -> Unit,
    targetItemId: String? = null,
    targetState: ReviewTargetState = ReviewTargetState.None,
) {
    if (cards.isEmpty() && targetState == ReviewTargetState.None) {
        EmptyState(stringResource(R.string.empty_review))
        return
    }
    var editing by remember { mutableStateOf<ReviewCard?>(null) }
    // Contact changes made on a card, sent with its Accept.
    val linkDrafts = remember { mutableStateMapOf<String, List<LinkInput>>() }
    val decide = { id: String, accept: Boolean, edits: JsonObject? ->
        val links = linkDrafts.remove(id)
        val withLinks = if (accept && links != null) JsonObject((edits ?: JsonObject(emptyMap())) + ("links" to TaskLinks.toJson(links))) else edits
        onDecide(id, accept, withLinks)
    }
    val listState = rememberLazyListState()
    val targetIndex = cards.indexOfFirst { it.item.id == targetItemId }
    val targetNoticeBeforeCards = targetState is ReviewTargetState.Loading ||
        targetState is ReviewTargetState.Queued ||
        targetState is ReviewTargetState.Handled ||
        targetState is ReviewTargetState.Missing ||
        targetState is ReviewTargetState.Unavailable
    LaunchedEffect(targetItemId, targetIndex, targetNoticeBeforeCards) {
        if (targetIndex >= 0) listState.animateScrollToItem(targetIndex + if (targetNoticeBeforeCards) 1 else 0)
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        state = listState,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when (val target = targetState) {
            is ReviewTargetState.Loading -> item(key = "review-target-loading") {
                ReviewTargetNotice(stringResource(R.string.review_target_loading))
            }
            is ReviewTargetState.Handled -> item(key = "review-target-handled") {
                ReviewTargetNotice(
                    message = stringResource(
                        if (target.decision == "rejected") R.string.review_target_rejected else R.string.review_target_accepted,
                    ),
                    taskTitle = target.taskTitle,
                    onOpenTask = target.taskId?.let { id -> { onOpenTask(id) } },
                )
            }
            is ReviewTargetState.Queued -> item(key = "review-target-queued") {
                ReviewTargetNotice(stringResource(R.string.review_target_queued))
            }
            is ReviewTargetState.Missing -> item(key = "review-target-missing") {
                ReviewTargetNotice(stringResource(R.string.review_target_missing))
            }
            is ReviewTargetState.Unavailable -> item(key = "review-target-unavailable") {
                ReviewTargetNotice(stringResource(R.string.review_target_unavailable))
            }
            ReviewTargetState.None, is ReviewTargetState.Pending -> Unit
        }
        if (cards.isEmpty() && targetState is ReviewTargetState.Pending) {
            item(key = "review-target-waiting") { ReviewTargetNotice(stringResource(R.string.review_target_loading)) }
        }
        itemsIndexed(cards, key = { _, card -> card.item.id }) { _, card ->
            ReviewCardView(
                card,
                state,
                formatter,
                decide,
                onAcceptClosed,
                onEdit = { editing = card },
                onOpenTask,
                onOpenConversation,
                highlighted = card.item.id == targetItemId,
                linkDraft = linkDrafts[card.item.id],
                onLinksChange = { linkDrafts[card.item.id] = it },
            )
        }
    }
    editing?.let { card ->
        val create = card.action as? TaskActionDto.Create
        val due = create?.dueAt?.let { Instants.parse(it).atZone(state.zone) }
        TaskEditorDialog(
            title = stringResource(R.string.review_edit_accept),
            initial = TaskDraft(
                title = create?.title.orEmpty(),
                description = create?.description.orEmpty(),
                kind = create?.kind ?: app.wabrain.data.api.TaskKind.TODO,
                dueDate = due?.toLocalDate(),
                dueTime = if (create?.dueHasTime == true) due?.toLocalTime() else null,
                contextId = create?.contextId,
            ),
            contexts = state.contexts,
            chats = state.chats,
            people = state.people,
            showLink = false,
            confirmLabel = stringResource(R.string.action_accept),
            onConfirm = { draft -> decide(card.item.id, true, editsFor(create, draft, state)) },
            onDismiss = { editing = null },
        )
    }
}

/** Builds the `edits` object: only fields that differ from the proposal. */
private fun editsFor(original: TaskActionDto.Create?, draft: TaskDraft, state: TasksUiState): JsonObject = buildJsonObject {
    if (draft.title.trim() != original?.title) put("title", draft.title.trim())
    if (draft.description.trim() != original?.description.orEmpty()) put("description", draft.description.trim())
    if (draft.kind != original?.kind) put("kind", draft.kind.wire)
    if (draft.contextId != original?.contextId) put("contextId", draft.contextId)
    val originalDue = original?.dueAt?.let { Instants.parse(it).atZone(state.zone) }
    val dueChanged = draft.dueDate != originalDue?.toLocalDate() ||
        (draft.dueTime != null) != (original?.dueHasTime == true) ||
        (draft.dueTime != null && draft.dueTime != originalDue?.toLocalTime())
    if (dueChanged) {
        val date = draft.dueDate
        if (date == null) {
            put("dueAt", null as String?)
        } else {
            put("dueAt", app.wabrain.data.repo.DueInput(date, draft.dueTime).wireValue(state.zone))
        }
    }
}

@Composable
private fun ReviewCardView(
    card: ReviewCard,
    state: TasksUiState,
    formatter: DueFormatter,
    onDecide: (String, Boolean, JsonObject?) -> Unit,
    onAcceptClosed: (String, String) -> Unit,
    onEdit: () -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenConversation: (String, String?) -> Unit,
    highlighted: Boolean = false,
    linkDraft: List<LinkInput>? = null,
    onLinksChange: (List<LinkInput>) -> Unit = {},
) {
    val type = card.item.reviewType
    val action = card.action
    // The contacts a new task (or a task created on its own) involves, with the owner's unsaved changes.
    val proposedLinks: List<TaskLinkDto>? = when (action) {
        is TaskActionDto.Create -> action.links
        is TaskActionDto.Link -> card.task?.links ?: action.links
        else -> null
    }
    val shownLinks = proposedLinks?.let { original ->
        val chatsById = state.chats.associateBy { it.id }
        val peopleById = state.people.associateBy { it.id }
        val ownChatId = card.task?.chatId ?: card.item.chatId
        linkDraft?.let { TaskLinks.apply(original, it, ownChatId) { id -> TaskSource.chatName(id, chatsById, peopleById) } } ?: original
    }
    val needsPick = type == ReviewItemType.LINK && shownLinks.orEmpty().any { it.chatId == null }
    // A later message suggests this proposal was already dealt with before it was reviewed.
    val handled = if (type == ReviewItemType.CREATE) card.item.handled else null
    val borderColor by animateColorAsState(
        if (highlighted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
        animationSpec = tween(350),
        label = "review target border",
    )
    Card(
        Modifier.fillMaxWidth(),
        border = BorderStroke(if (highlighted) 2.dp else 1.dp, borderColor),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            BadgeRow {
                Badge(stringResource(if (needsPick) R.string.review_type_link_pick else reviewTypeLabel(type)))
                action?.let { Badge(stringResource(R.string.confidence_percent, (it.confidence * 100).roundToInt())) }
                card.chatName?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            if (type != ReviewItemType.LINK) Text(card.item.summary, style = MaterialTheme.typography.bodyLarge)
            when (action) {
                is TaskActionDto.Create -> {
                    Text(action.title, style = MaterialTheme.typography.titleMedium)
                    action.dueAt?.let {
                        Text(stringResource(R.string.review_due, formatter.formatDue(Instants.parseMillis(it), action.dueHasTime, Instant.now())))
                    }
                }
                is TaskActionDto.Link -> {
                    Text(card.task?.title ?: card.item.summary, style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.review_link_explainer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                is TaskActionDto.Reschedule -> Text(
                    stringResource(R.string.review_new_due, formatter.formatDue(Instants.parseMillis(action.dueAt), action.dueHasTime, Instant.now())),
                )
                is TaskActionDto.Merge -> Text(stringResource(R.string.review_merge_count, action.taskIds.size))
                else -> Unit
            }
            shownLinks?.let { links ->
                LinkEditor(links, card.task?.chatId ?: card.item.chatId, state.chats, state.people, onChange = onLinksChange)
            }
            card.task?.let { task ->
                TextButton(onClick = { onOpenTask(task.id) }) { Text(stringResource(R.string.review_task_link, task.title)) }
            }
            if (!action?.ambiguityReasons.isNullOrEmpty()) {
                Text(
                    stringResource(R.string.review_ambiguity, action.ambiguityReasons.joinToString("; ")),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            val evidence = action?.evidenceMessageIds.orEmpty()
            val chatId = card.item.chatId
            if (evidence.isNotEmpty() && chatId != null) {
                TextButton(onClick = { onOpenConversation(chatId, evidence.first()) }) {
                    Text(pluralStringResource(R.plurals.review_evidence, evidence.size, evidence.size))
                }
            }
            handled?.let { hint ->
                HandledHint(hint, card, onOpenConversation)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (handled != null) {
                    Button(onClick = { onAcceptClosed(card.item.id, handled.status) }) {
                        Text(stringResource(if (handled.status == "cancelled") R.string.action_no_longer_needed else R.string.action_already_done))
                    }
                    OutlinedButton(onClick = { onDecide(card.item.id, true, null) }) { Text(stringResource(R.string.action_keep_open)) }
                    TextButton(onClick = { onDecide(card.item.id, false, null) }) { Text(stringResource(R.string.action_reject)) }
                } else if (type == ReviewItemType.LINK) {
                    Button(onClick = { onDecide(card.item.id, true, null) }) { Text(stringResource(R.string.action_accept)) }
                    OutlinedButton(onClick = { onDecide(card.item.id, false, null) }) { Text(stringResource(R.string.action_remove)) }
                } else if (type.isConfirmation) {
                    Button(onClick = { onDecide(card.item.id, true, null) }) { Text(stringResource(R.string.action_done)) }
                    OutlinedButton(onClick = { onDecide(card.item.id, false, null) }) { Text(stringResource(R.string.action_not_yet)) }
                } else {
                    Button(onClick = { onDecide(card.item.id, true, null) }) { Text(stringResource(R.string.action_accept)) }
                    if (type == ReviewItemType.CREATE) {
                        OutlinedButton(onClick = onEdit) { Text(stringResource(R.string.action_edit)) }
                    }
                    OutlinedButton(onClick = { onDecide(card.item.id, false, null) }) { Text(stringResource(R.string.action_reject)) }
                }
            }
        }
    }
}

@Composable
private fun ReviewTargetNotice(
    message: String,
    taskTitle: String? = null,
    onOpenTask: (() -> Unit)? = null,
) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(message, style = MaterialTheme.typography.bodyMedium)
            if (onOpenTask != null) {
                TextButton(onClick = onOpenTask, contentPadding = PaddingValues(0.dp)) {
                    Text(taskTitle?.let { stringResource(R.string.review_task_link, it) } ?: stringResource(R.string.review_target_open_task))
                }
            }
        }
    }
}

/** "May already be done", the quoted message, who wrote it, and a link to it in the chat. */
@Composable
private fun HandledHint(hint: ReviewHandledDto, card: ReviewCard, onOpenConversation: (String, String?) -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                stringResource(if (hint.status == "cancelled") R.string.review_handled_cancelled else R.string.review_handled_done),
                style = MaterialTheme.typography.labelLarge,
            )
            val author = if (hint.fromOwner) stringResource(R.string.review_handled_you) else card.personName ?: card.chatName.orEmpty()
            if (hint.excerpt.isNotBlank()) {
                Text(stringResource(R.string.review_handled_quote, hint.excerpt, author), style = MaterialTheme.typography.bodyMedium)
            }
            val chatId = card.item.chatId
            val messageId = hint.evidenceMessageIds.firstOrNull()
            if (chatId != null && messageId != null) {
                TextButton(onClick = { onOpenConversation(chatId, messageId) }, contentPadding = PaddingValues(0.dp)) {
                    Text(stringResource(R.string.review_view_message))
                }
            }
        }
    }
}

fun reviewTypeLabel(type: ReviewItemType): Int = when (type) {
    ReviewItemType.CREATE -> R.string.review_type_create
    ReviewItemType.POSSIBLY_DONE -> R.string.review_type_possibly_done
    ReviewItemType.POSSIBLY_CANCELLED -> R.string.review_type_possibly_cancelled
    ReviewItemType.RESCHEDULE -> R.string.review_type_reschedule
    ReviewItemType.MERGE -> R.string.review_type_merge
    ReviewItemType.LINK -> R.string.review_type_link
    ReviewItemType.UNKNOWN -> R.string.review_type_unknown
}
