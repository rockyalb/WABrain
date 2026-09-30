package app.wabrain.ui.tasks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.wabrain.AppContainer
import app.wabrain.data.api.TaskActionDto
import app.wabrain.data.api.ApiException
import app.wabrain.data.api.ReviewDecisionResponse
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.ContextEntity
import app.wabrain.data.db.PersonEntity
import app.wabrain.data.db.ReviewItemEntity
import app.wabrain.data.db.TaskEntity
import app.wabrain.data.db.action
import app.wabrain.data.db.dto
import app.wabrain.data.db.toEntity
import app.wabrain.data.repo.DueInput
import app.wabrain.data.repo.NewTask
import app.wabrain.domain.Instants
import app.wabrain.domain.TaskGrouping
import app.wabrain.ui.common.TaskDraft
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

data class ReviewCard(
    val item: ReviewItemEntity,
    val action: TaskActionDto?,
    /** The existing task this item affects, if cached. */
    val task: TaskEntity?,
    val chatName: String?,
    val personName: String?,
)

data class TasksUiState(
    val loaded: Boolean = false,
    val today: List<TaskEntity> = emptyList(),
    val upcoming: List<TaskEntity> = emptyList(),
    val waiting: List<TaskEntity> = emptyList(),
    val review: List<ReviewCard> = emptyList(),
    /** Completed or cancelled in the last week, including automatic changes; each opens its history and Undo. */
    val recentlyClosed: List<TaskEntity> = emptyList(),
    val contexts: List<ContextEntity> = emptyList(),
    val chats: List<ChatEntity> = emptyList(),
    val people: List<PersonEntity> = emptyList(),
    val filter: String? = null,
    val zone: ZoneId = Instants.zoneOrDefault(null),
    val endOfWorkDay: LocalTime = Instants.localTimeOrDefault(null),
    val now: Instant = Instant.now(),
    val completedToday: Int = 0,
    val createdToday: Int = 0,
)

data class DailyTaskActivity(val completedToday: Int, val createdToday: Int)

/** Independent daily counts; completed work may have been created before today. */
internal fun dailyTaskActivity(tasks: List<TaskEntity>, now: Instant, zone: ZoneId): DailyTaskActivity {
    val today = now.atZone(zone).toLocalDate()
    return DailyTaskActivity(
        completedToday = tasks.count { task ->
            task.status == "done" && task.closedAt?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() == today } == true
        },
        createdToday = tasks.count { task -> Instant.ofEpochMilli(task.createdAt).atZone(zone).toLocalDate() == today },
    )
}

sealed interface ReviewTargetState {
    data object None : ReviewTargetState
    data class Loading(val itemId: String) : ReviewTargetState
    data class Pending(val itemId: String) : ReviewTargetState
    data class Queued(val itemId: String) : ReviewTargetState
    data class Handled(
        val itemId: String,
        val decision: String,
        val taskId: String?,
        val taskTitle: String?,
    ) : ReviewTargetState
    data class Missing(val itemId: String) : ReviewTargetState
    data class Unavailable(val itemId: String) : ReviewTargetState
}

internal fun reviewTargetState(itemId: String, response: ReviewDecisionResponse): ReviewTargetState {
    val item = response.reviewItem ?: return ReviewTargetState.Missing(itemId)
    return if (item.state == "pending") {
        ReviewTargetState.Pending(itemId)
    } else {
        ReviewTargetState.Handled(itemId, item.state, response.task?.id, response.task?.title)
    }
}

class TasksViewModel(private val container: AppContainer) : ViewModel() {
    private val db = container.db
    private val filter = MutableStateFlow<String?>(null)

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _error = MutableStateFlow<Throwable?>(null)
    val error: StateFlow<Throwable?> = _error.asStateFlow()

    private val _reviewTarget = MutableStateFlow<ReviewTargetState>(ReviewTargetState.None)
    val reviewTarget: StateFlow<ReviewTargetState> = _reviewTarget.asStateFlow()
    private var reviewTargetJob: Job? = null

    /** Re-evaluates Today/overdue every minute. */
    private val ticker = flow {
        while (true) {
            emit(Instant.now())
            delay(60_000)
        }
    }

    private val lookups = combine(db.contexts().observeAll(), db.chats().observeAll(), db.people().observeAll(), db.settings().observe()) { c, ch, p, s ->
        Lookups(c, ch, p, s?.dto?.timezone, s?.dto?.endOfWorkDay)
    }

    val state: StateFlow<TasksUiState> = combine(db.tasks().observeAll(), db.reviews().observeAll(), lookups, filter, ticker) { tasks, reviews, l, f, now ->
        val zone = Instants.zoneOrDefault(l.timezone)
        val chatCtx = l.chats.associate { it.id to it.defaultContextId }
        val personCtx = l.people.associate { it.id to it.defaultContextId }
        val validFilter = f?.takeIf { id -> l.contexts.any { it.id == id } }
        val filtered = TaskGrouping.filterByContext(tasks, validFilter, chatCtx, personCtx)
        val chatNames = l.chats.associate { it.id to (it.name ?: it.jid) }
        val personNames = l.people.associate { it.id to it.displayName }
        val tasksById = tasks.associateBy { it.id }
        val activity = dailyTaskActivity(tasks, now, zone)
        TasksUiState(
            loaded = true,
            today = TaskGrouping.today(filtered, now, zone),
            upcoming = TaskGrouping.upcoming(filtered, now, zone),
            waiting = TaskGrouping.waitingOn(filtered, now, zone),
            recentlyClosed = TaskGrouping.recentlyClosed(filtered, now),
            review = reviews.map { r ->
                ReviewCard(r, r.action, r.taskId?.let(tasksById::get), r.chatId?.let(chatNames::get), r.personId?.let(personNames::get))
            },
            contexts = l.contexts,
            chats = l.chats,
            people = l.people,
            filter = validFilter,
            zone = zone,
            endOfWorkDay = Instants.localTimeOrDefault(l.endOfWorkDay),
            now = now,
            completedToday = activity.completedToday,
            createdToday = activity.createdToday,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), TasksUiState())

    fun setFilter(contextId: String?) {
        filter.value = contextId
    }

    fun refresh() {
        viewModelScope.launch {
            _refreshing.value = true
            try {
                container.outbox.flush()
                container.sync.sync()
                _error.value = null
            } catch (e: Exception) {
                _error.value = e
            } finally {
                _refreshing.value = false
            }
        }
    }

    fun dismissError() {
        _error.value = null
    }

    /** Resolves a notification target even when another device already decided it. */
    fun resolveReviewTarget(itemId: String): Job {
        reviewTargetJob?.cancel()
        return viewModelScope.launch {
            val localPending = container.db.reviews().get(itemId) != null
            _reviewTarget.value = if (localPending) ReviewTargetState.Pending(itemId) else ReviewTargetState.Loading(itemId)
            try {
                val response = container.api.review(itemId)
                ensureActive()
                val hasQueuedDecision = itemId in container.db.outbox().pendingReviewIds()
                when {
                    hasQueuedDecision -> _reviewTarget.value = ReviewTargetState.Queued(itemId)
                    response.reviewItem?.state == "pending" -> {
                        container.db.reviews().upsert(listOf(response.reviewItem.toEntity()))
                        _reviewTarget.value = ReviewTargetState.Pending(itemId)
                    }
                    else -> {
                        container.db.reviews().delete(listOf(itemId))
                        _reviewTarget.value = reviewTargetState(itemId, response)
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: ApiException) {
                if (error.status == 404) {
                    if (itemId in container.db.outbox().pendingReviewIds()) {
                        _reviewTarget.value = ReviewTargetState.Queued(itemId)
                    } else {
                        container.db.reviews().delete(listOf(itemId))
                        _reviewTarget.value = ReviewTargetState.Missing(itemId)
                    }
                } else if (!localPending) {
                    _reviewTarget.value = ReviewTargetState.Unavailable(itemId)
                }
            } catch (_: Exception) {
                if (!localPending) _reviewTarget.value = ReviewTargetState.Unavailable(itemId)
            }
        }.also { reviewTargetJob = it }
    }

    fun complete(id: String) = viewModelScope.launch { container.tasks.complete(id) }

    fun reopen(id: String) = viewModelScope.launch { container.tasks.reopen(id) }

    fun create(draft: TaskDraft) = viewModelScope.launch {
        container.tasks.create(draft.toNewTask())
    }

    fun decide(itemId: String, accept: Boolean, edits: JsonObject? = null, closeAs: String? = null) = viewModelScope.launch {
        container.tasks.decideReview(itemId, accept, edits, closeAs)
    }

    private data class Lookups(
        val contexts: List<ContextEntity>,
        val chats: List<ChatEntity>,
        val people: List<PersonEntity>,
        val timezone: String?,
        val endOfWorkDay: String?,
    )
}

fun TaskDraft.toNewTask(): NewTask = NewTask(
    title = title,
    kind = kind,
    description = description,
    due = dueDate?.let { DueInput(it, dueTime) },
    contextId = contextId,
    chatId = chatId,
    personId = personId,
)
