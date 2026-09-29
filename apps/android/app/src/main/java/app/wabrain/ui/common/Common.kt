package app.wabrain.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.wabrain.R
import app.wabrain.data.api.ApiException
import app.wabrain.data.api.NotPairedException
import app.wabrain.data.db.ContextEntity
import app.wabrain.ui.theme.LocalGlass
import app.wabrain.ui.theme.WabLogo
import java.io.IOException

/** Maps an exception from the API layer to a user-facing message. */
@Composable
fun errorText(error: Throwable): String = when {
    error is ApiException && error.isUnauthorized -> stringResource(R.string.error_unauthorized)
    error is ApiException && error.isNotImplemented -> stringResource(R.string.error_not_implemented)
    error is ApiException && error.status == 404 -> stringResource(R.string.error_not_found)
    error is ApiException && error.status == 409 -> stringResource(R.string.error_conflict)
    error is ApiException && error.status == 429 -> stringResource(R.string.error_rate_limited)
    error is ApiException && error.status == 413 -> stringResource(R.string.error_too_large)
    error is ApiException -> stringResource(R.string.error_server, error.message ?: error.status.toString())
    error is NotPairedException -> stringResource(R.string.error_not_paired)
    error is IOException -> stringResource(R.string.error_network)
    else -> stringResource(R.string.error_generic)
}

@Composable
fun LoadingBox(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
fun EmptyState(text: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            WabLogo(64.dp, Modifier.alpha(0.85f))
            Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
}

@Composable
fun ErrorBanner(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onErrorContainer,
        style = MaterialTheme.typography.bodyMedium,
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(12.dp),
    )
}

@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = { TextButton(onClick = { onConfirm(); onDismiss() }) { Text(confirmLabel) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

/** Parses "#RRGGBB" into a colour. */
fun parseHexColor(hex: String?): Color? = runCatching {
    if (hex == null || !hex.matches(Regex("^#[0-9a-fA-F]{6}$"))) null else Color(0xFF000000 or hex.substring(1).toLong(16))
}.getOrNull()

@Composable
fun ContextDot(color: String?, modifier: Modifier = Modifier) {
    val c = parseHexColor(color) ?: MaterialTheme.colorScheme.outline
    Box(modifier.size(10.dp).background(c, CircleShape))
}

/** Context filter chips: All plus each context. Null selection means All. */
@Composable
fun ContextFilterChips(
    contexts: List<ContextEntity>,
    selected: String?,
    onSelect: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            FilterChip(
                selected = selected == null,
                onClick = { onSelect(null) },
                label = { Text(stringResource(R.string.filter_all)) },
                shape = ChipShape,
                colors = glassChipColors(),
                border = null,
            )
        }
        items(contexts, key = { it.id }) { ctx ->
            FilterChip(
                selected = selected == ctx.id,
                onClick = { onSelect(ctx.id) },
                label = { Text(ctx.name) },
                leadingIcon = { ContextDot(ctx.color) },
                shape = ChipShape,
                colors = glassChipColors(),
                border = null,
            )
        }
    }
}

private val ChipShape = RoundedCornerShape(14.dp)

/** Chips sit on the glass: translucent when off, solid green when on. */
@Composable
private fun glassChipColors() = FilterChipDefaults.filterChipColors(
    containerColor = LocalGlass.current.card,
    labelColor = MaterialTheme.colorScheme.onSurface,
    selectedContainerColor = MaterialTheme.colorScheme.primary,
    selectedLabelColor = MaterialTheme.colorScheme.onPrimary,
    selectedLeadingIconColor = MaterialTheme.colorScheme.onPrimary,
)

/** A dropdown for choosing among labelled options; null key is allowed (e.g. "None"). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <K> Dropdown(
    label: String,
    options: List<Pair<K, String>>,
    selected: K,
    onSelect: (K) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.first == selected }?.second.orEmpty()
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { if (enabled) expanded = it }, modifier = modifier) {
        OutlinedTextField(
            value = selectedLabel,
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable, enabled),
            singleLine = true,
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (key, text) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(key); expanded = false })
            }
        }
    }
}

/** Contexts as dropdown options with a leading "None / inherit" entry. */
@Composable
fun contextOptions(contexts: List<ContextEntity>, noneLabel: String = stringResource(R.string.context_none)): List<Pair<String?, String>> =
    listOf<Pair<String?, String>>(null to noneLabel) + contexts.map { it.id to it.name }

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 6.dp),
    )
}

@Composable
fun Badge(text: String, container: Color = MaterialTheme.colorScheme.secondaryContainer, content: Color = MaterialTheme.colorScheme.onSecondaryContainer) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = content,
        modifier = Modifier.background(container, MaterialTheme.shapes.small).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
fun LabeledRow(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
fun BadgeRow(content: @Composable () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { content() }
}
