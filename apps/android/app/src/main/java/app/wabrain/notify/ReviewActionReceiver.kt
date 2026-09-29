package app.wabrain.notify

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.wabrain.appContainer
import app.wabrain.sync.WorkScheduler
import kotlinx.coroutines.launch

/**
 * Handles Accept / Reject (or Done / Not yet) on a review notification. The
 * decision is written to Room and queued in the outbox, which WorkManager
 * sends even when the app is closed. Not exported: only our own
 * PendingIntents can reach it.
 */
class ReviewActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DECIDE) return
        val itemId = intent.getStringExtra(EXTRA_REVIEW_ID) ?: return
        val accept = intent.getBooleanExtra(EXTRA_ACCEPT, false)
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
        val pending = goAsync()
        val container = context.appContainer
        container.appScope.launch {
            try {
                container.tasks.decideReview(itemId, accept)
                Notifier.cancelReview(context, notificationId)
            } catch (_: Exception) {
                // Keep the notification available if the local write fails; a sync
                // can refresh it when the app is opened again.
                WorkScheduler.syncNow(context)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_DECIDE = "app.wabrain.action.REVIEW_DECISION"
        private const val EXTRA_REVIEW_ID = "reviewItemId"
        private const val EXTRA_ACCEPT = "accept"
        private const val EXTRA_NOTIFICATION_ID = "notificationId"

        fun pendingIntent(context: Context, reviewItemId: String, accept: Boolean, notificationId: Int): PendingIntent {
            val intent = Intent(context, ReviewActionReceiver::class.java).apply {
                action = ACTION_DECIDE
                putExtra(EXTRA_REVIEW_ID, reviewItemId)
                putExtra(EXTRA_ACCEPT, accept)
                putExtra(EXTRA_NOTIFICATION_ID, notificationId)
            }
            val requestCode = notificationId * 2 + if (accept) 1 else 0
            return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
    }
}
