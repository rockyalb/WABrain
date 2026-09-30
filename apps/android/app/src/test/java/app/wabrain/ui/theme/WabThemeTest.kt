package app.wabrain.ui.theme

import android.app.Application
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.Composition
import androidx.compose.runtime.Recomposer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Glass boxes and transparent scaffolds inherit this color for uncolored Text and Icon. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class WabThemeTest {
    @Test
    fun darkContentInheritsReadableThemeInk() = checkTheme(dark = true)

    @Test
    fun lightContentInheritsReadableThemeInk() = checkTheme(dark = false)

    private fun checkTheme(dark: Boolean) = runTest {
        val recomposer = Recomposer(coroutineContext)
        val composition = Composition(NoOpApplier(), recomposer)
        var inherited = Color.Unspecified
        var expected = Color.Unspecified
        var background = Color.Unspecified
        try {
            composition.setContent {
                WabTheme(darkTheme = dark) {
                    inherited = LocalContentColor.current
                    expected = MaterialTheme.colorScheme.onBackground
                    background = MaterialTheme.colorScheme.background
                }
            }
            assertEquals(expected, inherited)
            val lighter = maxOf(inherited.luminance(), background.luminance())
            val darker = minOf(inherited.luminance(), background.luminance())
            assertTrue("Default text must remain readable against the theme background", (lighter + 0.05f) / (darker + 0.05f) >= 4.5f)
        } finally {
            composition.dispose()
            recomposer.cancel()
        }
    }

    private class NoOpApplier : AbstractApplier<Unit>(Unit) {
        override fun insertTopDown(index: Int, instance: Unit) = Unit
        override fun insertBottomUp(index: Int, instance: Unit) = Unit
        override fun remove(index: Int, count: Int) = Unit
        override fun move(from: Int, to: Int, count: Int) = Unit
        override fun onClear() = Unit
    }
}
