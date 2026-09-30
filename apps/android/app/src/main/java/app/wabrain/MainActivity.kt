package app.wabrain

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.net.toUri
import app.wabrain.ui.AppRoot
import app.wabrain.ui.theme.WabTheme
import kotlinx.coroutines.flow.MutableStateFlow

/** Single activity. Intents (deep links, notification taps, widget taps) are forwarded to [AppRoot]. */
class MainActivity : ComponentActivity() {
    private val pendingIntent = MutableStateFlow<Intent?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) pendingIntent.value = intent
        setContent {
            WabTheme {
                AppRoot(
                    container = appContainer,
                    pendingIntent = pendingIntent,
                    onIntentConsumed = { pendingIntent.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingIntent.value = intent
    }

    companion object {
        const val EXTRA_TASK_ID = "app.wabrain.extra.TASK_ID"
        const val EXTRA_REVIEW_ID = "app.wabrain.extra.REVIEW_ID"
        const val EXTRA_OPEN_REVIEW = "app.wabrain.extra.OPEN_REVIEW"

        fun openIntent(context: Context): Intent =
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

        fun taskIntent(context: Context, taskId: String): Intent = openIntent(context)
            .setAction(Intent.ACTION_VIEW)
            // Unique data so each row's PendingIntent is distinct.
            .setData(("wabrain-internal://task/" + Uri.encode(taskId)).toUri())
            .putExtra(EXTRA_TASK_ID, taskId)

        fun reviewIntent(context: Context, reviewItemId: String? = null): Intent = openIntent(context)
            .setAction(Intent.ACTION_VIEW)
            .setData(
                if (reviewItemId == null) {
                    "wabrain-internal://review".toUri()
                } else {
                    ("wabrain-internal://review/" + Uri.encode(reviewItemId)).toUri()
                },
            )
            .putExtra(EXTRA_OPEN_REVIEW, true)
            .apply { if (reviewItemId != null) putExtra(EXTRA_REVIEW_ID, reviewItemId) }

        fun reviewTabIntent(context: Context): Intent = reviewIntent(context)
    }
}

/** The one navigation decision made from launcher, widget and notification intents. */
internal sealed interface AppDestination {
    data class Task(val id: String) : AppDestination
    data class Review(val itemId: String?) : AppDestination
}

/**
 * Extras keep old notification PendingIntents working. The data URI makes new
 * PendingIntents distinct and preserves their destination if Android rebuilds
 * an intent without its extras.
 */
internal fun Intent.navigationTarget(): AppDestination? {
    getStringExtra(MainActivity.EXTRA_TASK_ID)?.takeIf { it.isNotBlank() }?.let { return AppDestination.Task(it) }
    val internal = data?.takeIf { it.scheme == "wabrain-internal" }
    if (internal?.host == "task") {
        internal.pathSegments.firstOrNull()?.takeIf { it.isNotBlank() }?.let { return AppDestination.Task(it) }
    }

    getStringExtra(MainActivity.EXTRA_REVIEW_ID)?.takeIf { it.isNotBlank() }?.let { return AppDestination.Review(it) }
    if (internal?.host == "review") {
        return AppDestination.Review(internal.pathSegments.firstOrNull()?.takeIf { it.isNotBlank() })
    }
    if (getBooleanExtra(MainActivity.EXTRA_OPEN_REVIEW, false)) return AppDestination.Review(null)
    return null
}
