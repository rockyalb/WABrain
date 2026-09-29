package app.wabrain.domain

import app.wabrain.data.db.TaskEntity
import java.time.Duration
import java.time.Instant
import java.time.ZoneId

/** Which bucket an open task falls into relative to "now" in the configured timezone. */
enum class DueBucket { OVERDUE, TODAY, UPCOMING, NO_DUE }

object TaskGrouping {
    const val KIND_TODO = "todo"
    const val KIND_WAITING_ON = "waiting_on"

    fun bucket(task: TaskEntity, now: Instant, zone: ZoneId): DueBucket {
        val due = task.dueAt ?: return DueBucket.NO_DUE
        val dueInstant = Instant.ofEpochMilli(due)
        val startOfTomorrow = now.atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant()
        return when {
            dueInstant.isBefore(now) -> DueBucket.OVERDUE
            dueInstant.isBefore(startOfTomorrow) -> DueBucket.TODAY
            else -> DueBucket.UPCOMING
        }
    }

    /** Ordering shared by the lists and the widget: overdue, today, upcoming, then no due date. */
    private fun comparator(now: Instant, zone: ZoneId): Comparator<TaskEntity> =
        compareBy<TaskEntity> { bucket(it, now, zone).ordinal }
            .thenBy { it.dueAt ?: Long.MAX_VALUE }
            .thenBy { it.createdAt }
            .thenBy { it.id }

    /** Today tab: open to-dos due before the start of tomorrow, overdue first. */
    fun today(tasks: List<TaskEntity>, now: Instant, zone: ZoneId): List<TaskEntity> =
        tasks.filter { it.status == "open" && it.kind == KIND_TODO }
            .filter { bucket(it, now, zone).let { b -> b == DueBucket.OVERDUE || b == DueBucket.TODAY } }
            .sortedWith(comparator(now, zone))

    /** Upcoming tab: open to-dos due from tomorrow on, then those with no due date. */
    fun upcoming(tasks: List<TaskEntity>, now: Instant, zone: ZoneId): List<TaskEntity> =
        tasks.filter { it.status == "open" && it.kind == KIND_TODO }
            .filter { bucket(it, now, zone).let { b -> b == DueBucket.UPCOMING || b == DueBucket.NO_DUE } }
            .sortedWith(comparator(now, zone))

    /** Waiting-on tab: open waiting_on items, by due date with undated last. */
    fun waitingOn(tasks: List<TaskEntity>, now: Instant, zone: ZoneId): List<TaskEntity> =
        tasks.filter { it.status == "open" && it.kind == KIND_WAITING_ON }
            .sortedWith(comparator(now, zone))

    /** Widget: every open task (both kinds), overdue, today, upcoming, no-due last. */
    fun widget(tasks: List<TaskEntity>, now: Instant, zone: ZoneId): List<TaskEntity> =
        tasks.filter { it.status == "open" }.sortedWith(comparator(now, zone))

    /**
     * How far back the Recently closed tab looks. Matches the server's full
     * sync window for closed tasks (`CLOSED_TASK_WINDOW_MS`), so every task
     * shown here is also refreshed by a full snapshot.
     */
    val RECENTLY_CLOSED_WINDOW: Duration = Duration.ofDays(7)

    fun isClosed(task: TaskEntity): Boolean = task.status == "done" || task.status == "cancelled"

    /**
     * Recently closed tab: tasks completed or cancelled (by the owner or
     * automatically) within [window] before [now], newest first. It is the
     * dependable way back to a closed task's history and Undo.
     */
    fun recentlyClosed(
        tasks: List<TaskEntity>,
        now: Instant,
        window: Duration = RECENTLY_CLOSED_WINDOW,
    ): List<TaskEntity> {
        val since = now.minus(window).toEpochMilli()
        return tasks.filter { isClosed(it) && (it.closedAt ?: it.updatedAt) >= since }
            .sortedWith(compareByDescending<TaskEntity> { it.closedAt ?: it.updatedAt }.thenBy { it.id })
    }

    /**
     * The context a task belongs to for filtering: its own override, else the
     * linked chat's default, else the linked person's default.
     */
    fun effectiveContextId(
        task: TaskEntity,
        chatContexts: Map<String, String?>,
        personContexts: Map<String, String?>,
    ): String? = task.contextId
        ?: task.chatId?.let { chatContexts[it] }
        ?: task.personId?.let { personContexts[it] }

    /** Applies a context filter; null means All. */
    fun filterByContext(
        tasks: List<TaskEntity>,
        contextId: String?,
        chatContexts: Map<String, String?>,
        personContexts: Map<String, String?>,
    ): List<TaskEntity> = if (contextId == null) {
        tasks
    } else {
        tasks.filter { effectiveContextId(it, chatContexts, personContexts) == contextId }
    }
}
