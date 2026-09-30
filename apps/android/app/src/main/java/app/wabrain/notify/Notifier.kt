package app.wabrain.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.wabrain.MainActivity
import app.wabrain.R
import app.wabrain.data.api.ReviewItemType
import app.wabrain.push.PushPayload

/**
 * Posts notifications for push payloads. Every notification is
 * VISIBILITY_PRIVATE with a generic public version, so the lock screen never
 * shows a task title (and never any message text: payloads carry none).
 */
object Notifier {
    const val CHANNEL_REVIEW = "review"
    const val CHANNEL_REMINDERS = "reminders"
    const val CHANNEL_SUMMARY = "summary"

    private const val GROUP_REVIEW = "app.wabrain.REVIEW"
    private const val GROUP_REMINDERS = "app.wabrain.REMINDERS"
    private const val SUMMARY_ID_REVIEW = 1001
    private const val SUMMARY_ID_REMINDERS = 1002
    private const val DAILY_SUMMARY_ID = 1003
    private const val MAX_SUMMARY_LINES = 5

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_REVIEW, context.getString(R.string.channel_review), NotificationManager.IMPORTANCE_DEFAULT)
                    .apply {
                        description = context.getString(R.string.channel_review_description)
                        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                    },
                NotificationChannel(CHANNEL_REMINDERS, context.getString(R.string.channel_reminders), NotificationManager.IMPORTANCE_HIGH)
                    .apply {
                        description = context.getString(R.string.channel_reminders_description)
                        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                    },
                NotificationChannel(CHANNEL_SUMMARY, context.getString(R.string.channel_summary), NotificationManager.IMPORTANCE_LOW)
                    .apply {
                        description = context.getString(R.string.channel_summary_description)
                        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                    },
            ),
        )
    }

    fun canNotify(context: Context): Boolean {
        val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        return granted && NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun handle(context: Context, payload: PushPayload): Boolean =
        when (payload) {
            is PushPayload.Review -> review(context, payload)
            is PushPayload.Reminder -> reminder(context, payload)
            is PushPayload.Summary -> summary(context, payload)
            PushPayload.Sync, PushPayload.Unknown -> false
        }

    fun reviewNotificationId(reviewItemId: String): Int = ("review:$reviewItemId").hashCode()

    private fun reminderNotificationId(taskId: String): Int = ("reminder:$taskId").hashCode()

    private fun review(context: Context, payload: PushPayload.Review): Boolean {
        val id = reviewNotificationId(payload.reviewItemId)
        val heading = context.getString(
            when (payload.reviewType) {
                ReviewItemType.CREATE -> R.string.review_type_create
                ReviewItemType.POSSIBLY_DONE -> R.string.review_type_possibly_done
                ReviewItemType.POSSIBLY_CANCELLED -> R.string.review_type_possibly_cancelled
                ReviewItemType.RESCHEDULE -> R.string.review_type_reschedule
                ReviewItemType.MERGE -> R.string.review_type_merge
                ReviewItemType.UNKNOWN -> R.string.review_type_unknown
            },
        )
        val confirmation = payload.reviewType.isConfirmation
        val acceptLabel = context.getString(if (confirmation) R.string.action_done else R.string.action_accept)
        val rejectLabel = context.getString(if (confirmation) R.string.action_not_yet else R.string.action_reject)

        val publicVersion = NotificationCompat.Builder(context, CHANNEL_REVIEW)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_public_review))
            .build()

        // Who it came from leads, so a collapsed group still reads "Sam · Office  Check the invoice";
        // the proposal kind then moves to the header.
        val notification = NotificationCompat.Builder(context, CHANNEL_REVIEW)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(payload.from ?: heading)
            .setContentText(payload.title)
            .apply { if (payload.from != null) setSubText(heading) }
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.title))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setGroup(GROUP_REVIEW)
            .setAutoCancel(true)
            .setContentIntent(activityIntent(context, id, MainActivity.reviewIntent(context, payload.reviewItemId)))
            .addAction(0, acceptLabel, ReviewActionReceiver.pendingIntent(context, payload.reviewItemId, accept = true, notificationId = id))
            .addAction(0, rejectLabel, ReviewActionReceiver.pendingIntent(context, payload.reviewItemId, accept = false, notificationId = id))
            .build()
        val posted = post(context, id, notification)
        if (posted) postReviewSummary(context)
        return posted
    }

    /**
     * The group's summary, which some launchers show in place of the stacked items: a count and one
     * line per item ("Sam · Office: Check the invoice") rather than a bare placeholder.
     */
    private fun postReviewSummary(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val lines = manager.activeNotifications
            .filter { it.notification.group == GROUP_REVIEW && it.id != SUMMARY_ID_REVIEW }
            .sortedByDescending { it.postTime }
            .map { active ->
                val extras = active.notification.extras
                val who = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
                val what = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
                if (who.isNullOrBlank()) what.orEmpty() else "$who: ${what.orEmpty()}"
            }
            .filter { it.isNotBlank() }
        if (lines.isEmpty()) {
            postGroupSummary(context, CHANNEL_REVIEW, GROUP_REVIEW, SUMMARY_ID_REVIEW, R.string.notification_public_review)
            return
        }
        val title = context.resources.getQuantityString(R.plurals.notification_review_count, lines.size, lines.size)
        val publicVersion = NotificationCompat.Builder(context, CHANNEL_REVIEW)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_public_review))
            .build()
        val style = NotificationCompat.InboxStyle().setBigContentTitle(title)
        lines.take(MAX_SUMMARY_LINES).forEach { style.addLine(it) }
        if (lines.size > MAX_SUMMARY_LINES) style.setSummaryText("+${lines.size - MAX_SUMMARY_LINES}")
        val notification = NotificationCompat.Builder(context, CHANNEL_REVIEW)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(lines.first())
            .setStyle(style)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setGroup(GROUP_REVIEW)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setAutoCancel(true)
            .setContentIntent(activityIntent(context, SUMMARY_ID_REVIEW, MainActivity.reviewTabIntent(context)))
            .build()
        post(context, SUMMARY_ID_REVIEW, notification)
    }

    private fun reminder(context: Context, payload: PushPayload.Reminder): Boolean {
        val id = reminderNotificationId(payload.taskId)
        val publicVersion = NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_public_reminder))
            .build()
        val notification = NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_reminder_title))
            .setContentText(payload.title)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setGroup(GROUP_REMINDERS)
            .setAutoCancel(true)
            .setContentIntent(activityIntent(context, id, MainActivity.taskIntent(context, payload.taskId)))
            .build()
        val posted = post(context, id, notification)
        if (posted) postGroupSummary(context, CHANNEL_REMINDERS, GROUP_REMINDERS, SUMMARY_ID_REMINDERS, R.string.notification_public_reminder)
        return posted
    }

    private fun summary(context: Context, payload: PushPayload.Summary): Boolean {
        val text = context.getString(R.string.notification_summary_text, payload.dueToday, payload.overdue, payload.review, payload.open)
        val publicVersion = NotificationCompat.Builder(context, CHANNEL_SUMMARY)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_summary_title))
            .build()
        val notification = NotificationCompat.Builder(context, CHANNEL_SUMMARY)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_summary_title))
            .setContentText(text)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setAutoCancel(true)
            .setContentIntent(activityIntent(context, DAILY_SUMMARY_ID, MainActivity.openIntent(context)))
            .build()
        return post(context, DAILY_SUMMARY_ID, notification)
    }

    private fun postGroupSummary(context: Context, channel: String, group: String, id: Int, titleRes: Int) {
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(titleRes))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup(group)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .build()
        post(context, id, notification)
    }

    private fun activityIntent(context: Context, requestCode: Int, intent: Intent): PendingIntent {
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun post(context: Context, id: Int, notification: Notification): Boolean {
        if (!canNotify(context)) return false
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        if (manager.getNotificationChannel(notification.channelId)?.importance == NotificationManager.IMPORTANCE_NONE) return false
        return try {
            NotificationManagerCompat.from(context).notify(id, notification)
            true
        } catch (_: SecurityException) {
            // Permission revoked between the check and the call.
            false
        }
    }

    fun cancel(context: Context, id: Int) {
        NotificationManagerCompat.from(context).cancel(id)
    }

    /** Removes a review notification and updates the group summary: fewer lines, or gone with the last item. */
    fun cancelReview(context: Context, id: Int) {
        cancel(context, id)
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val active = manager.activeNotifications.filter { it.notification.group == GROUP_REVIEW }
        if (active.none { it.id == SUMMARY_ID_REVIEW }) return
        if (active.all { it.id == SUMMARY_ID_REVIEW || it.id == id }) cancel(context, SUMMARY_ID_REVIEW) else postReviewSummary(context)
    }
}
