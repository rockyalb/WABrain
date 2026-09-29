package app.wabrain.ui.ask

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import app.wabrain.R
import app.wabrain.ui.theme.LocalGlass
import app.wabrain.ui.theme.WabLogo
import app.wabrain.ui.theme.drawSparkle
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.sin

/** Circuit traces from the logo's edge outwards, on a 220-unit grid centred on the logo. */
private val Traces = listOf(
    floatArrayOf(160f, 100f, 174f, 100f, 184f, 88f, 206f, 88f),
    floatArrayOf(160f, 120f, 176f, 120f, 186f, 132f, 204f, 132f),
    floatArrayOf(60f, 100f, 46f, 100f, 36f, 88f, 14f, 88f),
    floatArrayOf(60f, 120f, 44f, 120f, 34f, 132f, 16f, 132f),
    floatArrayOf(110f, 60f, 110f, 44f, 122f, 32f, 122f, 14f),
    floatArrayOf(110f, 160f, 110f, 176f, 98f, 188f, 98f, 206f),
)

private val Twinkles = listOf(Offset(30f, 38f), Offset(184f, 34f), Offset(188f, 184f), Offset(38f, 178f))

private val Steps = listOf(R.string.ask_step_reading, R.string.ask_step_matching, R.string.ask_step_writing)

/**
 * Shown while Ask is searching: the logo breathes inside glass ripples while
 * the circuit traces carry pulses into it, and a shimmering line says what
 * the search is doing.
 */
@Composable
fun AskSearching(modifier: Modifier = Modifier) {
    val g = LocalGlass.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val transition = rememberInfiniteTransition(label = "ask")
    val ripple by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(2400, easing = LinearEasing)), label = "ripple")
    val breath by transition.animateFloat(1f, 1.07f, infiniteRepeatable(tween(800, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "breath")
    val flow by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(900, easing = LinearEasing)), label = "flow")
    val twinkle by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "twinkle")
    val shimmer by transition.animateFloat(-0.5f, 1.5f, infiniteRepeatable(tween(1800, easing = LinearEasing)), label = "shimmer")

    var step by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (step < Steps.lastIndex) {
            delay(1_800)
            step++
        }
    }
    val searching = stringResource(R.string.ask_searching)

    Column(
        modifier.fillMaxWidth().semantics { contentDescription = searching },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier
                .size(200.dp)
                .drawBehind {
                    val s = size.width / 220f
                    val c = Offset(size.width / 2f, size.height / 2f)
                    // Glass ripples.
                    for (i in 0 until 3) {
                        val p = (ripple + i / 3f) % 1f
                        val r = 48f * s * (0.85f + 1.2f * p)
                        val a = (1f - p) * 0.9f
                        drawCircle(
                            Brush.radialGradient(listOf(Color.Transparent, g.accentLight.copy(alpha = 0.3f * a)), center = c, radius = r),
                            radius = r,
                            center = c,
                        )
                        drawCircle(g.accent.copy(alpha = 0.45f * a), r, c, style = Stroke(2.dp.toPx()))
                    }
                    // Circuit traces with pulses flowing towards the logo.
                    val dash = PathEffect.dashPathEffect(floatArrayOf(5f * s, 9f * s), phase = flow * 14f * s)
                    Traces.forEachIndexed { i, t ->
                        val path = Path().apply {
                            moveTo(t[0] * s, t[1] * s)
                            var k = 2
                            while (k < t.size) {
                                lineTo(t[k] * s, t[k + 1] * s)
                                k += 2
                            }
                        }
                        drawPath(path, g.accent.copy(alpha = 0.85f), style = Stroke(2.2f * s, cap = StrokeCap.Round, join = StrokeJoin.Round, pathEffect = dash))
                        val glow = ((sin((twinkle + i / 3f) * 2f * PI) + 1f) / 2f).toFloat()
                        val end = Offset(t[t.size - 2] * s, t[t.size - 1] * s)
                        drawCircle(lerp(Color.White, g.accent, glow), 4f * s, end)
                        drawCircle(g.accent, 4f * s, end, style = Stroke(2f * s))
                    }
                    // Sparkles twinkling around the orb.
                    Twinkles.forEachIndexed { i, o ->
                        val v = ((sin((twinkle + i * 0.27f) * 2f * PI) + 1f) / 2f).toFloat()
                        drawSparkle(Offset(o.x * s, o.y * s), (6f + 3f * v) * s, g.accent.copy(alpha = 0.2f + 0.8f * v), rotationDegrees = 45f * v)
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            WabLogo(
                88.dp,
                Modifier.graphicsLayer {
                    scaleX = breath
                    scaleY = breath
                },
            )
        }
        Text(
            stringResource(Steps[step]),
            style = MaterialTheme.typography.titleSmall.merge(
                TextStyle(
                    brush = Brush.linearGradient(
                        0f to muted,
                        0.5f to g.accent,
                        1f to muted,
                        start = Offset(shimmer * 600f - 150f, 0f),
                        end = Offset(shimmer * 600f + 150f, 0f),
                    ),
                ),
            ),
        )
        Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            listOf(1f, 0.86f, 0.62f).forEach { fraction ->
                Box(
                    Modifier
                        .fillMaxWidth(fraction)
                        .height(12.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .drawBehind {
                            val x = shimmer * size.width
                            drawRect(
                                Brush.linearGradient(
                                    0f to g.accent.copy(alpha = 0.1f),
                                    0.5f to g.accent.copy(alpha = 0.28f),
                                    1f to g.accent.copy(alpha = 0.1f),
                                    start = Offset(x - size.width * 0.4f, 0f),
                                    end = Offset(x + size.width * 0.4f, 0f),
                                ),
                            )
                        },
                )
            }
        }
    }
}
