package app.wabrain.ui.ask

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.wabrain.AppContainer
import app.wabrain.R
import app.wabrain.data.api.AskCitationDto
import app.wabrain.data.api.TaskActionDto
import app.wabrain.data.db.dto
import app.wabrain.domain.DueFormatter
import app.wabrain.domain.Instants
import app.wabrain.ui.common.DatePickerModal
import app.wabrain.ui.common.Dropdown
import app.wabrain.ui.common.ErrorBanner
import app.wabrain.ui.common.TaskEditorDialog
import app.wabrain.ui.common.errorText
import app.wabrain.ui.common.rememberDueFormatter
import app.wabrain.ui.tasks.toNewTask
import app.wabrain.ui.theme.LocalGlass
import app.wabrain.ui.theme.WabIcons
import app.wabrain.ui.theme.WabLogo
import app.wabrain.ui.theme.glass
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** Ask your chats (phase 3). Read-only; a suggested task is created only when tapped. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AskScreen(container: AppContainer, onOpenConversation: (String, String?) -> Unit) {
    val vm: AskViewModel = viewModel { AskViewModel(ask = container.directory::ask, createTask = container.tasks::create) }
    val state by vm.state.collectAsStateWithLifecycle()
    val people by container.db.people().observeAll().collectAsState(initial = emptyList())
    val contexts by container.db.contexts().observeAll().collectAsState(initial = emptyList())
    val chats by container.db.chats().observeAll().collectAsState(initial = emptyList())
    val settings by container.db.settings().observe().collectAsState(initial = null)
    val zone = Instants.zoneOrDefault(settings?.dto?.timezone)
    val formatter = rememberDueFormatter(zone)
    val dateFormat = remember { DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(Locale.getDefault()) }
    val chatNames = remember(chats) { chats.associate { it.id to (it.name ?: it.jid) } }

    var question by rememberSaveable { mutableStateOf("") }
    var pickFrom by remember { mutableStateOf(false) }
    var pickTo by remember { mutableStateOf(false) }
    var editingSuggestion by rememberSaveable { mutableStateOf<Long?>(null) }
    val listState = rememberLazyListState()

    LaunchedEffect(state.exchanges.size) {
        if (state.exchanges.isNotEmpty()) listState.animateScrollToItem(state.exchanges.size - 1)
    }

    fun send() {
        if (vm.send(question, zone)) question = ""
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        WabLogo(32.dp)
                        Text(stringResource(R.string.nav_ask))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent, scrolledContainerColor = Color.Transparent),
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            if (state.unavailable) UnavailableCard(Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            state.suggestionError?.let { ErrorBanner(errorText(it), Modifier.clickable(onClick = vm::dismissSuggestionError)) }

            // Filters: person, context, date range.
            Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Dropdown(
                    stringResource(R.string.ask_person),
                    listOf<Pair<String?, String>>(null to stringResource(R.string.filter_all)) + people.map { it.id to it.displayName },
                    state.filters.personId,
                    vm::setPerson,
                    Modifier.weight(1f),
                )
                Dropdown(
                    stringResource(R.string.ask_context),
                    listOf<Pair<String?, String>>(null to stringResource(R.string.filter_all)) + contexts.map { it.id to it.name },
                    state.filters.contextId,
                    vm::setContext,
                    Modifier.weight(1f),
                )
            }
            val anyDate = stringResource(R.string.ask_any_date)
            Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { pickFrom = true }) {
                    Text(stringResource(R.string.ask_from, state.filters.from?.let(dateFormat::format) ?: anyDate))
                }
                TextButton(onClick = { pickTo = true }) {
                    Text(stringResource(R.string.ask_to, state.filters.to?.let(dateFormat::format) ?: anyDate))
                }
                if (state.filters.from != null || state.filters.to != null) {
                    TextButton(onClick = vm::clearDates) { Text(stringResource(R.string.due_clear)) }
                }
            }
            if (!state.filters.isRangeValid) {
                Text(
                    stringResource(R.string.ask_range_invalid),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }

            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (state.exchanges.isEmpty()) {
                    item { Text(stringResource(R.string.ask_intro), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                items(state.exchanges, key = { it.id }) { ex ->
                    ExchangeView(
                        exchange = ex,
                        formatter = formatter,
                        chatNames = chatNames,
                        canRetry = state.canRetry(ex),
                        onOpenCitation = { c -> onOpenConversation(c.chatId, c.messageId) },
                        onRetry = { vm.retry(ex.id, zone) },
                        onCreateSuggested = { editingSuggestion = ex.id },
                    )
                }
            }

            val g = LocalGlass.current
            Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = question,
                    onValueChange = { question = it.take(AskFilters.MAX_QUESTION) },
                    placeholder = { Text(stringResource(R.string.ask_placeholder)) },
                    leadingIcon = { Icon(WabIcons.Sparkle, contentDescription = null, tint = g.accent) },
                    modifier = Modifier.weight(1f),
                    maxLines = 4,
                    shape = RoundedCornerShape(24.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = g.card,
                        unfocusedContainerColor = g.card,
                        focusedBorderColor = g.accent,
                        unfocusedBorderColor = g.cardBorder,
                    ),
                )
                IconButton(enabled = state.canSend(question), onClick = ::send) {
                    Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.ask_send), tint = if (state.canSend(question)) g.accentDeep else MaterialTheme.colorScheme.outline)
                }
            }
        }
    }

    if (pickFrom) DatePickerModal(state.filters.from, onPick = vm::setFrom, onDismiss = { pickFrom = false })
    if (pickTo) DatePickerModal(state.filters.to, onPick = vm::setTo, onDismiss = { pickTo = false })

    val editing = editingSuggestion?.let { id -> state.exchanges.firstOrNull { it.id == id } }
    val action = editing?.suggestedAction
    val response = (editing?.outcome as? AskOutcome.Answered)?.response
    if (editing != null && action != null && response != null) {
        TaskEditorDialog(
            title = stringResource(R.string.task_new),
            initial = suggestionDraft(action, response, chats, zone),
            contexts = contexts,
            chats = chats,
            people = people,
            showLink = true,
            confirmLabel = stringResource(R.string.action_create),
            onConfirm = { draft -> vm.createSuggested(editing.id, draft.toNewTask()) },
            onDismiss = { editingSuggestion = null },
        )
    }
}

@Composable
private fun UnavailableCard(modifier: Modifier = Modifier) {
    Card(modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.ask_unavailable_title), style = MaterialTheme.typography.titleSmall)
            Text(stringResource(R.string.ask_unavailable), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun ExchangeView(
    exchange: AskExchange,
    formatter: DueFormatter,
    chatNames: Map<String, String>,
    canRetry: Boolean,
    onOpenCitation: (AskCitationDto) -> Unit,
    onRetry: () -> Unit,
    onCreateSuggested: () -> Unit,
) {
    val g = LocalGlass.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            exchange.question,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier
                .align(Alignment.End)
                .padding(start = 48.dp)
                .clip(RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 4.dp))
                .background(MaterialTheme.colorScheme.primaryContainer)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        )
        Column(Modifier.fillMaxWidth().glass(g).animateContentSize()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when (val outcome = exchange.outcome) {
                    AskOutcome.Pending -> AskSearching(Modifier.padding(vertical = 8.dp))
                    AskOutcome.NotFound -> {
                        Text(stringResource(R.string.ask_not_found), style = MaterialTheme.typography.titleSmall)
                        Text(
                            stringResource(if (exchange.filters.isActive) R.string.ask_not_found_hint_filters else R.string.ask_not_found_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    AskOutcome.Unavailable -> Text(stringResource(R.string.ask_unavailable_short), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    AskOutcome.NoTextModel -> {
                        Text(stringResource(R.string.ask_no_text_model_title), style = MaterialTheme.typography.titleSmall)
                        Text(stringResource(R.string.ask_no_text_model), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        TextButton(onClick = onRetry, enabled = canRetry) { Text(stringResource(R.string.action_retry)) }
                    }
                    is AskOutcome.RateLimited -> {
                        if (outcome.dailyLimit) {
                            Text(
                                stringResource(R.string.ask_daily_limit, formatter.formatInstant(outcome.retryAt.toEpochMilli())),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(stringResource(R.string.ask_budget_retry), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                        } else {
                            Text(stringResource(R.string.ask_rate_limited), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = onRetry, enabled = canRetry) { Text(stringResource(R.string.action_retry)) }
                    }
                    AskOutcome.ModelUnavailable -> {
                        Text(stringResource(R.string.ask_model_unavailable), color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = onRetry, enabled = canRetry) { Text(stringResource(R.string.action_retry)) }
                    }
                    is AskOutcome.Failed -> {
                        Text(errorText(outcome.error), color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = onRetry, enabled = canRetry) { Text(stringResource(R.string.action_retry)) }
                    }
                    is AskOutcome.Answered -> {
                        Text(outcome.response.answer)
                        if (outcome.response.citations.isNotEmpty()) {
                            Text(stringResource(R.string.ask_sources), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            outcome.response.citations.forEachIndexed { i, c ->
                                CitationRow(i + 1, c, chatNames[c.chatId], formatter, onClick = { onOpenCitation(c) })
                            }
                        }
                        outcome.response.suggestedAction?.let { action -> SuggestionView(action, exchange.suggestion, formatter, onCreateSuggested) }
                    }
                }
            }
        }
    }
}

@Composable
private fun CitationRow(number: Int, citation: AskCitationDto, chatName: String?, formatter: DueFormatter, onClick: () -> Unit) {
    val openLabel = stringResource(R.string.ask_open_conversation)
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = openLabel, role = Role.Button, onClick = onClick)
            .padding(vertical = 4.dp),
    ) {
        val header = listOfNotNull("[$number]", chatName, formatter.formatInstant(citation.at)).joinToString(" · ")
        Text(header, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        if (citation.excerpt.isNotBlank()) Text(citation.excerpt, style = MaterialTheme.typography.bodySmall, maxLines = 3)
    }
}

@Composable
private fun SuggestionView(action: TaskActionDto.Create, suggestion: SuggestionState, formatter: DueFormatter, onCreate: () -> Unit) {
    HorizontalDivider()
    Text(stringResource(R.string.ask_suggested_task), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(action.title, style = MaterialTheme.typography.bodyLarge)
    action.dueAt?.let { due ->
        val millis = runCatching { Instants.parseMillis(due) }.getOrNull()
        if (millis != null) {
            Text(
                stringResource(R.string.review_due, formatter.formatDue(millis, action.dueHasTime, java.time.Instant.now())),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
    when (suggestion) {
        SuggestionState.OFFERED -> Button(onClick = onCreate) { Text(stringResource(R.string.ask_create_task)) }
        SuggestionState.CREATING -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        SuggestionState.CREATED -> Text(stringResource(R.string.ask_task_created), color = MaterialTheme.colorScheme.primary)
    }
}
