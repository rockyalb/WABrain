package app.wabrain.domain

import app.wabrain.data.db.TaskEntity

/** Wire values match the task API. Default preserves the order supplied by each tab. */
enum class TaskSort(val wireValue: String) {
    DEFAULT("default"),
    DUE_ASC("due_asc"),
    DUE_DESC("due_desc"),
    CREATED_DESC("created_desc"),
    CREATED_ASC("created_asc"),
    UPDATED_DESC("updated_desc"),
    UPDATED_ASC("updated_asc");

    fun apply(tasks: List<TaskEntity>): List<TaskEntity> {
        if (this == DEFAULT) return tasks
        val descending = wireValue.endsWith("_desc")
        fun value(task: TaskEntity): Long? = when (this) {
            DUE_ASC, DUE_DESC -> task.dueAt
            CREATED_ASC, CREATED_DESC -> task.createdAt
            else -> task.updatedAt
        }
        return tasks.sortedWith { a, b ->
            val left = value(a)
            val right = value(b)
            val comparison = when {
                left == null && right == null -> 0
                left == null -> 1
                right == null -> -1
                descending -> right.compareTo(left)
                else -> left.compareTo(right)
            }
            if (comparison != 0) comparison else b.id.compareTo(a.id)
        }
    }

    companion object {
        fun fromWire(value: String?): TaskSort = entries.find { it.wireValue == value } ?: DEFAULT
    }
}
