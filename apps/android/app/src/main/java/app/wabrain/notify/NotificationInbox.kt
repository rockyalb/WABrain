package app.wabrain.notify

import android.content.Context
import androidx.core.content.edit
import app.wabrain.data.api.NotificationEventDto
import app.wabrain.push.PushPayload

/**
 * One entry point for Review, reminder and summary notifications, whether they
 * arrive by UnifiedPush or through the fallback list (`GET /v1/notifications`,
 * polled by the periodic sync). Each server `notificationId` is shown at most
 * once: the ledger remembers the ids already handled on this device.
 */
class NotificationInbox(
    private val ledger: NotificationLedger,
    private val show: (PushPayload) -> Boolean,
) {
    /** Shows [payload] unless its notificationId was handled before. Returns true when it was shown. */
    @Synchronized
    fun handle(payload: PushPayload): Boolean {
        if (payload is PushPayload.Sync || payload is PushPayload.Unknown) return false
        val id = payload.notificationId
        // Payloads without an id (an older server) cannot be deduplicated; show them.
        if (id != null && ledger.isHandled(id)) return false
        if (!show(payload)) return false
        if (id != null) ledger.markHandled(id)
        return true
    }

    fun isHandled(id: String): Boolean = ledger.isHandled(id)
}

/** Ids of notifications already handled on this device, most recent last, bounded. */
class NotificationLedger(
    private val store: HandledIdStore,
    private val capacity: Int = DEFAULT_CAPACITY,
) {
    private val lock = Any()
    private var ids: LinkedHashSet<String>? = null

    /** Records [id]; true when it was new (the caller shows it), false when it was already handled. */
    fun markHandled(id: String): Boolean = synchronized(lock) {
        val handled = ids ?: LinkedHashSet(store.load()).also { ids = it }
        if (!handled.add(id)) return false
        while (handled.size > capacity) handled.remove(handled.first())
        store.save(handled.toList())
        true
    }

    fun isHandled(id: String): Boolean = synchronized(lock) {
        (ids ?: LinkedHashSet(store.load()).also { ids = it }).contains(id)
    }

    companion object {
        /** Far above the 100 unacknowledged items the server lists at once. */
        const val DEFAULT_CAPACITY = 500
    }
}

interface HandledIdStore {
    fun load(): List<String>
    fun save(ids: List<String>)
}

/** [HandledIdStore] in private SharedPreferences (one newline-separated value). */
class PrefsHandledIdStore(context: Context) : HandledIdStore {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun load(): List<String> =
        prefs.getString(KEY, null).orEmpty().split('\n').filter { it.isNotBlank() }

    override fun save(ids: List<String>) {
        prefs.edit { putString(KEY, ids.joinToString("\n")) }
    }

    private companion object {
        const val PREFS = "notification_ledger"
        const val KEY = "handled_ids"
    }
}

/** The device's server-side notification list (ApiClient in the app, a fake in tests). */
interface NotificationFeed {
    suspend fun pending(): List<NotificationEventDto>
    suspend fun acknowledge(ids: List<String>)
}

/**
 * Recovers notifications whose push was lost or never sent (no distributor):
 * shows the listed ones not handled yet, then acknowledges handled ids so
 * the server stops offering them to this device. Server errors propagate so the
 * worker can retry (or unpair on 401); an id handled before a failed
 * acknowledgement is not shown again on the next run.
 */
class NotificationReconciler(
    private val feed: NotificationFeed,
    private val inbox: NotificationInbox,
) {
    /** Returns how many notifications were shown. */
    suspend fun reconcile(): Int {
        val items = feed.pending()
        if (items.isEmpty()) return 0
        var shown = 0
        val acknowledged = mutableListOf<String>()
        for (item in items) {
            val payload = PushPayload.parse(item.payload, fallbackId = item.id)
            if (inbox.handle(payload)) shown++
            // Unknown types cannot be displayed by this client. Known alerts blocked by OS
            // permission/channel settings stay pending so a later sync can recover them.
            if (payload is PushPayload.Unknown || payload is PushPayload.Sync ||
                inbox.isHandled(payload.notificationId ?: item.id)
            ) acknowledged += item.id
        }
        acknowledged.distinct().chunked(MAX_ACK).forEach { feed.acknowledge(it) }
        return shown
    }

    private companion object {
        const val MAX_ACK = 100
    }
}
