package app.wabrain.ui.settings

import android.content.Intent
import android.provider.Settings
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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import app.wabrain.AppContainer
import app.wabrain.BuildConfig
import app.wabrain.R
import app.wabrain.data.api.SettingsDto
import app.wabrain.data.db.ContextEntity
import app.wabrain.data.db.dto
import app.wabrain.domain.Instants
import app.wabrain.notify.Notifier
import app.wabrain.push.PushController
import app.wabrain.ui.common.ConfirmDialog
import app.wabrain.ui.common.ContextDot
import app.wabrain.ui.common.Dropdown
import app.wabrain.ui.common.ErrorBanner
import app.wabrain.ui.common.LabeledRow
import app.wabrain.ui.common.SearchPickerDialog
import app.wabrain.ui.common.SectionHeader
import app.wabrain.ui.common.TimePickerModal
import app.wabrain.ui.common.errorText
import app.wabrain.ui.common.rememberDueFormatter
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val HHMM = DateTimeFormatter.ofPattern("HH:mm")
private val LEAD_OPTIONS = listOf(0, 5, 10, 15, 30, 60, 120, 1440)
val CONTEXT_COLORS = listOf("#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#6B7280")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(container: AppContainer) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val session by container.session.session.collectAsState(initial = null)
    val push by container.session.push.collectAsState(initial = null)
    val settingsEntity by container.db.settings().observe().collectAsState(initial = null)
    val contexts by container.db.contexts().observeAll().collectAsState(initial = emptyList())
    val pending by container.db.outbox().observeCount().collectAsState(initial = 0)
    val settings = settingsEntity?.dto ?: SettingsDto()
    val zone = Instants.zoneOrDefault(settings.timezone)
    val formatter = rememberDueFormatter(zone)

    var error by remember { mutableStateOf<Throwable?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var lastSync by remember { mutableStateOf<Long?>(null) }
    var refreshKey by remember { mutableIntStateOf(0) }
    var pickZone by remember { mutableStateOf(false) }
    var pickEod by remember { mutableStateOf(false) }
    var pickSummary by remember { mutableStateOf(false) }
    var confirmUnpair by remember { mutableStateOf(false) }
    var editContext by remember { mutableStateOf<ContextEntity?>(null) }
    var addContext by remember { mutableStateOf(false) }
    var deleteContext by remember { mutableStateOf<ContextEntity?>(null) }
    var pickDistributor by remember { mutableStateOf(false) }
    val unpairOffline = stringResource(R.string.settings_unpaired_offline)

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { refreshKey++ }
    LaunchedEffect(refreshKey, pending) { lastSync = container.sync.lastSyncAt() }
    val distributors = remember(refreshKey) { PushController.distributors(context) }
    val currentDistributor = remember(refreshKey, push) { PushController.currentDistributor(context) }
    val notificationsOk = remember(refreshKey) { Notifier.canNotify(context) }

    fun run(block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
                error = null
            } catch (e: Exception) {
                error = e
            }
        }
    }

    fun patch(body: JsonObject) = run { container.directory.patchSettings(body) }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.nav_settings)) }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState())) {
            error?.let { ErrorBanner(errorText(it), Modifier.clickable { error = null }) }
            info?.let { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.primary) }

            // ---------------------------------------------------------- server
            SectionHeader(stringResource(R.string.settings_server))
            LabeledRow(stringResource(R.string.settings_server_url), session?.serverUrl.orEmpty())
            LabeledRow(stringResource(R.string.settings_device), session?.deviceName.orEmpty())
            session?.pairedAt?.takeIf { it > 0 }?.let { LabeledRow(stringResource(R.string.settings_paired_at), formatter.formatInstant(it)) }
            LabeledRow(
                stringResource(R.string.settings_last_sync),
                lastSync?.let { formatter.formatInstant(it) } ?: stringResource(R.string.settings_never),
            )
            if (pending > 0) LabeledRow(stringResource(R.string.settings_pending), pending.toString())
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = {
                    run {
                        container.outbox.flush()
                        container.sync.sync()
                        refreshKey++
                    }
                }) { Text(stringResource(R.string.settings_sync_now)) }
                OutlinedButton(onClick = { confirmUnpair = true }) { Text(stringResource(R.string.settings_unpair)) }
            }

            // ---------------------------------------------------------- contexts
            SectionHeader(stringResource(R.string.settings_contexts))
            contexts.forEach { ctx ->
                ListItem(
                    leadingContent = { ContextDot(ctx.color) },
                    headlineContent = { Text(ctx.name) },
                    trailingContent = {
                        Row {
                            IconButton(onClick = { editContext = ctx }) { Icon(Icons.Filled.Edit, stringResource(R.string.action_edit)) }
                            IconButton(onClick = { deleteContext = ctx }) { Icon(Icons.Filled.Delete, stringResource(R.string.action_delete)) }
                        }
                    },
                )
            }
            TextButton(onClick = { addContext = true }, modifier = Modifier.padding(horizontal = 8.dp)) {
                Text(stringResource(R.string.settings_add_context))
            }

            // ---------------------------------------------------------- time
            SectionHeader(stringResource(R.string.settings_time))
            ListItem(
                modifier = Modifier.clickable { pickZone = true },
                headlineContent = { Text(stringResource(R.string.settings_timezone)) },
                supportingContent = { Text(settings.timezone) },
            )
            ListItem(
                modifier = Modifier.clickable { pickEod = true },
                headlineContent = { Text(stringResource(R.string.settings_end_of_work_day)) },
                supportingContent = { Text(stringResource(R.string.settings_end_of_work_day_hint, settings.endOfWorkDay)) },
            )

            // ---------------------------------------------------------- reminders
            SectionHeader(stringResource(R.string.settings_notifications))
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_reminders)) },
                trailingContent = {
                    Switch(checked = settings.remindersEnabled, onCheckedChange = { patch(buildJsonObject { put("remindersEnabled", it) }) })
                },
            )
            if (settings.remindersEnabled) {
                Dropdown(
                    label = stringResource(R.string.settings_reminder_lead),
                    options = (LEAD_OPTIONS + settings.reminderLeadMinutes).distinct().sorted().map { it to leadLabel(it) },
                    selected = settings.reminderLeadMinutes,
                    onSelect = { patch(buildJsonObject { put("reminderLeadMinutes", it) }) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                )
            }
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_daily_summary)) },
                supportingContent = {
                    Text(settings.dailySummaryTime ?: stringResource(R.string.settings_off), Modifier.clickable { pickSummary = true })
                },
                trailingContent = {
                    Switch(
                        checked = settings.dailySummaryTime != null,
                        onCheckedChange = { on ->
                            if (on) pickSummary = true else patch(buildJsonObject { put("dailySummaryTime", null as String?) })
                        },
                    )
                },
            )
            if (!notificationsOk) {
                Column(Modifier.padding(horizontal = 16.dp)) {
                    Text(stringResource(R.string.settings_notifications_blocked), color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = {
                        context.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }) { Text(stringResource(R.string.settings_open_notification_settings)) }
                }
            }

            // ---------------------------------------------------------- push
            SectionHeader(stringResource(R.string.settings_push))
            val pushStatus = when {
                distributors.isEmpty() -> stringResource(R.string.push_no_distributor)
                currentDistributor == null -> stringResource(R.string.push_not_registered)
                push?.lastError != null -> stringResource(R.string.push_error, push?.lastError.orEmpty())
                push?.registeredWithServer == true -> stringResource(R.string.push_active, PushController.distributorLabel(context, currentDistributor))
                else -> stringResource(R.string.push_pending, PushController.distributorLabel(context, currentDistributor))
            }
            Text(pushStatus, Modifier.padding(horizontal = 16.dp))
            if (distributors.isEmpty()) {
                Text(stringResource(R.string.push_install_ntfy), Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
            } else {
                TextButton(onClick = { pickDistributor = true }, modifier = Modifier.padding(horizontal = 8.dp)) {
                    Text(stringResource(R.string.push_choose_distributor))
                }
            }

            // ---------------------------------------------------------- trial (read-only)
            SectionHeader(stringResource(R.string.settings_ai))
            settings.trialStartedAt?.let {
                LabeledRow(stringResource(R.string.settings_trial), pluralStringResource(R.plurals.settings_trial_value, settings.trialDays, formatter.formatInstant(it), settings.trialDays))
            }
            LabeledRow(stringResource(R.string.settings_threshold), String.format(java.util.Locale.ROOT, "%.2f", settings.autoCreateThreshold))
            Text(stringResource(R.string.settings_ai_hint), Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall)

            // ---------------------------------------------------------- about
            SectionHeader(stringResource(R.string.settings_about))
            LabeledRow(stringResource(R.string.settings_version), BuildConfig.VERSION_NAME)
            Text(stringResource(R.string.settings_privacy_statement), Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium)
        }
    }

    if (pickZone) {
        val zones = remember { ZoneId.getAvailableZoneIds().filter { '/' in it && !it.startsWith("Etc/") }.sorted().map { it to it } }
        SearchPickerDialog(
            title = stringResource(R.string.settings_timezone),
            options = zones,
            onPick = { patch(buildJsonObject { put("timezone", it) }) },
            onDismiss = { pickZone = false },
        )
    }
    if (pickEod) {
        TimePickerModal(
            Instants.localTimeOrDefault(settings.endOfWorkDay),
            onPick = { patch(buildJsonObject { put("endOfWorkDay", it.format(HHMM)) }) },
            onDismiss = { pickEod = false },
        )
    }
    if (pickSummary) {
        TimePickerModal(
            settings.dailySummaryTime?.let { runCatching { LocalTime.parse(it) }.getOrNull() } ?: LocalTime.of(8, 0),
            onPick = { patch(buildJsonObject { put("dailySummaryTime", it.format(HHMM)) }) },
            onDismiss = { pickSummary = false },
        )
    }
    if (confirmUnpair) {
        ConfirmDialog(
            title = stringResource(R.string.settings_unpair),
            text = stringResource(R.string.settings_unpair_confirm),
            confirmLabel = stringResource(R.string.settings_unpair),
            onConfirm = {
                scope.launch {
                    val ok = container.pairing.unpair()
                    if (!ok) info = unpairOffline
                }
            },
            onDismiss = { confirmUnpair = false },
        )
    }
    if (addContext) {
        ContextDialog(null, onDismiss = { addContext = false }) { name, color -> run { container.directory.createContext(name, color) } }
    }
    editContext?.let { ctx ->
        ContextDialog(ctx, onDismiss = { editContext = null }) { name, color -> run { container.directory.updateContext(ctx.id, name, color) } }
    }
    deleteContext?.let { ctx ->
        DeleteContextDialog(ctx, contexts.filter { it.id != ctx.id }, onDismiss = { deleteContext = null }) { reassign ->
            run { container.directory.deleteContext(ctx.id, reassign) }
        }
    }
    if (pickDistributor) {
        SearchPickerDialog(
            title = stringResource(R.string.push_choose_distributor),
            options = distributors.map { it to PushController.distributorLabel(context, it) },
            onPick = {
                PushController.registerWith(context, it)
                refreshKey++
            },
            onDismiss = { pickDistributor = false },
        )
    }
}

@Composable
private fun leadLabel(minutes: Int): String = when {
    minutes == 0 -> stringResource(R.string.lead_at_due)
    minutes % 1440 == 0 -> pluralStringResource(R.plurals.lead_days, minutes / 1440, minutes / 1440)
    minutes % 60 == 0 -> pluralStringResource(R.plurals.lead_hours, minutes / 60, minutes / 60)
    else -> pluralStringResource(R.plurals.lead_minutes, minutes, minutes)
}

@Composable
private fun ContextDialog(initial: ContextEntity?, onDismiss: () -> Unit, onSave: (String, String?) -> Unit) {
    var name by remember { mutableStateOf(initial?.name.orEmpty()) }
    var color by remember { mutableStateOf(initial?.color ?: CONTEXT_COLORS.first()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (initial == null) R.string.settings_add_context else R.string.settings_edit_context)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(name, { name = it.take(40) }, label = { Text(stringResource(R.string.context_name)) }, singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    CONTEXT_COLORS.forEach { hex ->
                        IconButton(onClick = { color = hex }) {
                            ContextDot(hex, Modifier.padding(if (hex == color) 0.dp else 4.dp))
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = { onSave(name, color); onDismiss() }) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
private fun DeleteContextDialog(ctx: ContextEntity, others: List<ContextEntity>, onDismiss: () -> Unit, onDelete: (String?) -> Unit) {
    var reassign by remember { mutableStateOf(others.firstOrNull()?.id) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.context_delete_title, ctx.name)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.context_delete_text))
                Dropdown(
                    label = stringResource(R.string.context_reassign_to),
                    options = listOf<Pair<String?, String>>(null to stringResource(R.string.context_none)) + others.map { it.id to it.name },
                    selected = reassign,
                    onSelect = { reassign = it },
                )
            }
        },
        confirmButton = { TextButton(onClick = { onDelete(reassign); onDismiss() }) { Text(stringResource(R.string.action_delete)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}
