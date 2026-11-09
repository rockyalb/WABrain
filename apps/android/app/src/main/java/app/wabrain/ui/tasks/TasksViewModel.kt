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
import app.wabrain.domain.TaskSort
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
import kotlinx.coroutines.flow.update
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
    val sort: TaskSort = TaskSort.DEFAULT,
    val zone: ZoneId = Instants.zoneOrDefault(null),
    val endOfWorkDay: LocalTime = Instants.localTimeOrDefault(null),
    val now: Instant = Instant.now(),
    val completedToday: Int = 0,
    val createdToday: Int = 0,
    /** Closed tab with a contact picked: all their closed tasks from the server, past the synced week. */
    val closedSearch: ClosedSearch = ClosedSearch(),
)

/** Every closed task for one contact in the selected order, a page at a time. */
data class ClosedSearch(
    val personId: String? = null,
    val tasks: List<TaskEntity> = emptyList(),
    val nextCursor: String? = null,
    val loading: Boolean = false,
    val failed: Boolean = false,
    val sort: TaskSort = TaskSort.DEFAULT,
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
    private val sort = MutableStateFlow(TaskSort.DEFAULT)

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _error = MutableStateFlow<Throwable?>(null)
    val error: StateFlow<Throwable?> = _error.asStateFlow()

    private val _reviewTarget = MutableStateFlow<ReviewTargetState>(ReviewTargetState.None)
    val reviewTarget: StateFlow<ReviewTargetState> = _reviewTarget.asStateFlow()
    private var reviewTargetJob: Job? = null

    private val closedSearch = MutableStateFlow(ClosedSearch())
    private var closedSearchJob: Job? = null

    init {
        viewModelScope.launch {
            container.taskListPrefs.sort.collect { saved ->
                if (sort.value != saved) {
                    sort.value = saved
                    reloadClosedSearch()
                }
            }
        }
    }

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

    private val synced = combine(db.tasks().observeAll(), db.reviews().observeAll(), lookups, filter, ticker) { tasks, reviews, l, f, now ->
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
    }

    val state: StateFlow<TasksUiState> = combine(synced, closedSearch, sort) { s, search, order ->
        val chatCtx = s.chats.associate { it.id to it.defaultContextId }
        val personCtx = s.people.associate { it.id to it.defaultContextId }
        s.copy(
            sort = order,
            today = order.apply(s.today),
            upcoming = order.apply(s.upcoming),
            waiting = order.apply(s.waiting),
            recentlyClosed = order.apply(s.recentlyClosed),
            closedSearch = search.copy(tasks = if (search.sort == order) TaskGrouping.filterByContext(search.tasks, s.filter, chatCtx, personCtx) else emptyList()),
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), TasksUiState())

    fun setFilter(contextId: String?) {
        filter.value = contextId
    }

    fun setSort(order: TaskSort) {
        // DataStore is the source of truth; its emission also reloads any paginated search.
        viewModelScope.launch { container.taskListPrefs.setSort(order) }
    }

    fun refresh() {
        viewModelScope.launch {
            _refreshing.value = true
            try {
                container.outbox.flush()
                container.sync.sync()
                reloadClosedSearch()
                _error.value = null
            } catch (e: Exception) {
                _error.value = e
            } finally {
                _refreshing.value = false
            }
        }
    }

    /** Picks the contact whose closed tasks the Closed tab lists; null goes back to the last 7 days. */
    fun searchClosed(personId: String?) {
        if (personId == closedSearch.value.personId) return
        closedSearchJob?.cancel()
        if (personId == null) closedSearch.value = ClosedSearch() else loadClosed(personId, null)
    }

    fun loadMoreClosed() {
        val search = closedSearch.value
        val personId = search.personId ?: return
        val cursor = search.nextCursor ?: return
        if (!search.loading) loadClosed(personId, cursor)
    }

    /** Fetches the first page again, e.g. after a task was reopened from its detail screen. */
    fun reloadClosedSearch() {
        closedSearch.value.personId?.let { loadClosed(it, null) }
    }

    private fun loadClosed(personId: String, cursor: String?) {
        closedSearchJob?.cancel()
        val order = sort.value
        // A reload keeps the current list on screen until the new page arrives.
        closedSearch.update { if (it.personId == personId && it.sort == order) it.copy(loading = true, failed = false) else ClosedSearch(personId, loading = true, sort = order) }
        closedSearchJob = viewModelScope.launch {
            try {
                val page = container.api.listTasks("closed", cursor = cursor, personId = personId, limit = CLOSED_PAGE, sort = order.wireValue)
                ensureActive()
                val tasks = page.items.map { it.toEntity() }
                closedSearch.update { search ->
                    if (search.personId != personId || search.sort != order) return@update search
                    val merged = if (cursor == null) tasks else search.tasks + tasks.filter { task -> search.tasks.none { it.id == task.id } }
                    search.copy(tasks = merged, nextCursor = page.nextCursor, loading = false, failed = false)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                closedSearch.update { if (it.personId == personId && it.sort == order) it.copy(loading = false, failed = true) else it }
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

    private companion object {
        const val CLOSED_PAGE = 50
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
