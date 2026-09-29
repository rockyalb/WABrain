package app.wabrain.domain

import app.wabrain.data.api.TaskEventDto
import app.wabrain.data.db.TaskEntity
import app.wabrain.ui.detail.TaskDetailViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant

class TaskGroupingTest {
    private val now = Instant.parse("2026-09-24T10:00:00Z")

    private fun task(
        id: String,
        status: String,
        closedAt: Instant?,
        contextId: String? = null,
        chatId: String? = null,
        updatedAt: Instant = Instant.parse("2026-09-01T00:00:00Z"),
    ) = TaskEntity(
        id = id,
        kind = "todo",
        status = status,
        title = id,
        description = "",
        dueAt = null,
        dueHasTime = false,
        contextId = contextId,
        chatId = chatId,
        personId = null,
        origin = "ai",
        language = null,
        confidence = null,
        evidenceMessageIds = "[]",
        createdAt = 0,
        updatedAt = updatedAt.toEpochMilli(),
        closedAt = closedAt?.toEpochMilli(),
    )

    @Test
    fun recentlyClosedKeepsDoneAndCancelledFromTheLastWeekNewestFirst() {
        val tasks = listOf(
            task("open", "open", null),
            task("done-1h", "done", now.minus(Duration.ofHours(1))),
            task("cancelled-2d", "cancelled", now.minus(Duration.ofDays(2))),
            task("done-edge", "done", now.minus(Duration.ofDays(7))),
            task("done-8d", "done", now.minus(Duration.ofDays(8))),
        )

        assertEquals(
            listOf("done-1h", "cancelled-2d", "done-edge"),
            TaskGrouping.recentlyClosed(tasks, now).map { it.id },
        )
    }

    @Test
    fun closedTaskWithoutClosedAtFallsBackToItsLastUpdate() {
        val tasks = listOf(
            task("recent", "done", null, updatedAt = now.minus(Duration.ofHours(3))),
            task("stale", "cancelled", null, updatedAt = now.minus(Duration.ofDays(30))),
        )

        assertEquals(listOf("recent"), TaskGrouping.recentlyClosed(tasks, now).map { it.id })
    }

    @Test
    fun closedTasksLeaveTheOpenTabsButStayInRecentlyClosed() {
        val autoClosed = task("auto", "done", now.minus(Duration.ofMinutes(5)))
        val tasks = listOf(autoClosed, task("open", "open", null))
        val zone = java.time.ZoneId.of("Europe/Rome")

        val openTabs = TaskGrouping.today(tasks, now, zone) + TaskGrouping.upcoming(tasks, now, zone) + TaskGrouping.waitingOn(tasks, now, zone)
        assertEquals(listOf("open"), openTabs.map { it.id })
        assertEquals(listOf("open"), TaskGrouping.widget(tasks, now, zone).map { it.id })
        assertEquals(listOf("auto"), TaskGrouping.recentlyClosed(tasks, now).map { it.id })
    }

    @Test
    fun recentlyClosedHonoursTheContextFilterThroughTheChatDefault() {
        val tasks = listOf(
            task("work-chat", "done", now.minus(Duration.ofHours(1)), chatId = "chat-work"),
            task("personal-override", "done", now.minus(Duration.ofHours(2)), contextId = "personal", chatId = "chat-work"),
        )
        val filtered = TaskGrouping.filterByContext(tasks, "work", mapOf("chat-work" to "work"), emptyMap())

        assertEquals(listOf("work-chat"), TaskGrouping.recentlyClosed(filtered, now).map { it.id })
    }

    @Test
    fun anAutomaticallyCompletedTaskStillOffersUndoInItsDetailHistory() {
        val completed = task("task-1", "done", now.minus(Duration.ofHours(1)))
        val event = TaskEventDto(
            id = "event-1",
            taskId = completed.id,
            type = "completed",
            actor = "ai",
            undoableUntil = "2026-09-25T09:00:00Z",
            createdAt = "2026-09-24T09:00:00Z",
        )

        assertEquals(listOf(completed.id), TaskGrouping.recentlyClosed(listOf(completed), now).map { it.id })
        assertTrue(event.id in TaskDetailViewModel.undoableEventIds(listOf(event), now))
    }
}
