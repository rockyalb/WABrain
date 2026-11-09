package app.wabrain.data.session

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.wabrain.domain.TaskSort
import kotlinx.coroutines.flow.map

private val Context.taskListDataStore by preferencesDataStore(name = "task_list")

/** Device-local task-list preferences, independent of pairing credentials. */
class TaskListPrefs(context: Context) {
    private val store = context.taskListDataStore
    private val sortKey = stringPreferencesKey("sort")
    val sort = store.data.map { TaskSort.fromWire(it[sortKey]) }

    suspend fun setSort(sort: TaskSort) {
        store.edit { it[sortKey] = sort.wireValue }
    }
}
