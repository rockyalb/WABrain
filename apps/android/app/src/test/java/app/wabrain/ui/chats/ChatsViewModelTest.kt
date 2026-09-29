package app.wabrain.ui.chats

import app.wabrain.data.api.ApiException
import app.wabrain.data.api.ChatMode
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.ContextEntity
import app.wabrain.data.repo.ChatActions
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
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

@OptIn(ExperimentalCoroutinesApi::class)
class ChatsViewModelTest {
    private val dispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private class FakeActions : ChatActions {
        val calls = mutableListOf<String>()
        var failWith: Exception? = null
        var gate: CompletableDeferred<Unit>? = null

        private suspend fun record(call: String) {
            calls += call
            gate?.await()
            failWith?.let { throw it }
        }

        override suspend fun setChatMode(id: String, mode: ChatMode) = record("mode:$id:$mode")
        override suspend fun setChatContext(id: String, contextId: String?) = record("context:$id:$contextId")
        override suspend fun confirmChatContext(id: String) = record("confirm:$id")
        override suspend fun setChatAutoCreate(id: String, enabled: Boolean) = record("auto:$id:$enabled")
        override suspend fun deleteChatData(id: String) = record("delete:$id")
    }

    private fun chat(
        id: String,
        name: String? = id,
        isGroup: Boolean = false,
        mode: String = "on",
        contextId: String? = null,
        confirmed: Boolean = true,
    ) = ChatEntity(
        id = id,
        jid = "$id@s.whatsapp.net",
        name = name,
        isGroup = isGroup,
        mode = mode,
        defaultContextId = contextId,
        contextConfirmed = confirmed,
        autoCreate = true,
        minimumAutoConfidence = null,
        aliasesJson = "[]",
        personId = null,
        lastMessageAt = null,
    )

    private val work = ContextEntity("work", "Work", null, 0)
    private val chats = MutableStateFlow(
        listOf(
            chat("anna", "Anna", contextId = "work", confirmed = false),
            chat("team", "Team", isGroup = true, mode = "mentions_only", contextId = "work"),
            chat("bank", "Bank", mode = "off"),
        ),
    )

    private fun newVm(actions: ChatActions) = ChatsViewModel(chats, MutableStateFlow(listOf(work)), actions)

    @Test
    fun groupsOfferMentionsOnlyAndDirectChatsDoNot() {
        assertEquals(listOf(ChatMode.OFF, ChatMode.ON), ChatRules.modesFor(chat("a")))
        assertEquals(listOf(ChatMode.OFF, ChatMode.ON, ChatMode.MENTIONS_ONLY), ChatRules.modesFor(chat("g", isGroup = true)))
        // A direct chat already set to mentions-only still shows its current mode.
        assertEquals(listOf(ChatMode.OFF, ChatMode.ON, ChatMode.MENTIONS_ONLY), ChatRules.modesFor(chat("a", mode = "mentions_only")))
    }

    @Test
    fun filtersBySearchAndChip() = runTest(dispatcher) {
        val vm = newVm(FakeActions())
        backgroundScope.launch { vm.state.collect {} }

        assertEquals(3, vm.state.value.chats.size)
        assertEquals(1, vm.state.value.toConfirmCount)

        vm.setFilter(ChatFilter.TO_CONFIRM)
        assertEquals(listOf("anna"), vm.state.value.chats.map { it.id })

        vm.setFilter(ChatFilter.MENTIONS_ONLY)
        assertEquals(listOf("team"), vm.state.value.chats.map { it.id })

        vm.setFilter(ChatFilter.ALL)
        vm.setQuery("  ban ")
        assertEquals(listOf("bank"), vm.state.value.chats.map { it.id })
    }

    @Test
    fun turningOffNeedsConfirmationBeforeAnythingIsSent() = runTest(dispatcher) {
        val actions = FakeActions()
        val vm = newVm(actions)
        backgroundScope.launch { vm.state.collect {} }
        val anna = chats.value.first()

        vm.selectMode(anna, ChatMode.OFF)
        assertEquals(ChatConfirmation.TurnOff("anna"), vm.state.value.confirmation)
        assertTrue(actions.calls.isEmpty())

        vm.dismissConfirmation()
        assertNull(vm.state.value.confirmation)
        assertTrue(actions.calls.isEmpty())

        vm.selectMode(anna, ChatMode.OFF)
        vm.confirm()
        assertEquals(listOf("mode:anna:OFF"), actions.calls)
        assertNull(vm.state.value.confirmation)
    }

    @Test
    fun otherModesApplyAtOnceAndTheCurrentModeIsANoOp() = runTest(dispatcher) {
        val actions = FakeActions()
        val vm = newVm(actions)
        val team = chats.value[1]

        vm.selectMode(team, ChatMode.MENTIONS_ONLY)
        assertTrue(actions.calls.isEmpty())

        vm.selectMode(team, ChatMode.ON)
        assertEquals(listOf("mode:team:ON"), actions.calls)
        assertNull(vm.state.value.confirmation)
    }

    @Test
    fun contextChoiceConfirmationAndAutoCreate() = runTest(dispatcher) {
        val actions = FakeActions()
        val vm = newVm(actions)

        vm.confirmSuggestedContext("anna")
        vm.selectContext("bank", "work")
        vm.selectContext("bank", null)
        vm.setAutoCreate("team", false)

        assertEquals(listOf("confirm:anna", "context:bank:work", "context:bank:null", "auto:team:false"), actions.calls)
    }

    @Test
    fun deletingDataNeedsConfirmationAndClosesTheSheet() = runTest(dispatcher) {
        val actions = FakeActions()
        val vm = newVm(actions)
        backgroundScope.launch { vm.state.collect {} }

        vm.open("anna")
        assertEquals("anna", vm.state.value.open?.id)

        vm.requestDeleteData("anna")
        assertEquals(ChatConfirmation.DeleteData("anna"), vm.state.value.confirmation)
        assertTrue(actions.calls.isEmpty())

        vm.confirm()
        assertEquals(listOf("delete:anna"), actions.calls)
        assertNull(vm.state.value.open)
    }

    @Test
    fun failedDeleteKeepsTheSheetOpenAndShowsTheError() = runTest(dispatcher) {
        val actions = FakeActions().apply { failWith = ApiException(500, "internal", "boom") }
        val vm = newVm(actions)
        backgroundScope.launch { vm.state.collect {} }

        vm.open("anna")
        vm.requestDeleteData("anna")
        vm.confirm()

        assertEquals("anna", vm.state.value.open?.id)
        assertTrue(vm.state.value.error is ApiException)
        assertFalse(vm.state.value.busy)
    }

    @Test
    fun busyWhileAChangeIsInFlightAndIgnoresNewOnes() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val actions = FakeActions().apply { this.gate = gate }
        val vm = newVm(actions)
        backgroundScope.launch { vm.state.collect {} }

        vm.setAutoCreate("anna", false)
        assertTrue(vm.state.value.busy)
        vm.setAutoCreate("anna", true)
        assertEquals(listOf("auto:anna:false"), actions.calls)

        gate.complete(Unit)
        assertFalse(vm.state.value.busy)
        assertNull(vm.state.value.error)
    }

    @Test
    fun openSheetFollowsServerUpdates() = runTest(dispatcher) {
        val vm = newVm(FakeActions())
        backgroundScope.launch { vm.state.collect {} }

        vm.open("anna")
        chats.value = chats.value.map { if (it.id == "anna") it.copy(contextConfirmed = true) else it }
        assertEquals(true, vm.state.value.open?.contextConfirmed)
        assertEquals(0, vm.state.value.toConfirmCount)
    }
}
