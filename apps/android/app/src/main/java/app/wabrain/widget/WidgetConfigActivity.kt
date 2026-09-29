package app.wabrain.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.lifecycle.lifecycleScope
import app.wabrain.R
import app.wabrain.appContainer
import app.wabrain.ui.common.ContextDot
import app.wabrain.ui.theme.WabTheme
import kotlinx.coroutines.launch

/** Per-instance widget configuration: which context the widget shows (stored per appWidgetId). */
class WidgetConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        // Backing out of the first configuration must not leave a half-added widget.
        setResult(Activity.RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        val container = appContainer
        setContent {
            WabTheme {
                val contexts by container.db.contexts().observeAll().collectAsState(initial = emptyList())
                val current by container.widgetPrefs.filter(appWidgetId).collectAsState(initial = null)
                Surface {
                    Column(Modifier.fillMaxWidth().padding(vertical = 16.dp)) {
                        Text(
                            stringResource(R.string.widget_config_title),
                            style = MaterialTheme.typography.titleLarge,
                            modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                        )
                        val options = listOf<Pair<String?, String>>(null to stringResource(R.string.filter_all)) + contexts.map { it.id to it.name }
                        options.forEach { (id, name) ->
                            ListItem(
                                modifier = Modifier.clickable { choose(appWidgetId, id) },
                                leadingContent = { RadioButton(selected = current == id, onClick = { choose(appWidgetId, id) }) },
                                headlineContent = { Text(name) },
                                trailingContent = { contexts.firstOrNull { it.id == id }?.let { ContextDot(it.color) } },
                            )
                        }
                    }
                }
            }
        }
    }

    private fun choose(appWidgetId: Int, contextId: String?) {
        lifecycleScope.launch {
            appContainer.widgetPrefs.setFilter(appWidgetId, contextId)
            runCatching {
                val glanceId = GlanceAppWidgetManager(this@WidgetConfigActivity).getGlanceIdBy(appWidgetId)
                TaskWidget().update(this@WidgetConfigActivity, glanceId)
            }
            setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
            finish()
        }
    }

    companion object {
        fun intent(context: Context, appWidgetId: Int): Intent = Intent(context, WidgetConfigActivity::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .setData("wabrain-internal://widget-config/$appWidgetId".toUri())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
