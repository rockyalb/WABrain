package app.wabrain.ui.common

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.wabrain.R
import app.wabrain.domain.DueFormatter
import app.wabrain.domain.DueWords
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale

/** Date picker; the Material picker works in UTC millis, so convert via UTC to keep the calendar date. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DatePickerModal(initial: LocalDate?, onPick: (LocalDate) -> Unit, onDismiss: () -> Unit) {
    val state = rememberDatePickerState(
        initialSelectedDateMillis = (initial ?: LocalDate.now()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                onDismiss()
            }) { Text(stringResource(R.string.action_ok)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    ) {
        DatePicker(state = state)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimePickerModal(initial: LocalTime?, onPick: (LocalTime) -> Unit, onDismiss: () -> Unit) {
    val start = initial ?: LocalTime.of(9, 0)
    val state = rememberTimePickerState(initialHour = start.hour, initialMinute = start.minute, is24Hour = true)
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = { onPick(LocalTime.of(state.hour, state.minute)); onDismiss() }) { Text(stringResource(R.string.action_ok)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
        text = { TimePicker(state = state) },
    )
}

/** Searchable single-choice list dialog (timezones, link targets). */
@Composable
fun <K> SearchPickerDialog(
    title: String,
    options: List<Pair<K, String>>,
    onPick: (K) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val filtered = remember(query, options) {
        if (query.isBlank()) options else options.filter { it.second.contains(query.trim(), ignoreCase = true) }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text(stringResource(R.string.search)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    items(filtered) { (key, label) ->
                        ListItem(
                            headlineContent = { Text(label) },
                            modifier = Modifier.fillMaxWidth().clickable { onPick(key); onDismiss() },
                        )
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}


/** DueFormatter for the configured timezone with localized day words. */
@Composable
fun rememberDueFormatter(zone: ZoneId): DueFormatter {
    val context = LocalContext.current
    val today = stringResource(R.string.due_today)
    val tomorrow = stringResource(R.string.due_tomorrow)
    val yesterday = stringResource(R.string.due_yesterday)
    return remember(zone, today, context) {
        DueFormatter(zone, Locale.getDefault(), DueWords(today, tomorrow, yesterday))
    }
}

/** A row of text buttons: pick date, add/remove time, clear. */
@Composable
fun DueEditor(
    date: LocalDate?,
    time: LocalTime?,
    onChange: (LocalDate?, LocalTime?) -> Unit,
    modifier: Modifier = Modifier,
) {
    var pickDate by remember { mutableStateOf(false) }
    var pickTime by remember { mutableStateOf(false) }
    Column(modifier) {
        Text(
            text = when {
                date == null -> stringResource(R.string.due_none)
                time == null -> stringResource(R.string.due_date_only, date.toString())
                else -> stringResource(R.string.due_date_time, date.toString(), time.toString())
            },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { pickDate = true }) { Text(stringResource(R.string.due_pick_date)) }
            if (date != null) {
                if (time == null) {
                    TextButton(onClick = { pickTime = true }) { Text(stringResource(R.string.due_add_time)) }
                } else {
                    TextButton(onClick = { onChange(date, null) }) { Text(stringResource(R.string.due_remove_time)) }
                }
                TextButton(onClick = { onChange(null, null) }) { Text(stringResource(R.string.due_clear)) }
            }
        }
    }
    if (pickDate) DatePickerModal(date, onPick = { onChange(it, time) }, onDismiss = { pickDate = false })
    if (pickTime) TimePickerModal(time, onPick = { onChange(date, it) }, onDismiss = { pickTime = false })
}
