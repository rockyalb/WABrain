package app.wabrain.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Line icons in one weight (2px on a 24px grid) so the bottom bar and the
 * task cards read evenly. Tinted by [androidx.compose.material3.Icon].
 */
object WabIcons {
    val Tasks: ImageVector by lazy { stroked("Tasks", circle(12f, 12f, 9f), "M8 12.4l2.8 2.8 5.4-5.6") }
    val People: ImageVector by lazy { stroked("People", circle(12f, 8f, 3.6f), "M5 20c0.6-3.8 3.4-6 7-6s6.4 2.2 7 6") }
    val Chats: ImageVector by lazy { stroked("Chats", "M4.5 5.5h15v10.5H10l-5.5 4.2z") }
    val Ask: ImageVector by lazy {
        stroked("Ask", circle(10.5f, 10.5f, 6.5f), "M15.4 15.4L20 20", "M10.5 7.6l0.8 2.1 2.1 0.8-2.1 0.8-0.8 2.1-0.8-2.1-2.1-0.8 2.1-0.8z")
    }
    val Settings: ImageVector by lazy { stroked("Settings", "M4 7h9M17 7h3M4 17h3M11 17h9", circle(15f, 7f, 2f), circle(9f, 17f, 2f)) }
    val Sparkle: ImageVector by lazy {
        stroked("Sparkle", "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1-5.1-1.9 5.1-1.9z", "M18.5 16.5l0.8 2 2 0.8-2 0.8-0.8 2-0.8-2-2-0.8 2-0.8z")
    }
    val Person: ImageVector by lazy { stroked("Person", circle(12f, 8f, 3.6f), "M5 20c0.6-3.8 3.4-6 7-6s6.4 2.2 7 6") }
    val Group: ImageVector by lazy {
        stroked("Group", circle(9f, 8.5f, 3.2f), "M3 19c0.5-3.4 3-5.3 6-5.3s5.5 1.9 6 5.3", circle(17f, 9.2f, 2.5f), "M16.8 13.9c2.4 0.2 3.9 1.9 4.2 4.6")
    }
    val Plus: ImageVector by lazy { stroked("Plus", "M12 5v14M5 12h14", width = 2.4f) }
    val Refresh: ImageVector by lazy { stroked("Refresh", "M20 12a8 8 0 1 1-2.34-5.66", "M20 4v5h-5") }
}

private fun circle(cx: Float, cy: Float, r: Float): String = "M${cx - r},${cy}a$r,$r 0 1,0 ${2 * r},0a$r,$r 0 1,0 ${-2 * r},0"

private fun stroked(name: String, vararg paths: String, width: Float = 2f): ImageVector =
    ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
        paths.forEach { d ->
            addPath(
                pathData = addPathNodes(d),
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = width,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()
