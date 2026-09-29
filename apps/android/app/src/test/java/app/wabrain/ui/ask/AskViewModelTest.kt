package app.wabrain.ui.ask

import app.wabrain.data.api.ApiException
import app.wabrain.data.api.AskCitationDto
import app.wabrain.data.api.AskRequestDto
import app.wabrain.data.api.AskResponseDto
import app.wabrain.data.api.TaskActionDto
import app.wabrain.data.api.WabJson
import app.wabrain.data.api.parseRetryAfter
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.repo.NewTask
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

@OptIn(ExperimentalCoroutinesApi::class)
class AskViewModelTest {
    private val dispatcher = UnconfinedTestDispatcher()
    private val rome = ZoneId.of("Europe/Rome")

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private val suggestion = TaskActionDto.Create(
        title = "Send the contract",
        dueAt = "2026-09-24T17:00:00+02:00",
        evidenceMessageIds = listOf("m2"),
    )

    private val answer = AskResponseDto(
        found = true,
        answer = "Ana asked for the contract on Monday.",
        citations = listOf(
            AskCitationDto("m1", "chat-a", "hello", "2026-09-21T09:00:00+02:00"),
            AskCitationDto("m2", "chat-b", "send the contract", "2026-09-21T09:05:00+02:00"),
        ),
        suggestedAction = suggestion,
    )

    private class Recorder(var respond: suspend (AskRequestDto) -> AskResponseDto) {
        val requests = mutableListOf<AskRequestDto>()
        val created = mutableListOf<NewTask>()
        var createFails: Exception? = null

        suspend fun ask(r: AskRequestDto): AskResponseDto {
            requests += r
            return respond(r)
        }

        suspend fun create(t: NewTask): String {
            createFails?.let { throw it }
            created += t
            return "task-${created.size}"
        }
    }

    private fun vm(recorder: Recorder) = AskViewModel(recorder::ask, recorder::create)

    @Test
    fun requestCarriesFiltersWithAnInclusiveDateRangeInTheServerZone() {
        val filters = AskFilters(personId = "p1", contextId = "work", from = LocalDate.of(2026, 9, 1), to = LocalDate.of(2026, 9, 30))
        val request = filters.toRequest("  when is the meeting?  ", rome)

        assertEquals("when is the meeting?", request.question)
        assertEquals("p1", request.personId)
        assertEquals("work", request.contextId)
        assertEquals("2026-09-01T00:00:00+02:00", request.from)
        // "to" is inclusive on the server too: the request ends at the last millisecond of the day,
        // so a message at the next midnight is not included.
        assertEquals("2026-09-30T23:59:59.999+02:00", request.to)
    }

    @Test
    fun theEndOfDayFollowsTheZoneAcrossADaylightSavingChange() {
        // Europe/Rome leaves summer time on 2026-10-25: that day ends at +01:00.
        val request = AskFilters(to = LocalDate.of(2026, 10, 25)).toRequest("q", rome)
        assertEquals("2026-10-25T23:59:59.999+01:00", request.to)
    }

    @Test
    fun noFiltersAreOmittedFromTheJsonBody() {
        val body = WabJson.encodeToString(AskRequestDto.serializer(), AskFilters().toRequest("hi", rome))
        assertEquals("""{"question":"hi"}""", body)
    }

    @Test
    fun anInvertedRangeCannotBeSent() = runTest(dispatcher) {
        val recorder = Recorder { answer }
        val vm = vm(recorder)
        vm.setFrom(LocalDate.of(2026, 9, 10))
        vm.setTo(LocalDate.of(2026, 9, 1))

        assertFalse(vm.state.value.filters.isRangeValid)
        assertFalse(vm.send("question", rome))
        assertTrue(recorder.requests.isEmpty())

        vm.clearDates()
        assertTrue(vm.send("question", rome))
    }

    @Test
    fun blankQuestionsAreNotSent() = runTest(dispatcher) {
        val recorder = Recorder { answer }
        assertFalse(vm(recorder).send("   ", rome))
        assertTrue(recorder.requests.isEmpty())
    }

    @Test
    fun anAnswerKeepsItsCitationsAndTheSuggestionIsOnlyOffered() = runTest(dispatcher) {
        val recorder = Recorder { answer }
        val vm = vm(recorder)
        vm.setPerson("p1")

        assertTrue(vm.send("what did Ana ask?", rome))
        val exchange = vm.state.value.exchanges.single()
        val outcome = exchange.outcome as AskOutcome.Answered
        assertEquals(listOf("m1", "m2"), outcome.response.citations.map { it.messageId })
        assertEquals("p1", recorder.requests.single().personId)
        assertEquals(SuggestionState.OFFERED, exchange.suggestion)
        // Asking never creates anything.
        assertTrue(recorder.created.isEmpty())
    }

    @Test
    fun theSuggestedTaskIsCreatedOnlyOnTapAndOnlyOnce() = runTest(dispatcher) {
        val recorder = Recorder { answer }
        val vm = vm(recorder)
        vm.send("what did Ana ask?", rome)
        val id = vm.state.value.exchanges.single().id

        vm.createSuggested(id, NewTask(title = "Send the contract", chatId = "chat-b"))
        vm.createSuggested(id, NewTask(title = "Send the contract", chatId = "chat-b"))

        assertEquals(1, recorder.created.size)
        assertEquals("chat-b", recorder.created.single().chatId)
        assertEquals(SuggestionState.CREATED, vm.state.value.exchanges.single().suggestion)
    }

    @Test
    fun aFailedCreateCanBeTriedAgain() = runTest(dispatcher) {
        val recorder = Recorder { answer }.apply { createFails = IOException("offline") }
        val vm = vm(recorder)
        vm.send("q", rome)
        val id = vm.state.value.exchanges.single().id

        vm.createSuggested(id, NewTask(title = "t"))
        assertEquals(SuggestionState.OFFERED, vm.state.value.exchanges.single().suggestion)
        assertTrue(vm.state.value.suggestionError is IOException)

        recorder.createFails = null
        vm.createSuggested(id, NewTask(title = "t"))
        assertEquals(SuggestionState.CREATED, vm.state.value.exchanges.single().suggestion)
        assertNull(vm.state.value.suggestionError)
    }

    @Test
    fun notFoundIsItsOwnState() = runTest(dispatcher) {
        val vm = vm(Recorder { AskResponseDto(found = false, answer = "maybe…", suggestedAction = suggestion) })
        vm.send("q", rome)

        val exchange = vm.state.value.exchanges.single()
        assertEquals(AskOutcome.NotFound, exchange.outcome)
        // A not-found answer never offers a task.
        assertNull(exchange.suggestedAction)
    }

    @Test
    fun a501MarksAskUnavailableInsteadOfFailing() = runTest(dispatcher) {
        val vm = vm(Recorder { throw ApiException(501, "not_implemented", "Not implemented") })
        vm.send("q", rome)

        assertEquals(AskOutcome.Unavailable, vm.state.value.exchanges.single().outcome)
        assertTrue(vm.state.value.unavailable)
    }

    @Test
    fun otherErrorsFailAndCanBeRetriedWithTheOriginalFilters() = runTest(dispatcher) {
        var fail = true
        val recorder = Recorder { if (fail) throw IOException("offline") else answer }
        val vm = vm(recorder)
        vm.setContext("work")
        vm.send("q", rome)
        assertTrue(vm.state.value.exchanges.single().outcome is AskOutcome.Failed)
        assertFalse(vm.state.value.unavailable)

        vm.setContext(null)
        fail = false
        vm.retry(vm.state.value.exchanges.single().id, rome)

        assertTrue(vm.state.value.exchanges.single().outcome is AskOutcome.Answered)
        assertEquals(listOf("work", "work"), recorder.requests.map { it.contextId })
    }

    @Test
    fun cannotSendWhileAQuestionIsPending() = runTest(dispatcher) {
        val gate = CompletableDeferred<AskResponseDto>()
        val vm = vm(Recorder { gate.await() })

        assertTrue(vm.send("first", rome))
        assertTrue(vm.state.value.busy)
        assertFalse(vm.send("second", rome))

        gate.complete(answer)
        assertFalse(vm.state.value.busy)
        assertEquals(1, vm.state.value.exchanges.size)
    }

    @Test
    fun suggestionLinksToTheChatOfItsEvidence() {
        assertEquals("chat-b", suggestedChatId(answer))
        assertEquals("chat-a", suggestedChatId(answer.copy(suggestedAction = suggestion.copy(evidenceMessageIds = listOf("other")))))
        assertNull(suggestedChatId(answer.copy(citations = emptyList())))
    }

    // ------------------------------------------------------------ suggested context

    private fun chat(id: String, contextId: String?, personId: String? = null) = ChatEntity(
        id = id,
        jid = "$id@s.whatsapp.net",
        name = id,
        isGroup = false,
        mode = "on",
        defaultContextId = contextId,
        contextConfirmed = true,
        autoCreate = true,
        minimumAutoConfidence = null,
        aliasesJson = "[]",
        personId = personId,
        lastMessageAt = null,
    )

    @Test
    fun aSuggestionWithoutAContextTakesTheCitedChatsContext() {
        val chats = listOf(chat("chat-a", "home"), chat("chat-b", "work", personId = "p-ana"))
        val draft = suggestionDraft(suggestion, answer, chats, rome)

        assertEquals("chat-b", draft.chatId)
        assertEquals("p-ana", draft.personId)
        assertEquals("work", draft.contextId)
        assertEquals(LocalDate.of(2026, 9, 24), draft.dueDate)
        assertNull(draft.dueTime)
    }

    @Test
    fun aSuggestionsOwnContextWins() {
        val chats = listOf(chat("chat-b", "work"))
        assertEquals("home", suggestionDraft(suggestion.copy(contextId = "home"), answer, chats, rome).contextId)
    }

    @Test
    fun aSuggestionFromAnUnknownChatHasNoLinkAndNoContext() {
        val draft = suggestionDraft(suggestion, answer, listOf(chat("chat-z", "work")), rome)
        assertNull(draft.chatId)
        assertNull(draft.contextId)
        // A chat without a default context leaves the context empty.
        assertNull(suggestionDraft(suggestion, answer, listOf(chat("chat-b", null)), rome).contextId)
    }

    // ------------------------------------------------------------ error states

    private val now: Instant = Instant.parse("2026-09-24T10:00:00Z")

    private fun vmAt(recorder: Recorder) = AskViewModel(recorder::ask, recorder::create, clock = { now })

    @Test
    fun a409SaysThatNoTextModelIsSetUp() = runTest(dispatcher) {
        var fail = true
        val recorder = Recorder {
            if (fail) throw ApiException(409, "conflict", "Ask needs a text model. No text provider is configured; set one on the setup page.") else answer
        }
        val vm = vmAt(recorder)
        vm.send("q", rome)

        assertEquals(AskOutcome.NoTextModel, vm.state.value.exchanges.single().outcome)
        assertFalse(vm.state.value.unavailable)
        assertFalse(vm.state.value.waiting)

        // Once the owner has set a model, the same question can be asked again.
        fail = false
        vm.retry(vm.state.value.exchanges.single().id, rome)
        assertTrue(vm.state.value.exchanges.single().outcome is AskOutcome.Answered)
        assertEquals(2, recorder.requests.size)
    }

    @Test
    fun a503SaysTheModelIsUnavailableAndCanBeRetried() = runTest(dispatcher) {
        var fail = true
        val recorder = Recorder { if (fail) throw ApiException(503, "unavailable", "The text model did not answer. Try again in a moment.") else answer }
        val vm = vmAt(recorder)
        vm.send("q", rome)

        val exchange = vm.state.value.exchanges.single()
        assertEquals(AskOutcome.ModelUnavailable, exchange.outcome)
        assertTrue(vm.state.value.canRetry(exchange))

        fail = false
        vm.retry(exchange.id, rome)
        assertTrue(vm.state.value.exchanges.single().outcome is AskOutcome.Answered)
    }

    @Test
    fun theDeviceRateLimitBlocksAskingUntilRetryAfterAndNeverRetriesByItself() = runTest(dispatcher) {
        var fail = true
        val recorder = Recorder { if (fail) throw ApiException(429, "rate_limited", "Too many requests", retryAfterSeconds = 6) else answer }
        val vm = vmAt(recorder)
        vm.send("q", rome)

        val exchange = vm.state.value.exchanges.single()
        assertEquals(AskOutcome.RateLimited(now.plusSeconds(6), dailyLimit = false), exchange.outcome)
        assertEquals(now.plusSeconds(6), vm.state.value.waitUntil)
        assertFalse(vm.state.value.canRetry(exchange))
        assertFalse(vm.send("another", rome))
        vm.retry(exchange.id, rome)
        assertEquals(1, recorder.requests.size)

        advanceTimeBy(5_999)
        assertTrue(vm.state.value.waiting)
        advanceTimeBy(2)
        assertFalse(vm.state.value.waiting)
        // Waiting out the limit sent nothing on its own.
        assertEquals(1, recorder.requests.size)

        fail = false
        vm.retry(exchange.id, rome)
        assertTrue(vm.state.value.exchanges.single().outcome is AskOutcome.Answered)
        assertEquals(2, recorder.requests.size)
    }

    @Test
    fun theDailyBudgetShowsWhenAskWorksAgain() = runTest(dispatcher) {
        val untilMidnight = 12L * 3600
        val vm = vmAt(
            Recorder {
                throw ApiException(
                    429,
                    "budget_exceeded",
                    "The daily limit for the text model is used up; Ask works again after local midnight.",
                    retryAfterSeconds = untilMidnight,
                )
            },
        )
        vm.send("q", rome)

        assertEquals(AskOutcome.RateLimited(now.plusSeconds(untilMidnight), dailyLimit = true), vm.state.value.exchanges.single().outcome)
        assertFalse(vm.send("another", rome))
        advanceTimeBy(untilMidnight * 1000 + 1)
        assertFalse(vm.state.value.waiting)
        assertTrue(vm.send("another", rome))
    }

    @Test
    fun distinctBudgetErrorCanBeRetriedManuallyAfterTheOwnerRaisesTheLimit() = runTest(dispatcher) {
        var budgetRaised = false
        val recorder = Recorder {
            if (!budgetRaised) {
                throw ApiException(429, "budget_exceeded", "Limit reached", retryAfterSeconds = 86_400)
            }
            answer
        }
        val vm = vmAt(recorder)
        vm.send("q", rome)

        val exchange = vm.state.value.exchanges.single()
        assertEquals(AskOutcome.RateLimited(now.plusSeconds(86_400), dailyLimit = true), exchange.outcome)
        assertTrue(vm.state.value.waiting)
        assertTrue(vm.state.value.canRetry(exchange))
        assertFalse(vm.state.value.canSend("another"))

        budgetRaised = true
        vm.retry(exchange.id, rome)

        assertTrue(vm.state.value.exchanges.single().outcome is AskOutcome.Answered)
        assertFalse(vm.state.value.waiting)
        assertTrue(vm.state.value.canSend("another"))
        assertEquals(2, recorder.requests.size)
    }

    @Test
    fun aBudgetRetryThatIsStillOverBudgetKeepsWaitingButStaysRetryable() = runTest(dispatcher) {
        val recorder = Recorder { throw ApiException(429, "budget_exceeded", "Limit reached", retryAfterSeconds = 3_600) }
        val vm = vmAt(recorder)
        vm.send("q", rome)
        val exchange = vm.state.value.exchanges.single()

        vm.retry(exchange.id, rome)

        assertEquals(2, recorder.requests.size)
        assertTrue(vm.state.value.waiting)
        assertFalse(vm.state.value.canSend("another"))
        assertTrue(vm.state.value.canRetry(vm.state.value.exchanges.single()))
    }

    @Test
    fun aDeviceRateLimitDuringABudgetWaitBlocksRetryUntilItPasses() = runTest(dispatcher) {
        var reply: () -> AskResponseDto = { throw ApiException(429, "budget_exceeded", "Limit reached", retryAfterSeconds = 3_600) }
        val recorder = Recorder { reply() }
        val vm = vmAt(recorder)
        vm.send("q", rome)
        val exchange = vm.state.value.exchanges.single()

        reply = { throw ApiException(429, "rate_limited", "Too many requests", retryAfterSeconds = 6) }
        vm.retry(exchange.id, rome)
        assertEquals(AskOutcome.RateLimited(now.plusSeconds(6), dailyLimit = false), vm.state.value.exchanges.single().outcome)
        assertFalse(vm.state.value.canRetry(vm.state.value.exchanges.single()))

        advanceTimeBy(6_001)
        reply = { answer }
        vm.retry(exchange.id, rome)
        assertTrue(vm.state.value.exchanges.single().outcome is AskOutcome.Answered)
        assertEquals(3, recorder.requests.size)
    }

    @Test
    fun rateLimitsAreToldApartAndHaveASafeDefaultWait() {
        // No Retry-After: wait a default rather than letting the owner hammer the server.
        assertEquals(
            AskOutcome.RateLimited(now.plus(AskOutcome.DEFAULT_RATE_LIMIT_WAIT), dailyLimit = false),
            AskOutcome.from(ApiException(429, "rate_limited", "Too many requests"), now),
        )
        // The machine-readable code decides, not the wording or the length of the wait.
        assertEquals(
            AskOutcome.RateLimited(now.plusSeconds(7200), dailyLimit = true),
            AskOutcome.from(ApiException(429, "budget_exceeded", "Kufiri u shterua", retryAfterSeconds = 7200), now),
        )
        assertEquals(
            AskOutcome.RateLimited(now.plusSeconds(7200), dailyLimit = false),
            AskOutcome.from(ApiException(429, "rate_limited", "The daily quota of requests", retryAfterSeconds = 7200), now),
        )
        assertTrue(AskOutcome.from(IOException("offline"), now) is AskOutcome.Failed)
        assertTrue(AskOutcome.from(ApiException(500, "internal", "Internal server error"), now) is AskOutcome.Failed)
    }

    @Test
    fun retryAfterIsReadAsSecondsOrAnHttpDate() {
        assertEquals(6L, parseRetryAfter("6", now))
        assertEquals(0L, parseRetryAfter("-3", now))
        assertEquals(90L, parseRetryAfter("Thu, 24 Sep 2026 10:01:30 GMT", now))
        assertEquals(0L, parseRetryAfter("Thu, 24 Sep 2026 09:00:00 GMT", now))
        assertNull(parseRetryAfter(null, now))
        assertNull(parseRetryAfter("soon", now))
    }
}
