package app.wabrain.ui.detail

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.wabrain.AppContainer
import app.wabrain.data.api.MessageViewDto
import app.wabrain.data.api.TaskEventDto
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.ContextEntity
import app.wabrain.data.db.PersonEntity
import app.wabrain.data.db.TaskEntity
import app.wabrain.data.db.dto
import app.wabrain.data.repo.TaskEdit
import app.wabrain.domain.Instants
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

data class TaskDetailState(
    val loaded: Boolean = false,
    val task: TaskEntity? = null,
    val contexts: List<ContextEntity> = emptyList(),
    val chats: List<ChatEntity> = emptyList(),
    val people: List<PersonEntity> = emptyList(),
    val zone: ZoneId = Instants.zoneOrDefault(null),
)

/** Online part of the detail screen: history and evidence. */
data class TaskRemote(
    val loading: Boolean = true,
    val events: List<TaskEventDto> = emptyList(),
    val evidence: List<MessageViewDto> = emptyList(),
    val error: Throwable? = null,
)

class TaskDetailViewModel(private val container: AppContainer, private val taskId: String) : ViewModel() {
    private val db = container.db

    val state: StateFlow<TaskDetailState> = combine(
        db.tasks().observe(taskId),
        db.contexts().observeAll(),
        db.chats().observeAll(),
        db.people().observeAll(),
        db.settings().observe(),
    ) { task, contexts, chats, people, settings ->
        TaskDetailState(true, task, contexts, chats, people, Instants.zoneOrDefault(settings?.dto?.timezone))
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), TaskDetailState())

    private val _remote = MutableStateFlow(TaskRemote())
    val remote: StateFlow<TaskRemote> = _remote.asStateFlow()

    private val _actionError = MutableStateFlow<Throwable?>(null)
    val actionError: StateFlow<Throwable?> = _actionError.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            _remote.value = _remote.value.copy(loading = true, error = null)
            _remote.value = try {
                val detail = container.tasks.loadDetail(taskId)
                TaskRemote(loading = false, events = detail.events.sortedByDescending { it.createdAt }, evidence = detail.evidence)
            } catch (e: Exception) {
                _remote.value.copy(loading = false, error = e)
            }
        }
    }

    fun save(edit: TaskEdit) = viewModelScope.launch { container.tasks.update(taskId, edit) }
    fun complete() = viewModelScope.launch { container.tasks.complete(taskId) }
    fun reopen() = viewModelScope.launch { container.tasks.reopen(taskId) }
    fun cancel() = viewModelScope.launch { container.tasks.cancel(taskId) }

    fun undo(eventId: String) {
        viewModelScope.launch {
            try {
                container.tasks.undoEvent(eventId)
                _actionError.value = null
                load()
            } catch (e: Exception) {
                _actionError.value = e
            }
        }
    }

    fun dismissError() {
        _actionError.value = null
    }

    companion object {
        /**
         * Events that can still be undone, one per groupId (events sharing a
         * groupId are undone together, so only the newest shows Undo).
         */
        fun undoableEventIds(events: List<TaskEventDto>, now: Instant): Set<String> {
            val seenGroups = mutableSetOf<String>()
            return events.sortedByDescending { it.createdAt }.filter { e ->
                val until = e.undoableUntil?.let { runCatching { Instants.parse(it) }.getOrNull() }
                val undoable = e.undoneAt == null && until != null && until.isAfter(now)
                if (!undoable) return@filter false
                val group = e.groupId ?: return@filter true
                seenGroups.add(group)
            }.map { it.id }.toSet()
        }
    }
}
