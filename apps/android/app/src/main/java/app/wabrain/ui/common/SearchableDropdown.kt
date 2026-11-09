package app.wabrain.ui.common

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import app.wabrain.R
import app.wabrain.domain.ComboFilter
import app.wabrain.domain.ComboOption

private const val MAX_SHOWN = 60

/**
 * A dropdown you can type into, like the web app's contact pickers: the list
 * narrows to the names (or numbers) that match, and Done picks the first match.
 * With [emptyLabel] the "none" choice (e.g. "All") comes first and [onSelect]
 * gets null for it; [selected] null shows that label. Without it the field is
 * an action picker that empties after each choice, as for "Add contact".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <K : Any> SearchableDropdown(
    label: String,
    options: List<ComboOption<K>>,
    selected: K?,
    onSelect: (K?) -> Unit,
    modifier: Modifier = Modifier,
    emptyLabel: String? = null,
    placeholder: String = stringResource(R.string.combo_placeholder),
) {
    val focus = LocalFocusManager.current
    val selectedLabel = options.firstOrNull { it.key == selected }?.label ?: if (selected == null) emptyLabel.orEmpty() else ""
    var expanded by remember { mutableStateOf(false) }
    // Typing replaces the shown choice; until then the field shows it and the whole list is offered.
    var typing by remember { mutableStateOf(false) }
    var field by remember { mutableStateOf(TextFieldValue(selectedLabel)) }
    LaunchedEffect(selectedLabel) { if (!typing) field = TextFieldValue(selectedLabel) }

    val query = if (typing) field.text else ""
    val matches = remember(options, query) { ComboFilter.filter(options, query) }
    val showEmpty = emptyLabel != null && query.isBlank()

    fun close() {
        expanded = false
        typing = false
        field = TextFieldValue(selectedLabel)
    }
    fun choose(key: K?) {
        onSelect(key)
        close()
        focus.clearFocus()
    }

    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }, modifier = modifier) {
        OutlinedTextField(
            value = field,
            onValueChange = { next ->
                if (next.text != field.text) {
                    typing = true
                    expanded = true
                }
                field = next
            },
            label = { Text(label) },
            placeholder = { Text(placeholder) },
            singleLine = true,
            trailingIcon = {
                if (emptyLabel != null && selected != null && !typing) {
                    IconButton(onClick = { choose(null) }) {
                        Icon(Icons.Filled.Close, stringResource(R.string.combo_clear, label))
                    }
                } else {
                    ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded)
                }
            },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = {
                val first = matches.firstOrNull()
                if (typing && first != null) choose(first.key) else { close(); focus.clearFocus() }
            }),
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryEditable)
                .onFocusChanged { state ->
                    if (state.isFocused) {
                        // Select the shown choice so the first key typed replaces it.
                        field = field.copy(selection = TextRange(0, field.text.length))
                        expanded = true
                    } else if (expanded || typing) {
                        close()
                    }
                },
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { close(); focus.clearFocus() }) {
            if (showEmpty) {
                DropdownMenuItem(text = { Text(emptyLabel.orEmpty()) }, onClick = { choose(null) })
            }
            matches.take(MAX_SHOWN).forEach { option ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(option.label)
                            option.detail?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    },
                    onClick = { choose(option.key) },
                )
            }
            val hint = when {
                matches.isEmpty() && query.isNotBlank() -> stringResource(R.string.combo_no_match, query.trim())
                matches.size > MAX_SHOWN -> pluralStringResource(R.plurals.combo_keep_typing, matches.size, matches.size)
                else -> null
            }
            hint?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
        }
    }
}
