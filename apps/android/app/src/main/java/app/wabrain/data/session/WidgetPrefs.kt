package app.wabrain.data.session

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.widgetDataStore: DataStore<Preferences> by preferencesDataStore(name = "widgets")

/** Per-widget-instance context filter, keyed by appWidgetId. Missing means All. */
class WidgetPrefs(context: Context) {
    private val store = context.widgetDataStore

    fun filter(appWidgetId: Int): Flow<String?> = store.data.map { it[key(appWidgetId)]?.takeIf { v -> v != ALL } }

    suspend fun currentFilter(appWidgetId: Int): String? = filter(appWidgetId).first()

    suspend fun setFilter(appWidgetId: Int, contextId: String?) {
        store.edit { it[key(appWidgetId)] = contextId ?: ALL }
    }

    suspend fun remove(appWidgetIds: IntArray) {
        store.edit { prefs -> appWidgetIds.forEach { prefs.remove(key(it)) } }
    }

    private fun key(id: Int) = stringPreferencesKey("filter_$id")

    private companion object {
        const val ALL = "__all__"
    }
}
