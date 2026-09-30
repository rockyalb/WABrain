package app.wabrain

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NotificationNavigationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun freshReviewIntentKeepsTheExactItemInExtrasAndData() {
        val intent = MainActivity.reviewIntent(context, "review / 42")

        assertEquals(AppDestination.Review("review / 42"), intent.navigationTarget())
        assertEquals("wabrain-internal://review/review%20%2F%2042", intent.data.toString())

        // Android may reconstruct a PendingIntent from its unique data URI.
        val dataOnly = Intent(Intent.ACTION_VIEW, intent.data)
        assertEquals(AppDestination.Review("review / 42"), dataOnly.navigationTarget())
    }

    @Test
    fun legacyReviewIntentsStillOpenTheRightLevel() {
        val exactLegacy = Intent().putExtra(MainActivity.EXTRA_REVIEW_ID, "r-old")
        val tabLegacy = Intent().putExtra(MainActivity.EXTRA_OPEN_REVIEW, true)

        assertEquals(AppDestination.Review("r-old"), exactLegacy.navigationTarget())
        assertEquals(AppDestination.Review(null), tabLegacy.navigationTarget())
    }

    @Test
    fun taskNavigationKeepsPriorityWhenAnIntentContainsBothTargets() {
        val intent = MainActivity.taskIntent(context, "task-1")
            .putExtra(MainActivity.EXTRA_REVIEW_ID, "review-1")
            .putExtra(MainActivity.EXTRA_OPEN_REVIEW, true)

        assertEquals(AppDestination.Task("task-1"), intent.navigationTarget())
    }
}
