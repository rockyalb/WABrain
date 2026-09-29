package app.wabrain.ui.detail

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.wabrain.AppContainer
import app.wabrain.R
import app.wabrain.data.api.MessageViewDto
import app.wabrain.data.db.dto
import app.wabrain.domain.Instants
import app.wabrain.ui.common.EmptyState
import app.wabrain.ui.common.ErrorBanner
import app.wabrain.ui.common.LoadingBox
import app.wabrain.ui.common.errorText
import app.wabrain.ui.common.rememberDueFormatter

/** Surrounding conversation for an evidence or cited message (read-only). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(container: AppContainer, chatId: String, messageId: String?, onBack: () -> Unit) {
    var messages by remember { mutableStateOf<List<MessageViewDto>?>(null) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    val settings by container.db.settings().observe().collectAsState(initial = null)
    val chat by container.db.chats().observe(chatId).collectAsState(initial = null)
    val formatter = rememberDueFormatter(Instants.zoneOrDefault(settings?.dto?.timezone))
    val listState = rememberLazyListState()

    LaunchedEffect(chatId, messageId) {
        try {
            val items = container.directory.messagesAround(chatId, messageId).sortedBy { it.at }
            messages = items
            val index = items.indexOfFirst { it.id == messageId }
            if (index > 0) listState.scrollToItem(index)
        } catch (e: Exception) {
            error = e
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(chat?.name ?: stringResource(R.string.conversation_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back)) }
                },
            )
        },
    ) { padding ->
        val list = messages
        when {
            error != null -> ErrorBanner(errorText(error!!), Modifier.padding(padding))
            list == null -> LoadingBox(Modifier.padding(padding))
            list.isEmpty() -> EmptyState(stringResource(R.string.conversation_empty), Modifier.padding(padding))
            else -> LazyColumn(Modifier.padding(padding).fillMaxSize(), state = listState) {
                items(list, key = { it.id }) { msg ->
                    MessageCard(msg, formatter, highlighted = msg.id == messageId, onClick = null)
                }
            }
        }
    }
}
