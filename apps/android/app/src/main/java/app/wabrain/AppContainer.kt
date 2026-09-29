package app.wabrain

import android.content.Context
import androidx.glance.appwidget.updateAll
import app.wabrain.data.api.ApiClient
import app.wabrain.data.api.NotificationEventDto
import app.wabrain.data.db.AppDatabase
import app.wabrain.data.repo.ChangeHooks
import app.wabrain.data.repo.DirectoryRepository
import app.wabrain.data.repo.OutboxProcessor
import app.wabrain.data.repo.SyncRepository
import app.wabrain.data.repo.TaskRepository
import app.wabrain.data.session.KeystoreTokenCipher
import app.wabrain.data.session.PairingManager
import app.wabrain.data.session.SessionStore
import app.wabrain.data.session.WidgetPrefs
import app.wabrain.notify.NotificationFeed
import app.wabrain.notify.NotificationInbox
import app.wabrain.notify.NotificationLedger
import app.wabrain.notify.NotificationReconciler
import app.wabrain.notify.Notifier
import app.wabrain.notify.PrefsHandledIdStore
import app.wabrain.sync.WorkScheduler
import app.wabrain.widget.TaskWidget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Manual dependency container: one instance per process, owned by [WabApp]. */
class AppContainer(context: Context) {
    private val appContext = context.applicationContext

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val db: AppDatabase = AppDatabase.create(appContext)
    val session = SessionStore(appContext, KeystoreTokenCipher())
    val widgetPrefs = WidgetPrefs(appContext)
    val api = ApiClient(ApiClient.defaultHttpClient()) { session.credentials() }

    private val hooks = object : ChangeHooks {
        override suspend fun localDataChanged() {
            runCatching { TaskWidget().updateAll(appContext) }
        }

        override fun outboxEnqueued() {
            WorkScheduler.flushOutbox(appContext)
        }
    }

    val sync = SyncRepository(db, api, hooks)
    val outbox = OutboxProcessor(db, api, sync)
    val tasks = TaskRepository(db, api, hooks)
    val directory = DirectoryRepository(db, api, sync, hooks)
    val pairing = PairingManager(appContext, api, db, session, hooks)

    /** Shows Review/reminder/summary notifications once per server id, from push or from the fallback. */
    val notifications = NotificationInbox(NotificationLedger(PrefsHandledIdStore(appContext))) { payload ->
        Notifier.handle(appContext, payload)
    }

    /** The periodic sync's recovery of notifications whose push was lost. */
    val missedNotifications = NotificationReconciler(
        object : NotificationFeed {
            override suspend fun pending(): List<NotificationEventDto> = api.notifications().items
            override suspend fun acknowledge(ids: List<String>) = api.acknowledgeNotifications(ids)
        },
        notifications,
    )
}
