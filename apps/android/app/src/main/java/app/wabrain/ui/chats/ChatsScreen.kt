package app.wabrain.ui.chats

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.wabrain.AppContainer
import app.wabrain.R
import app.wabrain.data.api.ChatMode
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.ContextEntity
import app.wabrain.data.db.chatMode
import app.wabrain.ui.common.Badge
import app.wabrain.ui.common.ConfirmDialog
import app.wabrain.ui.common.Dropdown
import app.wabrain.ui.common.EmptyState
import app.wabrain.ui.common.ErrorBanner
import app.wabrain.ui.common.LoadingBox
import app.wabrain.ui.common.contextOptions
import app.wabrain.ui.common.errorText

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatsScreen(container: AppContainer) {
    val vm: ChatsViewModel = viewModel {
        ChatsViewModel(container.db.chats().observeAll(), container.db.contexts().observeAll(), container.directory)
    }
    val state by vm.state.collectAsStateWithLifecycle()
    val contextNames = state.contexts.associate { it.id to it.name }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.nav_chats)) }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = state.query,
                onValueChange = vm::setQuery,
                label = { Text(stringResource(R.string.search)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            ChatFilterChips(state.filter, state.toConfirmCount, vm::setFilter)
            when {
                !state.loaded -> LoadingBox()
                state.chats.isEmpty() -> EmptyState(
                    stringResource(if (state.query.isBlank() && state.filter == ChatFilter.ALL) R.string.empty_chats else R.string.empty_chats_filtered),
                )
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(state.chats, key = { it.id }) { chat ->
                        ChatRow(chat, chat.defaultContextId?.let(contextNames::get), onClick = { vm.open(chat.id) })
                        HorizontalDivider()
                    }
                }
            }
        }
    }

    state.open?.let { open ->
        ModalBottomSheet(onDismissRequest = vm::close) {
            ChatSettings(vm, open, state.contexts, state.busy, state.error)
        }
    }

    when (val pending = state.confirmation) {
        is ChatConfirmation.TurnOff -> ConfirmDialog(
            title = stringResource(R.string.chat_off_confirm_title),
            text = stringResource(R.string.chat_off_confirm_text),
            confirmLabel = stringResource(R.string.chat_turn_off),
            onConfirm = vm::confirm,
            onDismiss = vm::dismissConfirmation,
        )
        is ChatConfirmation.DeleteData -> ConfirmDialog(
            title = stringResource(R.string.chat_delete_data),
            text = stringResource(R.string.chat_delete_confirm),
            confirmLabel = stringResource(R.string.action_delete),
            onConfirm = vm::confirm,
            onDismiss = vm::dismissConfirmation,
        )
        null -> Unit
    }
}

@Composable
private fun ChatFilterChips(selected: ChatFilter, toConfirm: Int, onSelect: (ChatFilter) -> Unit) {
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(ChatFilter.entries) { filter ->
            val label = when (filter) {
                ChatFilter.ALL -> stringResource(R.string.filter_all)
                ChatFilter.TO_CONFIRM -> stringResource(R.string.chat_filter_to_confirm, toConfirm)
                ChatFilter.ON -> stringResource(R.string.chat_mode_on)
                ChatFilter.MENTIONS_ONLY -> stringResource(R.string.chat_mode_mentions)
                ChatFilter.OFF -> stringResource(R.string.chat_mode_off)
            }
            FilterChip(selected = selected == filter, onClick = { onSelect(filter) }, label = { Text(label) })
        }
    }
}

@Composable
private fun ChatRow(chat: ChatEntity, contextName: String?, onClick: () -> Unit) {
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        headlineContent = { Text(chat.name ?: chat.jid) },
        supportingContent = {
            val parts = listOfNotNull(
                stringResource(if (chat.isGroup) R.string.chat_group else R.string.chat_direct),
                stringResource(modeLabel(chat.chatMode)),
                contextName,
            )
            Text(parts.joinToString(" · "))
        },
        trailingContent = if (ChatRules.needsContextConfirmation(chat)) {
            { Badge(stringResource(R.string.chat_badge_suggested)) }
        } else {
            null
        },
    )
}

@Composable
private fun ChatSettings(vm: ChatsViewModel, chat: ChatEntity, contexts: List<ContextEntity>, busy: Boolean, error: Throwable?) {
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(chat.name ?: chat.jid, style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(if (chat.isGroup) R.string.chat_group else R.string.chat_direct),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        error?.let { ErrorBanner(errorText(it)) }

        // Mode
        Text(stringResource(R.string.chat_mode), style = MaterialTheme.typography.titleSmall)
        val modes = ChatRules.modesFor(chat)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            modes.forEachIndexed { index, mode ->
                SegmentedButton(
                    selected = chat.chatMode == mode,
                    enabled = !busy,
                    onClick = { vm.selectMode(chat, mode) },
                    shape = SegmentedButtonDefaults.itemShape(index, modes.size),
                ) { Text(stringResource(modeLabel(mode))) }
            }
        }
        Text(stringResource(modeExplanation(chat.chatMode)), style = MaterialTheme.typography.bodySmall)

        // Default context
        Text(stringResource(R.string.chat_default_context), style = MaterialTheme.typography.titleSmall)
        if (ChatRules.needsContextConfirmation(chat)) {
            val name = contexts.firstOrNull { it.id == chat.defaultContextId }?.name ?: chat.defaultContextId.orEmpty()
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.chat_context_suggested_long, name))
                    Text(stringResource(R.string.chat_context_suggested_hint), style = MaterialTheme.typography.bodySmall)
                    Button(enabled = !busy, onClick = { vm.confirmSuggestedContext(chat.id) }) {
                        Text(stringResource(R.string.chat_context_confirm, name))
                    }
                }
            }
        }
        Dropdown(
            label = stringResource(if (ChatRules.needsContextConfirmation(chat)) R.string.chat_context_choose_other else R.string.chat_default_context),
            options = contextOptions(contexts),
            selected = chat.defaultContextId,
            onSelect = { id -> vm.selectContext(chat.id, id) },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        )

        // Auto-create
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.chat_auto_create))
                Text(stringResource(R.string.chat_auto_create_hint), style = MaterialTheme.typography.bodySmall)
            }
            Switch(
                checked = chat.autoCreate,
                enabled = !busy && chat.chatMode != ChatMode.OFF,
                onCheckedChange = { v -> vm.setAutoCreate(chat.id, v) },
            )
        }

        // Delete data
        HorizontalDivider()
        Text(stringResource(R.string.chat_delete_hint), style = MaterialTheme.typography.bodySmall)
        OutlinedButton(
            enabled = !busy,
            onClick = { vm.requestDeleteData(chat.id) },
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
        ) { Text(stringResource(R.string.chat_delete_data)) }
        if (busy) CircularProgressIndicator()
    }
}

private fun modeLabel(mode: ChatMode): Int = when (mode) {
    ChatMode.OFF -> R.string.chat_mode_off
    ChatMode.ON -> R.string.chat_mode_on
    ChatMode.MENTIONS_ONLY -> R.string.chat_mode_mentions
}

private fun modeExplanation(mode: ChatMode): Int = when (mode) {
    ChatMode.OFF -> R.string.chat_mode_off_hint
    ChatMode.ON -> R.string.chat_mode_on_hint
    ChatMode.MENTIONS_ONLY -> R.string.chat_mode_mentions_hint
}
