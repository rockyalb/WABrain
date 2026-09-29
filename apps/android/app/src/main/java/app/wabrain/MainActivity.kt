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

        fun reviewTabIntent(context: Context): Intent = openIntent(context)
            .setAction(Intent.ACTION_VIEW)
            .setData("wabrain-internal://review".toUri())
            .putExtra(EXTRA_OPEN_REVIEW, true)
    }
}
