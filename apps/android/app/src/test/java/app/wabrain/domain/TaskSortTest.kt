package app.wabrain.domain

import app.wabrain.data.db.TaskEntity
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class TaskSortTest {
    private fun task(id: String, created: Long, updated: Long, due: Long?) = TaskEntity(
        id = id, kind = "todo", status = "open", title = id, description = "", dueAt = due,
        dueHasTime = true, contextId = null, chatId = null, personId = null, origin = "manual",
        language = null, confidence = null, evidenceMessageIds = "[]", createdAt = created,
        updatedAt = updated, closedAt = null,
    )
    private val tasks = listOf(task("a", 1, 3, 5), task("b", 2, 1, null), task("c", 3, 2, 4))

    @Test
    fun sortsEachTimestampInBothDirectionsWithUndatedLast() {
        val expected = mapOf(
            TaskSort.DUE_ASC to listOf("c", "a", "b"), TaskSort.DUE_DESC to listOf("a", "c", "b"),
            TaskSort.CREATED_DESC to listOf("c", "b", "a"), TaskSort.CREATED_ASC to listOf("a", "b", "c"),
            TaskSort.UPDATED_DESC to listOf("a", "c", "b"), TaskSort.UPDATED_ASC to listOf("b", "c", "a"),
        )
        expected.forEach { (sort, ids) -> assertEquals(ids, sort.apply(tasks).map { it.id }) }
        assertEquals(listOf("a", "b", "c"), tasks.map { it.id })
    }

    @Test
    fun breaksTimestampAndNullTiesConsistentlyWithTheServer() {
        val tied = listOf(task("a", 1, 1, null), task("b", 1, 1, null))
        TaskSort.entries.filter { it != TaskSort.DEFAULT }.forEach { sort ->
            assertEquals(listOf("b", "a"), sort.apply(tied).map { it.id })
        }
    }

    @Test
    fun defaultsPreserveListOrderAndUnknownSavedValuesFallBack() {
        assertEquals(tasks, TaskSort.DEFAULT.apply(tasks))
        assertEquals(TaskSort.DEFAULT, TaskSort.fromWire("unknown"))
        assertEquals(TaskSort.CREATED_ASC, TaskSort.fromWire("created_asc"))
    }

    @Test
    fun sortingDoesNotChangeWhichTasksBelongToATab() {
        val now = Instant.ofEpochMilli(3)
        val zone = ZoneId.of("UTC")
        val today = TaskGrouping.today(tasks, now, zone)
        val upcoming = TaskGrouping.upcoming(tasks, now, zone)
        TaskSort.entries.forEach { sort ->
            assertEquals(today.map { it.id }.toSet(), sort.apply(today).map { it.id }.toSet())
            assertEquals(upcoming.map { it.id }.toSet(), sort.apply(upcoming).map { it.id }.toSet())
        }
    }
}
