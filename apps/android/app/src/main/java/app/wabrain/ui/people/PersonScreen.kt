package app.wabrain.ui.people

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.wabrain.AppContainer
import app.wabrain.R
import app.wabrain.data.api.PERSON_FACT_KEYS
import app.wabrain.data.api.PersonFactDto
import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.dto
import app.wabrain.domain.DueFormatter
import app.wabrain.domain.Instants
import app.wabrain.ui.detail.MessageCard
import app.wabrain.ui.common.Badge
import app.wabrain.ui.common.BadgeRow
import app.wabrain.ui.common.ConfirmDialog
import app.wabrain.ui.common.Dropdown
import app.wabrain.ui.common.EmptyState
import app.wabrain.ui.common.ErrorBanner
import app.wabrain.ui.common.SectionHeader
import app.wabrain.ui.common.contextOptions
import app.wabrain.ui.common.errorText
import app.wabrain.ui.common.rememberDueFormatter
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonScreen(container: AppContainer, personId: String, onBack: () -> Unit, onOpenConversation: (String, String?) -> Unit) {
    val entity by container.db.people().observe(personId).collectAsState(initial = null)
    val contexts by container.db.contexts().observeAll().collectAsState(initial = emptyList())
    val chats by container.db.chats().observeAll().collectAsState(initial = emptyList())
    val settings by container.db.settings().observe().collectAsState(initial = null)
    val formatter = rememberDueFormatter(Instants.zoneOrDefault(settings?.dto?.timezone))
    /** Per fact ID: whether its sources are shown, and what the server returned for them. */
    val evidence = remember(personId) { mutableStateMapOf<String, FactEvidenceUi>() }
    val person = remember(entity?.json) { entity?.dto }
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<Throwable?>(null) }
    var busy by remember { mutableStateOf(false) }
    var editingFact by remember { mutableStateOf<PersonFactDto?>(null) }
    var addingFact by remember { mutableStateOf(false) }
    var deletingFact by remember { mutableStateOf<PersonFactDto?>(null) }
    var renaming by remember { mutableStateOf(false) }
    var deletingPerson by remember { mutableStateOf(false) }

    fun loadSources(factId: String) {
        evidence[factId] = (evidence[factId] ?: FactEvidenceUi()).copy(expanded = true, loading = true, error = null)
        scope.launch {
            evidence[factId] = try {
                val messages = container.api.factSources(personId, factId).items
                (evidence[factId] ?: FactEvidenceUi(expanded = true)).copy(loading = false, messages = messages, error = null)
            } catch (e: Exception) {
                (evidence[factId] ?: FactEvidenceUi(expanded = true)).copy(loading = false, error = e)
            }
        }
    }

    fun toggleSources(fact: PersonFactDto) {
        val current = evidence[fact.id]
        when {
            current?.expanded == true -> evidence[fact.id] = current.copy(expanded = false)
            // Load each time the list is opened, so an edited or purged source is not shown stale.
            current?.loading != true -> loadSources(fact.id)
        }
    }

    fun run(block: suspend () -> Unit) {
        scope.launch {
            busy = true
            try {
                block()
                error = null
            } catch (e: Exception) {
                error = e
            } finally {
                busy = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(person?.displayName ?: stringResource(R.string.person_title)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back)) } },
                actions = {
                    if (person != null) IconButton(onClick = { renaming = true }) { Icon(Icons.Filled.Edit, stringResource(R.string.person_rename)) }
                },
            )
        },
        floatingActionButton = {
            if (person != null) FloatingActionButton(onClick = { addingFact = true }) { Icon(Icons.Filled.Add, stringResource(R.string.fact_add)) }
        },
    ) { padding ->
        if (person == null) {
            EmptyState(stringResource(R.string.person_not_found), Modifier.padding(padding))
            return@Scaffold
        }
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState())) {
            error?.let { ErrorBanner(errorText(it), Modifier.clickable { error = null }) }
            if (person.languages.isNotEmpty()) {
                Text(
                    stringResource(R.string.person_languages, person.languages.joinToString(", ")),
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            Dropdown(
                label = stringResource(R.string.person_default_context),
                options = contextOptions(contexts),
                selected = person.defaultContextId,
                onSelect = { id -> run { container.directory.setPersonContext(personId, id) } },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            )
            SectionHeader(stringResource(R.string.person_facts))
            if (person.facts.isEmpty()) {
                Text(stringResource(R.string.person_no_facts), Modifier.padding(horizontal = 16.dp))
            }
            person.facts.sortedBy { PERSON_FACT_KEYS.indexOf(it.key) }.forEach { fact ->
                FactCard(
                    fact = fact,
                    onEdit = { editingFact = fact },
                    onDelete = { deletingFact = fact },
                    onToggleVerified = { run { container.directory.editFact(personId, fact.id, null, !fact.verified) } },
                    onToggleSources = { toggleSources(fact) },
                    sourcesExpanded = evidence[fact.id]?.expanded == true,
                )
                evidence[fact.id]?.takeIf { it.expanded }?.let { ui ->
                    FactSourceList(
                        fact = fact,
                        ui = ui,
                        chats = chats,
                        formatter = formatter,
                        onRetry = { loadSources(fact.id) },
                        onOpen = { source -> if (source.canOpen) onOpenConversation(source.chatId!!, source.messageId) },
                    )
                }
            }
            OutlinedButton(onClick = { deletingPerson = true }, modifier = Modifier.padding(16.dp)) {
                Text(stringResource(R.string.person_delete_data))
            }
        }
    }

    editingFact?.let { fact ->
        FactDialog(
            title = stringResource(R.string.fact_edit),
            initialKey = fact.key,
            keyEditable = false,
            initialValue = fact.value,
            onConfirm = { _, value -> run { container.directory.editFact(personId, fact.id, value, true) } },
            onDismiss = { editingFact = null },
        )
    }
    if (addingFact) {
        FactDialog(
            title = stringResource(R.string.fact_add),
            initialKey = "other",
            keyEditable = true,
            initialValue = "",
            onConfirm = { key, value -> run { container.directory.addFact(personId, key, value) } },
            onDismiss = { addingFact = false },
        )
    }
    deletingFact?.let { fact ->
        ConfirmDialog(
            title = stringResource(R.string.fact_delete),
            text = stringResource(R.string.fact_delete_confirm, fact.value),
            confirmLabel = stringResource(R.string.action_delete),
            onConfirm = { run { container.directory.deleteFact(personId, fact.id) } },
            onDismiss = { deletingFact = null },
        )
    }
    if (renaming && person != null) {
        var name by remember { mutableStateOf(person.displayName) }
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text(stringResource(R.string.person_rename)) },
            text = { OutlinedTextField(name, { name = it }, singleLine = true) },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = { run { container.directory.renamePerson(personId, name) }; renaming = false }) {
                    Text(stringResource(R.string.action_save))
                }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
    if (deletingPerson) {
        ConfirmDialog(
            title = stringResource(R.string.person_delete_data),
            text = stringResource(R.string.person_delete_confirm),
            confirmLabel = stringResource(R.string.action_delete),
            onConfirm = {
                scope.launch {
                    try {
                        container.directory.deletePersonData(personId)
                        onBack()
                    } catch (e: Exception) {
                        error = e
                    }
                }
            },
            onDismiss = { deletingPerson = false },
        )
    }
}

@Composable
private fun FactCard(
    fact: PersonFactDto,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onToggleVerified: () -> Unit,
    onToggleSources: () -> Unit,
    sourcesExpanded: Boolean,
) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(factKeyLabel(fact.key)), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(fact.value, style = MaterialTheme.typography.bodyLarge)
            BadgeRow {
                Badge(stringResource(if (fact.source == "owner") R.string.fact_source_owner else R.string.fact_source_ai))
                Badge(stringResource(R.string.confidence_percent, (fact.confidence * 100).roundToInt()))
                if (fact.verified) {
                    Badge(stringResource(R.string.fact_verified), MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer)
                }
                if (fact.selfClaimed) {
                    Badge(stringResource(R.string.fact_self_claimed), MaterialTheme.colorScheme.tertiaryContainer, MaterialTheme.colorScheme.onTertiaryContainer)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = fact.verified, onCheckedChange = { onToggleVerified() })
                Text(stringResource(R.string.fact_verified))
                if (fact.sourceMessageIds.isNotEmpty()) {
                    val count = fact.sourceMessageIds.distinct().size
                    TextButton(onClick = onToggleSources) {
                        Text(
                            if (sourcesExpanded) {
                                stringResource(R.string.fact_sources_hide)
                            } else {
                                pluralStringResource(R.plurals.fact_sources, count, count)
                            },
                        )
                    }
                }
                IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, stringResource(R.string.fact_edit)) }
                IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, stringResource(R.string.fact_delete)) }
            }
        }
    }
}

/** Every source message of [fact], each opening in the chat it actually came from. */
@Composable
private fun FactSourceList(
    fact: PersonFactDto,
    ui: FactEvidenceUi,
    chats: List<ChatEntity>,
    formatter: DueFormatter,
    onRetry: () -> Unit,
    onOpen: (FactSource) -> Unit,
) {
    val messages = ui.messages
    when {
        ui.loading && messages == null -> CircularProgressIndicator(Modifier.padding(horizontal = 32.dp, vertical = 8.dp))
        ui.error != null -> Column(Modifier.padding(horizontal = 32.dp)) {
            Text(errorText(ui.error), color = MaterialTheme.colorScheme.error)
            TextButton(onClick = onRetry) { Text(stringResource(R.string.action_retry)) }
        }
        messages != null -> {
            val sources = remember(fact.sourceMessageIds, messages, chats) { factSources(fact.sourceMessageIds, messages, chats) }
            Column(Modifier.padding(start = 16.dp)) {
                sources.forEach { source ->
                    val message = source.message
                    if (message == null) {
                        Text(
                            stringResource(R.string.fact_source_missing),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        )
                    } else {
                        Text(
                            stringResource(R.string.fact_source_in_chat, source.chatName ?: stringResource(R.string.fact_source_unknown_chat)),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 16.dp, top = 4.dp),
                        )
                        MessageCard(message, formatter, highlighted = false) { onOpen(source) }
                    }
                }
            }
        }
    }
}

@Composable
private fun FactDialog(
    title: String,
    initialKey: String,
    keyEditable: Boolean,
    initialValue: String,
    onConfirm: (String, String) -> Unit,
    onDismiss: () -> Unit,
) {
    var key by remember { mutableStateOf(initialKey) }
    var value by remember { mutableStateOf(initialValue) }
    val keyOptions = PERSON_FACT_KEYS.map { it to stringResource(factKeyLabel(it)) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Dropdown(stringResource(R.string.fact_key), keyOptions, key, { key = it }, enabled = keyEditable)
                OutlinedTextField(value, { value = it.take(500) }, label = { Text(stringResource(R.string.fact_value)) })
            }
        },
        confirmButton = {
            TextButton(enabled = value.isNotBlank(), onClick = { onConfirm(key, value); onDismiss() }) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

fun factKeyLabel(key: String): Int = when (key) {
    "name" -> R.string.fact_key_name
    "company" -> R.string.fact_key_company
    "role" -> R.string.fact_key_role
    "relationship" -> R.string.fact_key_relationship
    "language" -> R.string.fact_key_language
    "topic" -> R.string.fact_key_topic
    "location" -> R.string.fact_key_location
    else -> R.string.fact_key_other
}
