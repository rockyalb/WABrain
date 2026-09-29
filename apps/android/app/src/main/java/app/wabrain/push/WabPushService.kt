package app.wabrain.push

import app.wabrain.appContainer
import app.wabrain.sync.WorkScheduler
import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/** Receives UnifiedPush events from the distributor (ntfy or another). */
class WabPushService : PushService() {

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val container = applicationContext.appContainer
        container.appScope.launch {
            container.session.savePushEndpoint(endpoint.url, endpoint.pubKeySet?.pubKey, endpoint.pubKeySet?.auth)
            WorkScheduler.registerPushEndpoint(applicationContext)
        }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        // Payloads are Web Push encrypted; an undecryptable message is still a hint to sync.
        val payload = if (message.decrypted) PushPayload.parse(message.content) else PushPayload.Unknown
        // Same handler as the fallback in SyncWorker: each notificationId is shown once.
        applicationContext.appContainer.notifications.handle(payload)
        // Every push triggers a sync (which also acknowledges delivered notifications),
        // so the app and widget stay current.
        WorkScheduler.syncNow(applicationContext)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        val container = applicationContext.appContainer
        container.appScope.launch { container.session.setPushError(reason.name) }
    }

    override fun onUnregistered(instance: String) {
        val container = applicationContext.appContainer
        container.appScope.launch {
            container.session.clearPush()
            WorkScheduler.removePushEndpoint(applicationContext)
        }
    }
}
