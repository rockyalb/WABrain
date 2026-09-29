package app.wabrain.widget

import android.content.Context
import app.wabrain.AppContainer
import app.wabrain.R
import app.wabrain.data.db.dto
import app.wabrain.domain.DueBucket
import app.wabrain.domain.DueFormatter
import app.wabrain.domain.DueWords
import app.wabrain.domain.Instants
import app.wabrain.domain.TaskGrouping
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import java.time.Instant
import java.util.Locale

data class WidgetRow(
    val id: String,
    val title: String,
    val waitingOn: Boolean,
    val dueText: String?,
    val overdue: Boolean,
)

data class WidgetState(
    val paired: Boolean,
    val filterName: String,
    val reviewCount: Int,
    val rows: List<WidgetRow>,
)

/** Builds the widget's view of Room for one widget instance (its own context filter). */
object WidgetData {
    private const val MAX_ROWS = 50

    fun observe(context: Context, container: AppContainer, appWidgetId: Int): Flow<WidgetState> {
        val db = container.db
        val base = combine(
            db.tasks().observeOpen(),
            db.reviews().observeCount(),
            db.contexts().observeAll(),
            container.widgetPrefs.filter(appWidgetId),
            container.session.session,
        ) { tasks, reviewCount, contexts, filter, session ->
            Base(tasks, reviewCount, contexts, filter, session != null)
        }
        return combine(base, db.chats().observeAll(), db.people().observeAll(), db.settings().observe()) { b, chats, people, settings ->
            val s = settings?.dto
            val zone = Instants.zoneOrDefault(s?.timezone)
            val now = Instant.now()
            val filterId = b.filter?.takeIf { id -> b.contexts.any { it.id == id } }
            val filtered = TaskGrouping.filterByContext(
                b.tasks,
                filterId,
                chats.associate { it.id to it.defaultContextId },
                people.associate { it.id to it.defaultContextId },
            )
            val formatter = DueFormatter(
                zone,
                Locale.getDefault(),
                DueWords(
                    today = context.getString(R.string.due_today),
                    tomorrow = context.getString(R.string.due_tomorrow),
                    yesterday = context.getString(R.string.due_yesterday),
                ),
            )
            val rows = TaskGrouping.widget(filtered, now, zone).take(MAX_ROWS).map { task ->
                WidgetRow(
                    id = task.id,
                    title = task.title,
                    waitingOn = task.kind == TaskGrouping.KIND_WAITING_ON,
                    dueText = task.dueAt?.let { formatter.formatDue(it, task.dueHasTime, now) },
                    overdue = TaskGrouping.bucket(task, now, zone) == DueBucket.OVERDUE,
                )
            }
            WidgetState(
                paired = b.paired,
                filterName = b.contexts.firstOrNull { it.id == filterId }?.name ?: context.getString(R.string.filter_all),
                reviewCount = b.reviewCount,
                rows = rows,
            )
        }
    }

    suspend fun load(context: Context, container: AppContainer, appWidgetId: Int): WidgetState =
        observe(context, container, appWidgetId).first()

    private data class Base(
        val tasks: List<app.wabrain.data.db.TaskEntity>,
        val reviewCount: Int,
        val contexts: List<app.wabrain.data.db.ContextEntity>,
        val filter: String?,
        val paired: Boolean,
    )
}
