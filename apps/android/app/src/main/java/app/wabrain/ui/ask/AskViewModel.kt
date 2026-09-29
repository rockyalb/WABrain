package app.wabrain.ui.ask

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.wabrain.data.api.ApiException
import app.wabrain.data.api.AskRequestDto
import app.wabrain.data.api.AskResponseDto
import app.wabrain.data.api.TaskActionDto
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.repo.NewTask
import app.wabrain.domain.Instants
import app.wabrain.ui.common.TaskDraft
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Filters that limit which messages an answer may come from. Null means no limit. */
data class AskFilters(
    val personId: String? = null,
    val contextId: String? = null,
    val from: LocalDate? = null,
    val to: LocalDate? = null,
) {
    val isActive: Boolean get() = personId != null || contextId != null || from != null || to != null

    /** A range whose start is after its end can match nothing. */
    val isRangeValid: Boolean get() = from == null || to == null || !from.isAfter(to)

    /**
     * Builds the request. [from] starts at midnight and [to] ends at the last
     * millisecond of its day, both in the server's timezone [zone]. The server
     * treats both bounds as inclusive (at millisecond precision), so the next
     * day's midnight is not included.
     */
    fun toRequest(question: String, zone: ZoneId): AskRequestDto = AskRequestDto(
        question = question.trim().take(MAX_QUESTION),
        personId = personId,
        contextId = contextId,
        from = from?.atStartOfDay(zone)?.toOffsetDateTime()?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
        to = to?.plusDays(1)?.atStartOfDay(zone)?.minusNanos(1_000_000)?.toOffsetDateTime()?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
    )

    companion object {
        /** AskRequestSchema.question max length. */
        const val MAX_QUESTION = 1000
    }
}

/** What an exchange shows under the question. */
sealed class AskOutcome {
    data object Pending : AskOutcome()

    data class Answered(val response: AskResponseDto) : AskOutcome()

    /** The server searched and found nothing: say so instead of guessing. */
    data object NotFound : AskOutcome()

    /** The server does not offer Ask yet (HTTP 501). */
    data object Unavailable : AskOutcome()

    /** No text model is configured on the server (HTTP 409): the owner sets one on the setup page. */
    data object NoTextModel : AskOutcome()

    /**
     * HTTP 429: the device asked too often (code `rate_limited`, [dailyLimit]
     * false), or the text model's daily budget is used up (code
     * `budget_exceeded`, [dailyLimit] true). [retryAt] comes from `Retry-After`.
     */
    data class RateLimited(val retryAt: Instant, val dailyLimit: Boolean) : AskOutcome()

    /** The text model failed or did not answer (HTTP 503); trying again later may work. */
    data object ModelUnavailable : AskOutcome()

    data class Failed(val error: Throwable) : AskOutcome()

    /**
     * The owner may ask the same question again: after a device rate limit only
     * from [RateLimited.retryAt]; after the daily budget at any time, because
     * the owner may have raised it.
     */
    val isRetryable: Boolean
        get() = this is Failed || this is RateLimited || this == NoTextModel || this == ModelUnavailable

    companion object {
        /** The device limit refills one question every 6 s; without a Retry-After, wait this long. */
        val DEFAULT_RATE_LIMIT_WAIT: Duration = Duration.ofSeconds(10)

        /** The server's error code for an exhausted daily model budget (also HTTP 429). */
        const val BUDGET_EXCEEDED = "budget_exceeded"

        fun from(response: AskResponseDto): AskOutcome = if (response.found) Answered(response) else NotFound

        fun from(error: Throwable, now: Instant = Instant.now()): AskOutcome {
            if (error !is ApiException) return Failed(error)
            return when (error.status) {
                501 -> Unavailable
                409 -> NoTextModel
                503 -> ModelUnavailable
                429 -> {
                    val wait = error.retryAfterSeconds?.let(Duration::ofSeconds) ?: DEFAULT_RATE_LIMIT_WAIT
                    RateLimited(now.plus(wait), dailyLimit = error.code == BUDGET_EXCEEDED)
                }
                else -> Failed(error)
            }
        }
    }
}

/**
 * The chat a suggested task should be linked to, so the owner's later messages
 * there can close it: the chat of a citation that is also evidence for the
 * suggestion, else the chat of the first citation.
 */
fun suggestedChatId(response: AskResponseDto): String? {
    val evidence = response.suggestedAction?.evidenceMessageIds.orEmpty().toSet()
    return (response.citations.firstOrNull { it.messageId in evidence } ?: response.citations.firstOrNull())?.chatId
}

/**
 * Pre-fills the task editor from a suggestion, linked to the chat it came from
 * when the app knows that chat. A suggestion without a context of its own takes
 * that chat's default context.
 */
fun suggestionDraft(action: TaskActionDto.Create, response: AskResponseDto, chats: List<ChatEntity>, zone: ZoneId): TaskDraft {
    val due = action.dueAt?.let { runCatching { Instants.parse(it).atZone(zone) }.getOrNull() }
    val chat = suggestedChatId(response)?.let { id -> chats.firstOrNull { it.id == id } }
    return TaskDraft(
        title = action.title,
        description = action.description,
        kind = action.kind,
        dueDate = due?.toLocalDate(),
        dueTime = if (action.dueHasTime) due?.toLocalTime() else null,
        contextId = action.contextId ?: chat?.defaultContextId,
        chatId = chat?.id,
        personId = chat?.personId,
    )
}

/** The state of the suggested task on an answer. It is created only when the owner taps it. */
enum class SuggestionState { OFFERED, CREATING, CREATED }

data class AskExchange(
    val id: Long,
    val question: String,
    val filters: AskFilters,
    val outcome: AskOutcome = AskOutcome.Pending,
    val suggestion: SuggestionState = SuggestionState.OFFERED,
) {
    val suggestedAction: TaskActionDto.Create? get() = (outcome as? AskOutcome.Answered)?.response?.suggestedAction
}

data class AskUiState(
    val filters: AskFilters = AskFilters(),
    val exchanges: List<AskExchange> = emptyList(),
    /** Set once the server answered 501; the screen explains that Ask is not available yet. */
    val unavailable: Boolean = false,
    /** After a 429, new questions wait until this instant. Cleared once it has passed or a later question got through. */
    val waitUntil: Instant? = null,
    /** The current wait comes from the daily budget, which the owner can raise at any time: Retry stays available. */
    val waitIsBudget: Boolean = false,
    val suggestionError: Throwable? = null,
) {
    val busy: Boolean get() = exchanges.any { it.outcome == AskOutcome.Pending }

    val waiting: Boolean get() = waitUntil != null

    fun canSend(question: String): Boolean = question.isNotBlank() && !busy && !waiting && filters.isRangeValid

    /**
     * During a device rate limit nothing is retried. During a daily-budget wait
     * only a budget-limited question may be retried by hand, so raising the
     * budget on the setup page does not leave this screen blocked until midnight.
     */
    fun canRetry(exchange: AskExchange): Boolean = exchange.outcome.isRetryable && !busy &&
        (!waiting || (waitIsBudget && (exchange.outcome as? AskOutcome.RateLimited)?.dailyLimit == true))
}

/**
 * Ask your chats. The screen is read-only: asking never changes data, and a
 * suggested task is created only by [createSuggested], which the screen calls
 * after the owner taps the suggestion and confirms the editor.
 *
 * Nothing is retried automatically. After a device rate limit the screen lets
 * the owner ask again only once `Retry-After` has passed. After the daily
 * budget (code `budget_exceeded`) new questions wait too, but the owner can
 * retry the limited question by hand; once it gets through, the wait is lifted.
 */
class AskViewModel(
    private val ask: suspend (AskRequestDto) -> AskResponseDto,
    private val createTask: suspend (NewTask) -> String,
    private val clock: () -> Instant = Instant::now,
) : ViewModel() {
    private val _state = MutableStateFlow(AskUiState())
    val state: StateFlow<AskUiState> = _state.asStateFlow()
    private var nextId = 0L
    private var waitJob: Job? = null

    fun setPerson(id: String?) = _state.update { it.copy(filters = it.filters.copy(personId = id)) }

    fun setContext(id: String?) = _state.update { it.copy(filters = it.filters.copy(contextId = id)) }

    fun setFrom(date: LocalDate?) = _state.update { it.copy(filters = it.filters.copy(from = date)) }

    fun setTo(date: LocalDate?) = _state.update { it.copy(filters = it.filters.copy(to = date)) }

    fun clearDates() = _state.update { it.copy(filters = it.filters.copy(from = null, to = null)) }

    /** Sends [question] with the current filters. Returns false when nothing was sent. */
    fun send(question: String, zone: ZoneId): Boolean {
        val current = _state.value
        if (!current.canSend(question)) return false
        val filters = current.filters
        val request = filters.toRequest(question, zone)
        val id = nextId++
        _state.update { it.copy(exchanges = it.exchanges + AskExchange(id, request.question, filters)) }
        launchAsk(id, request)
        return true
    }

    /** Asks a question that got no answer again, with the filters it was first asked with. */
    fun retry(exchangeId: Long, zone: ZoneId) {
        val current = _state.value
        val exchange = current.exchanges.firstOrNull { it.id == exchangeId } ?: return
        if (!current.canRetry(exchange)) return
        _state.update { s -> s.copy(exchanges = s.exchanges.map { if (it.id == exchangeId) it.copy(outcome = AskOutcome.Pending) else it }) }
        launchAsk(exchangeId, exchange.filters.toRequest(exchange.question, zone))
    }

    private fun launchAsk(id: Long, request: AskRequestDto) {
        viewModelScope.launch {
            val outcome = try {
                AskOutcome.from(ask(request))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AskOutcome.from(e, clock())
            }
            _state.update { s ->
                s.copy(
                    exchanges = s.exchanges.map { if (it.id == id) it.copy(outcome = outcome) else it },
                    unavailable = s.unavailable || outcome == AskOutcome.Unavailable,
                )
            }
            when {
                outcome is AskOutcome.RateLimited -> waitUntil(outcome.retryAt, outcome.dailyLimit)
                // The server took the question (it answered, or failed for another reason): any earlier wait is over.
                outcome !is AskOutcome.Failed -> clearWait()
            }
        }
    }

    /** Blocks sending and retrying until [until], then lifts the block. It never sends anything itself. */
    private fun waitUntil(until: Instant, budget: Boolean) {
        waitJob?.cancel()
        _state.update { it.copy(waitUntil = until, waitIsBudget = budget) }
        waitJob = viewModelScope.launch {
            val millis = Duration.between(clock(), until).toMillis()
            if (millis > 0) delay(millis)
            _state.update { if (it.waitUntil == until) it.copy(waitUntil = null, waitIsBudget = false) else it }
        }
    }

    private fun clearWait() {
        waitJob?.cancel()
        waitJob = null
        _state.update { it.copy(waitUntil = null, waitIsBudget = false) }
    }

    /** Creates the (possibly edited) suggested task of exchange [exchangeId], once. */
    fun createSuggested(exchangeId: Long, task: NewTask) {
        val exchange = _state.value.exchanges.firstOrNull { it.id == exchangeId } ?: return
        if (exchange.suggestedAction == null || exchange.suggestion != SuggestionState.OFFERED) return
        setSuggestion(exchangeId, SuggestionState.CREATING)
        _state.update { it.copy(suggestionError = null) }
        viewModelScope.launch {
            try {
                createTask(task)
                setSuggestion(exchangeId, SuggestionState.CREATED)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                setSuggestion(exchangeId, SuggestionState.OFFERED)
                _state.update { it.copy(suggestionError = e) }
            }
        }
    }

    fun dismissSuggestionError() = _state.update { it.copy(suggestionError = null) }

    private fun setSuggestion(id: Long, value: SuggestionState) = _state.update { s ->
        s.copy(exchanges = s.exchanges.map { if (it.id == id) it.copy(suggestion = value) else it })
    }
}
