package app.wabrain.ui.tasks

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.wabrain.AppContainer
import app.wabrain.R
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.ContextEntity
import app.wabrain.data.db.PersonEntity
import app.wabrain.data.db.TaskEntity
import app.wabrain.domain.DueBucket
import app.wabrain.domain.DueFormatter
import app.wabrain.domain.TaskGrouping
import app.wabrain.domain.TaskSource
import app.wabrain.notify.Notifier
import app.wabrain.ui.TaskTabs
import app.wabrain.ui.common.ContextFilterChips
import app.wabrain.ui.common.EmptyState
import app.wabrain.ui.common.ErrorBanner
import app.wabrain.ui.common.LoadingBox
import app.wabrain.ui.common.TaskDraft
import app.wabrain.ui.common.TaskEditorDialog
import app.wabrain.ui.common.errorText
import app.wabrain.ui.common.rememberDueFormatter
import app.wabrain.ui.theme.GlassSnackbar
import app.wabrain.ui.theme.GlossyFab
import app.wabrain.ui.theme.LocalGlass
import app.wabrain.ui.theme.WabIcons
import app.wabrain.ui.theme.WabLogo
import app.wabrain.ui.theme.glass
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    container: AppContainer,
    initialTab: Int,
    initialReviewItemId: String? = null,
    onOpenTask: (String) -> Unit,
    onOpenConversation: (String, String?) -> Unit,
    onOpenAsk: () -> Unit,
) {
    val vm: TasksViewModel = viewModel { TasksViewModel(container) }
    val state by vm.state.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val reviewTarget by vm.reviewTarget.collectAsStateWithLifecycle()
    var tab by rememberSaveable(initialTab) { mutableStateOf(initialTab) }
    var showCreate by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val formatter = rememberDueFormatter(state.zone)
    val context = LocalContext.current
    val completedMsg = stringResource(R.string.task_completed_snackbar)
    val undoLabel = stringResource(R.string.action_undo)

    fun completeWithUndo(task: TaskEntity) {
        vm.complete(task.id)
        scope.launch {
            snackbar.currentSnackbarData?.dismiss()
            val result = snackbar.showSnackbar(completedMsg, actionLabel = undoLabel, duration = SnackbarDuration.Short)
            if (result == SnackbarResult.ActionPerformed) vm.reopen(task.id)
        }
    }

    val today = remember(state.now, state.zone) { state.now.atZone(state.zone).toLocalDate() }
    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TasksHeader(
                date = remember(today) { today.format(DateTimeFormatter.ofPattern("EEEE d MMM", Locale.getDefault())) },
                openCount = state.today.size,
                completedToday = state.completedToday,
                createdToday = state.createdToday,
                showProgress = state.loaded,
                onRefresh = vm::refresh,
            )
        },
        floatingActionButton = {
            GlossyFab(onClick = { showCreate = true }, contentDescription = stringResource(R.string.task_new))
        },
        snackbarHost = { SnackbarHost(snackbar) { GlassSnackbar(it) } },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            AskBar(onOpenAsk, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            GlassTabs(tab = tab, reviewCount = state.review.size, onSelect = { tab = it }, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp))
            if (tab != TaskTabs.REVIEW) {
                ContextFilterChips(state.contexts, state.filter, vm::setFilter, Modifier.padding(vertical = 4.dp))
            }
            error?.let {
                ErrorBanner(errorText(it), Modifier.clickable { vm.dismissError() })
            }
            PullToRefreshBox(isRefreshing = refreshing, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize()) {
                when {
                    !state.loaded -> LoadingBox()
                    tab == TaskTabs.REVIEW -> ReviewList(
                        cards = state.review,
                        state = state,
                        formatter = formatter,
                        onDecide = { id, accept, edits ->
                            vm.decide(id, accept, edits)
                            Notifier.cancelReview(context, Notifier.reviewNotificationId(id))
                        },
                        onAcceptClosed = { id, status ->
                            vm.decide(id, true, closeAs = status)
                            Notifier.cancelReview(context, Notifier.reviewNotificationId(id))
                        },
                        onOpenTask = onOpenTask,
                        onOpenConversation = onOpenConversation,
                        targetItemId = initialReviewItemId,
                        targetState = reviewTarget,
                    )
                    tab == TaskTabs.CLOSED -> ClosedTaskList(state.recentlyClosed, state.chats, state.people, formatter, onOpenTask)
                    else -> {
                        val tasks = when (tab) {
                            TaskTabs.TODAY -> state.today
                            TaskTabs.UPCOMING -> state.upcoming
                            else -> state.waiting
                        }
                        val emptyText = stringResource(
                            when (tab) {
                                TaskTabs.TODAY -> R.string.empty_today
                                TaskTabs.UPCOMING -> R.string.empty_upcoming
                                else -> R.string.empty_waiting
                            },
                        )
                        if (tasks.isEmpty()) {
                            EmptyState(emptyText)
                        } else {
                            TaskList(tasks, state.contexts, state.chats, state.people, state.now, state.zone, formatter, onOpenTask, ::completeWithUndo)
                        }
                    }
                }
            }
        }
    }

    if (showCreate) {
        TaskEditorDialog(
            title = stringResource(R.string.task_new),
            initial = TaskDraft(contextId = state.filter),
            contexts = state.contexts,
            chats = state.chats,
            people = state.people,
            showLink = true,
            confirmLabel = stringResource(R.string.action_create),
            onConfirm = { vm.create(it) },
            onDismiss = { showCreate = false },
        )
    }

    LaunchedEffect(Unit) { vm.refresh() }
    LaunchedEffect(initialReviewItemId) {
        initialReviewItemId?.let(vm::resolveReviewTarget)
    }
}

/** Logo, title, date and the independent completed/created counts for today. */
@Composable
private fun TasksHeader(date: String, openCount: Int, completedToday: Int, createdToday: Int, showProgress: Boolean, onRefresh: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        WabLogo(38.dp)
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.nav_tasks), style = MaterialTheme.typography.titleLarge.copy(fontSize = 23.sp))
            Text(
                text = "$date · ${pluralStringResource(R.plurals.tasks_open, openCount, openCount)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (showProgress && (completedToday > 0 || createdToday > 0)) DailyActivity(completedToday, createdToday)
        IconButton(onClick = onRefresh) {
            Icon(WabIcons.Refresh, stringResource(R.string.action_refresh), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun DailyActivity(completedToday: Int, createdToday: Int) {
    val description = stringResource(R.string.tasks_activity_description, completedToday, createdToday)
    Column(
        Modifier
            .padding(horizontal = 4.dp)
            .clearAndSetSemantics { contentDescription = description },
        horizontalAlignment = Alignment.End,
    ) {
        Text("$completedToday / $createdToday", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        Text(
            stringResource(R.string.tasks_activity_caption),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
}

/** Glass pill that opens Ask. */
@Composable
private fun AskBar(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val g = LocalGlass.current
    val shape = RoundedCornerShape(23.dp)
    Row(
        modifier
            .fillMaxWidth()
            .height(46.dp)
            .glass(g, shape, elevation = 6.dp)
            .clip(shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = 14.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Icon(WabIcons.Sparkle, contentDescription = null, tint = g.accent, modifier = Modifier.size(21.dp))
        Text(
            stringResource(R.string.ask_placeholder),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
            maxLines = 1,
        )
        Text(
            stringResource(R.string.ask_ai_badge),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(g.accent.copy(alpha = 0.14f))
                .padding(horizontal = 9.dp, vertical = 4.dp),
        )
    }
}

/** Segmented glass tabs; the selected one lifts into a solid pill. */
@Composable
private fun GlassTabs(tab: Int, reviewCount: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val g = LocalGlass.current
    val labels = listOf(
        TaskTabs.TODAY to R.string.tab_today,
        TaskTabs.UPCOMING to R.string.tab_upcoming,
        TaskTabs.WAITING to R.string.tab_waiting,
        TaskTabs.REVIEW to R.string.tab_review,
        TaskTabs.CLOSED to R.string.tab_recently_closed,
    )
    val selectedPill = if (g.cardShadow) Color.White else g.navIndicator
    Row(
        modifier
            .fillMaxWidth()
            .glass(g, RoundedCornerShape(18.dp), elevation = 0.dp)
            .padding(4.dp)
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        labels.forEach { (id, label) ->
            val selected = tab == id
            val bg by animateColorAsState(if (selected) selectedPill else Color.Transparent, label = "tab")
            Row(
                Modifier
                    .clip(RoundedCornerShape(14.dp))
                    .background(bg)
                    .selectable(selected = selected, role = Role.Tab, onClick = { onSelect(id) })
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    stringResource(label),
                    style = MaterialTheme.typography.labelLarge,
                    color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
                if (id == TaskTabs.REVIEW && reviewCount > 0) {
                    Text(
                        reviewCount.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onError,
                        modifier = Modifier
                            .clip(RoundedCornerShape(50))
                            .background(MaterialTheme.colorScheme.error)
                            .padding(horizontal = 6.dp, vertical = 1.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun TaskList(
    tasks: List<TaskEntity>,
    contexts: List<ContextEntity>,
    chats: List<ChatEntity>,
    people: List<PersonEntity>,
    now: Instant,
    zone: ZoneId,
    formatter: DueFormatter,
    onOpen: (String) -> Unit,
    onComplete: (TaskEntity) -> Unit,
) {
    val contextsById = remember(contexts) { contexts.associateBy { it.id } }
    val chatsById = remember(chats) { chats.associateBy { it.id } }
    val peopleById = remember(people) { people.associateBy { it.id } }
    val noDue = stringResource(R.string.due_none)
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 6.dp, bottom = 100.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(tasks, key = { it.id }) { task ->
            val overdue = TaskGrouping.bucket(task, now, zone) == DueBucket.OVERDUE
            val due = task.dueAt
            val dueText = if (due != null) formatter.formatDue(due, task.dueHasTime, now) else noDue
            val context = contextsById[task.contextId]
            GlassTaskCard(
                title = if (task.kind == TaskGrouping.KIND_WAITING_ON) "⏳ ${task.title}" else task.title,
                source = TaskSource.of(task, chatsById, peopleById),
                meta = TaskMeta(
                    dueText = if (overdue) stringResource(R.string.due_overdue, dueText) else dueText,
                    overdue = overdue,
                    contextName = context?.name,
                    contextColor = context?.color,
                ),
                completeLabel = stringResource(R.string.task_complete_label, task.title),
                onOpen = { onOpen(task.id) },
                onComplete = { onComplete(task) },
                modifier = Modifier.animateItem(),
            )
        }
    }
}

/**
 * Recently closed tab: completed and cancelled tasks, including automatic
 * changes, each opening its detail screen where history and Undo live.
 */
@Composable
private fun ClosedTaskList(
    tasks: List<TaskEntity>,
    chats: List<ChatEntity>,
    people: List<PersonEntity>,
    formatter: DueFormatter,
    onOpen: (String) -> Unit,
) {
    val chatsById = remember(chats) { chats.associateBy { it.id } }
    val peopleById = remember(people) { people.associateBy { it.id } }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 2.dp, bottom = 100.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item(key = "closed-hint") {
            Text(
                stringResource(R.string.recently_closed_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
            )
        }
        if (tasks.isEmpty()) {
            item(key = "closed-empty") { EmptyState(stringResource(R.string.empty_recently_closed)) }
        }
        items(tasks, key = { it.id }) { task ->
            GlassClosedCard(
                title = task.title,
                source = TaskSource.of(task, chatsById, peopleById),
                closedText = formatter.formatInstant(task.closedAt ?: task.updatedAt),
                status = stringResource(if (task.status == "done") R.string.status_done else R.string.status_cancelled),
                onOpen = { onOpen(task.id) },
                modifier = Modifier.animateItem(),
            )
        }
    }
}
