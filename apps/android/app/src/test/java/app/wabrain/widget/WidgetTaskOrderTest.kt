package app.wabrain.widget

import app.wabrain.data.db.TaskEntity
import app.wabrain.domain.TaskGrouping
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetTaskOrderTest {
    private val now = Instant.parse("2026-09-23T12:00:00Z")
    private val zone = ZoneId.of("Europe/Rome")

    private fun task(
        id: String,
        dueAt: String? = null,
        contextId: String? = null,
        chatId: String? = null,
        status: String = "open",
        kind: String = "todo",
    ) = TaskEntity(
        id = id,
        kind = kind,
        status = status,
        title = id,
        description = "",
        dueAt = dueAt?.let { Instant.parse(it).toEpochMilli() },
        dueHasTime = dueAt != null,
        contextId = contextId,
        chatId = chatId,
        personId = null,
        origin = "manual",
        language = null,
        confidence = null,
        evidenceMessageIds = "[]",
        createdAt = 0,
        updatedAt = 0,
        closedAt = null,
    )

    @Test
    fun widgetShowsOpenTasksInDueOrderWithUndatedLast() {
        val tasks = listOf(
            task("undated"),
            task("tomorrow", "2026-09-24T12:00:00Z", kind = "waiting_on"),
            task("done", "2026-09-22T12:00:00Z", status = "done"),
            task("today", "2026-09-23T15:00:00Z"),
            task("overdue", "2026-09-22T15:00:00Z"),
        )
        assertEquals(
            listOf("overdue", "today", "tomorrow", "undated"),
            TaskGrouping.widget(tasks, now, zone).map { it.id },
        )
    }

    @Test
    fun contextFilterUsesTaskOverrideThenChatDefault() {
        val tasks = listOf(
            task("work", contextId = "work"),
            task("inherited", chatId = "chat"),
            task("override", contextId = "personal", chatId = "chat"),
        )
        assertEquals(
            listOf("work", "inherited"),
            TaskGrouping.filterByContext(tasks, "work", mapOf("chat" to "work"), emptyMap()).map { it.id },
        )
    }
}
