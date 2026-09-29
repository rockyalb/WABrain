package app.wabrain.ui.people

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.wabrain.AppContainer
import app.wabrain.R
import app.wabrain.data.db.dto
import app.wabrain.ui.common.EmptyState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PeopleScreen(container: AppContainer, onOpenPerson: (String) -> Unit) {
    val people by container.db.people().observeAll().collectAsState(initial = emptyList())
    val contexts by container.db.contexts().observeAll().collectAsState(initial = emptyList())
    var query by rememberSaveable { mutableStateOf("") }
    val filtered = remember(people, query) {
        if (query.isBlank()) people else people.filter { it.displayName.contains(query.trim(), ignoreCase = true) }
    }
    val contextNames = remember(contexts) { contexts.associate { it.id to it.name } }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.nav_people)) }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text(stringResource(R.string.search)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            if (filtered.isEmpty()) {
                EmptyState(stringResource(R.string.empty_people))
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(filtered, key = { it.id }) { person ->
                        val dto = remember(person.json) { person.dto }
                        val summary = dto?.facts
                            ?.filter { it.key == "company" || it.key == "role" || it.key == "relationship" }
                            ?.joinToString(" · ") { it.value }
                            .orEmpty()
                        ListItem(
                            modifier = Modifier.clickable { onOpenPerson(person.id) },
                            headlineContent = { Text(person.displayName) },
                            supportingContent = { if (summary.isNotBlank()) Text(summary) },
                            trailingContent = { person.defaultContextId?.let(contextNames::get)?.let { Text(it) } },
                        )
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}
