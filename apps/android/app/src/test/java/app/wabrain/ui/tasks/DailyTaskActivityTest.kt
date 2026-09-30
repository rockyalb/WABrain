package app.wabrain.ui.tasks

import app.wabrain.data.db.TaskEntity
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class DailyTaskActivityTest {
    private val rome = ZoneId.of("Europe/Rome")

    private fun task(id: String, status: String, createdAt: String, closedAt: String? = null) = TaskEntity(
        id = id,
        kind = "todo",
        status = status,
        title = id,
        description = "",
        dueAt = null,
        dueHasTime = false,
        contextId = null,
        chatId = null,
        personId = null,
        origin = "manual",
        language = null,
        confidence = null,
        evidenceMessageIds = "[]",
        createdAt = Instant.parse(createdAt).toEpochMilli(),
        updatedAt = Instant.parse(closedAt ?: createdAt).toEpochMilli(),
        closedAt = closedAt?.let { Instant.parse(it).toEpochMilli() },
    )

    @Test
    fun usesTheConfiguredTimezoneAndIndependentDailyCounts() {
        // 00:30 on 1 October in Rome, while still 30 September UTC.
        val now = Instant.parse("2026-09-30T22:30:00Z")
        val tasks = listOf(
            task("new-today", "open", "2026-09-30T22:05:00Z"),
            task("new-yesterday", "open", "2026-09-30T21:55:00Z"),
            task("old-done-today", "done", "2026-09-01T10:00:00Z", "2026-09-30T22:10:00Z"),
        )

        assertEquals(DailyTaskActivity(completedToday = 1, createdToday = 1), dailyTaskActivity(tasks, now, rome))
    }

    @Test
    fun completionCountCanExistWithoutANewTaskDenominator() {
        val now = Instant.parse("2026-09-30T12:00:00Z")
        val tasks = listOf(task("old-done", "done", "2026-09-01T10:00:00Z", "2026-09-30T08:00:00Z"))

        assertEquals(DailyTaskActivity(completedToday = 1, createdToday = 0), dailyTaskActivity(tasks, now, rome))
    }
}
