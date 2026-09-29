package app.wabrain.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.CheckBox
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import app.wabrain.MainActivity
import app.wabrain.R
import app.wabrain.appContainer
import kotlinx.coroutines.launch

/**
 * Home-screen task list. Reads Room only; the app refreshes it after every
 * sync and local mutation (and it observes Room while its session is alive).
 */
class TaskWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val container = context.appContainer
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val initial = WidgetData.load(context, container, appWidgetId)
        provideContent {
            val flow = remember(appWidgetId) { WidgetData.observe(context, container, appWidgetId) }
            val state by flow.collectAsState(initial)
            GlanceTheme {
                WidgetContent(state, appWidgetId)
            }
        }
    }
}

@Composable
private fun WidgetContent(state: WidgetState, appWidgetId: Int) {
    val context = LocalContext.current
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(GlanceTheme.colors.widgetBackground)
            .cornerRadius(16.dp)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Header(state, appWidgetId)
        if (!state.paired) {
            Text(
                text = context.getString(R.string.widget_not_paired),
                style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp),
                modifier = GlanceModifier.padding(top = 8.dp).clickable(actionStartActivity(MainActivity.openIntent(context))),
            )
        } else if (state.rows.isEmpty()) {
            Text(
                text = context.getString(R.string.widget_empty),
                style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp),
                modifier = GlanceModifier.padding(top = 8.dp),
            )
        } else {
            LazyColumn(modifier = GlanceModifier.fillMaxWidth()) {
                items(state.rows, itemId = { it.id.hashCode().toLong() }) { row ->
                    TaskRow(row)
                }
            }
        }
    }
}

@Composable
private fun Header(state: WidgetState, appWidgetId: Int) {
    val context = LocalContext.current
    Row(
        modifier = GlanceModifier.fillMaxWidth().padding(bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = context.getString(R.string.widget_filter_label, state.filterName),
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 15.sp, fontWeight = FontWeight.Bold),
            modifier = GlanceModifier.defaultWeight().clickable(actionStartActivity(WidgetConfigActivity.intent(context, appWidgetId))),
        )
        if (state.reviewCount > 0) {
            Text(
                text = context.getString(R.string.widget_review_badge, state.reviewCount),
                style = TextStyle(color = GlanceTheme.colors.onPrimaryContainer, fontSize = 12.sp, fontWeight = FontWeight.Medium),
                modifier = GlanceModifier
                    .background(GlanceTheme.colors.primaryContainer)
                    .cornerRadius(10.dp)
                    .padding(horizontal = 8.dp, vertical = 2.dp)
                    .clickable(actionStartActivity(MainActivity.reviewTabIntent(context))),
            )
            Spacer(GlanceModifier.width(8.dp))
        }
        Text(
            text = "+",
            style = TextStyle(color = GlanceTheme.colors.primary, fontSize = 22.sp, fontWeight = FontWeight.Bold),
            modifier = GlanceModifier.padding(horizontal = 6.dp).clickable(actionStartActivity(QuickAddActivity.intent(context))),
        )
    }
}

@Composable
private fun TaskRow(row: WidgetRow) {
    val context = LocalContext.current
    Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CheckBox(
            checked = false,
            onCheckedChange = actionRunCallback<CompleteTaskCallback>(actionParametersOf(CompleteTaskCallback.TASK_ID to row.id)),
        )
        Column(
            modifier = GlanceModifier.defaultWeight().clickable(actionStartActivity(MainActivity.taskIntent(context, row.id))),
        ) {
            Text(
                text = if (row.waitingOn) "⏳ ${row.title}" else row.title,
                maxLines = 2,
                style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp),
            )
            if (row.dueText != null) {
                Text(
                    text = row.dueText,
                    maxLines = 1,
                    style = TextStyle(
                        color = if (row.overdue) GlanceTheme.colors.error else GlanceTheme.colors.onSurfaceVariant,
                        fontSize = 12.sp,
                    ),
                )
            }
        }
    }
}

/** Checkbox tap: completes the task in Room + outbox; the widget updates immediately. */
class CompleteTaskCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[TASK_ID] ?: return
        context.appContainer.tasks.complete(id)
        TaskWidget().updateAll(context)
    }

    companion object {
        val TASK_ID = ActionParameters.Key<String>("taskId")
    }
}

class TaskWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TaskWidget()

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        val container = context.appContainer
        container.appScope.launch { container.widgetPrefs.remove(appWidgetIds) }
    }
}
