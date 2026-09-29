package app.wabrain.ui.tasks

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.wabrain.domain.TaskSource
import app.wabrain.ui.common.ContextDot
import app.wabrain.ui.theme.GlassColors
import app.wabrain.ui.theme.LocalGlass
import app.wabrain.ui.theme.WabIcons
import app.wabrain.ui.theme.drawSparkle
import app.wabrain.ui.theme.glass
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/** What a task card shows under its title. */
data class TaskMeta(val dueText: String, val overdue: Boolean, val contextName: String?, val contextColor: String?)

/**
 * Mint Glass task card. Ticking the circle fills it with green, strikes the
 * title through, bursts sparkles and slides the card away; [onComplete] runs
 * when the card has left, so the list closes the gap underneath it.
 */
@Composable
fun GlassTaskCard(
    title: String,
    source: TaskSource?,
    meta: TaskMeta,
    completeLabel: String,
    onOpen: () -> Unit,
    onComplete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val g = LocalGlass.current
    var closing by remember { mutableStateOf(false) }
    val fill = remember { Animatable(0f) }
    val tick = remember { Animatable(0f) }
    val strike = remember { Animatable(0f) }
    val burst = remember { Animatable(0f) }
    val exit = remember { Animatable(0f) }
    val complete by rememberUpdatedState(onComplete)

    LaunchedEffect(closing) {
        if (!closing) return@LaunchedEffect
        launch { fill.animateTo(1f, spring(dampingRatio = 0.5f, stiffness = 500f)) }
        launch { delay(120); tick.animateTo(1f, tween(280)) }
        launch { delay(220); strike.animateTo(1f, tween(360)) }
        launch { delay(140); burst.animateTo(1f, tween(820, easing = LinearOutSlowInEasing)) }
        delay(620)
        exit.animateTo(1f, tween(420, easing = FastOutLinearInEasing))
        complete()
        // If the task is still listed (the change was refused), bring the card back.
        delay(1_500)
        listOf(fill, tick, strike, burst, exit).forEach { it.snapTo(0f) }
        closing = false
    }

    Row(
        modifier
            .fillMaxWidth()
            .graphicsLayer {
                translationX = exit.value * size.width * 0.55f
                alpha = 1f - exit.value
                val s = 1f - 0.04f * exit.value
                scaleX = s
                scaleY = s
            }
            .glass(g)
            .clickable(onClick = onOpen)
            .padding(start = 4.dp, end = 14.dp, top = 6.dp, bottom = 12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        GlassCheck(
            g = g,
            fill = { fill.value },
            tick = { tick.value },
            burst = { burst.value },
            checked = closing,
            label = completeLabel,
            onCheck = { closing = true },
        )
        Column(Modifier.weight(1f).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            if (source != null) SourceLine(source, g)
            StrikeText(title, strike = { strike.value })
            MetaLine(meta)
        }
    }
}

/** A closed task in Recently closed: the same card without a checkbox. */
@Composable
fun GlassClosedCard(title: String, source: TaskSource?, closedText: String, status: String, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val g = LocalGlass.current
    Row(
        modifier
            .fillMaxWidth()
            .glass(g)
            .clickable(onClick = onOpen)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            if (source != null) SourceLine(source, g)
            Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(closedText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(status, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** "Family · Mira" with a group icon, or "Sam Carter" with a person icon. */
@Composable
fun SourceLine(source: TaskSource, g: GlassColors = LocalGlass.current) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Icon(if (source.groupName != null) WabIcons.Group else WabIcons.Person, contentDescription = null, tint = g.source, modifier = Modifier.size(15.dp))
        Text(
            text = source.groupName ?: source.personName.orEmpty(),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
            color = g.source,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (source.groupName != null && source.personName != null) {
            Text(
                text = "· ${source.personName}",
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun MetaLine(meta: TaskMeta) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            meta.dueText,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = if (meta.overdue) FontWeight.SemiBold else FontWeight.Normal,
            color = if (meta.overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (meta.contextName != null) {
            ContextDot(meta.contextColor)
            Text(meta.contextName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Title whose strike-through line draws across each line in turn as [strike] goes from 0 to 1. */
@Composable
private fun StrikeText(title: String, strike: () -> Float) {
    val g = LocalGlass.current
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val ink = MaterialTheme.colorScheme.onSurface
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text(
        text = title,
        style = MaterialTheme.typography.bodyLarge,
        fontWeight = FontWeight.Medium,
        maxLines = 3,
        overflow = TextOverflow.Ellipsis,
        color = lerp(ink, muted, strike()),
        onTextLayout = { layout = it },
        modifier = Modifier.drawWithContent {
            drawContent()
            val l = layout ?: return@drawWithContent
            val p = strike()
            if (p <= 0f) return@drawWithContent
            val widths = (0 until l.lineCount).map { l.getLineRight(it) - l.getLineLeft(it) }
            var remaining = widths.sum() * p
            for (i in 0 until l.lineCount) {
                val w = min(widths[i], remaining)
                if (w <= 0f) break
                val y = (l.getLineTop(i) + l.getLineBottom(i)) / 2f + 1.dp.toPx()
                val x = l.getLineLeft(i)
                drawLine(g.accent, Offset(x, y), Offset(x + w, y), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
                remaining -= w
            }
        },
    )
}

private val SparkAngles = floatArrayOf(0.1f, 0.8f, 1.45f, 2.2f, 2.85f, 3.5f, 4.2f, 4.9f, 5.6f)
private val SparkReach = floatArrayOf(1f, 0.75f, 0.9f, 0.7f, 1f, 0.8f, 0.95f, 0.72f, 0.88f)

/** 44dp touch target around a 26dp glass circle; the sparkles draw beyond its bounds. */
@Composable
private fun GlassCheck(
    g: GlassColors,
    fill: () -> Float,
    tick: () -> Float,
    burst: () -> Float,
    checked: Boolean,
    label: String,
    onCheck: () -> Unit,
) {
    val ring = MaterialTheme.colorScheme.outline
    Box(
        Modifier
            .size(44.dp)
            .semantics { contentDescription = label }
            .toggleable(value = checked, enabled = !checked, role = Role.Checkbox, onValueChange = { if (it) onCheck() })
            .drawBehind {
                val c = Offset(size.width / 2f, size.height / 2f + 2.dp.toPx())
                val r = 13.dp.toPx()
                drawCircle(g.card, r, c)
                drawCircle(ring, r - 1.dp.toPx(), c, style = Stroke(2.dp.toPx()))
                val f = fill()
                if (f > 0f) {
                    drawCircle(
                        Brush.radialGradient(
                            0f to g.accentLight,
                            0.55f to g.accent,
                            1f to g.accentDeep,
                            center = Offset(c.x - r * 0.3f, c.y - r * 0.45f),
                            radius = r * 1.6f,
                        ),
                        radius = r * f.coerceAtMost(1.12f),
                        center = c,
                    )
                }
                val t = tick()
                if (t > 0f) {
                    val u = r * 2f / 24f
                    val path = Path().apply {
                        moveTo(c.x + (5f - 12f) * u, c.y + (12.5f - 12f) * u)
                        lineTo(c.x + (9.3f - 12f) * u, c.y + (16.8f - 12f) * u)
                        lineTo(c.x + (19f - 12f) * u, c.y + (7.2f - 12f) * u)
                    }
                    val measure = PathMeasure().apply { setPath(path, false) }
                    val part = Path()
                    measure.getSegment(0f, measure.length * t, part, true)
                    drawPath(part, Color.White, style = Stroke(2.6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
                }
                val b = burst()
                if (b > 0f && b < 1f) {
                    val out = 1f - (1f - b) * (1f - b)
                    val grow = if (b < 0.45f) b / 0.45f else 1f - (b - 0.45f) / 0.55f
                    for (i in SparkAngles.indices) {
                        val a = SparkAngles[i]
                        val d = (r + 24.dp.toPx() * SparkReach[i]) * out
                        drawSparkle(
                            center = Offset(c.x + cos(a) * d, c.y + sin(a) * d),
                            radius = 6.dp.toPx() * grow * (0.7f + 0.3f * SparkReach[i]),
                            color = g.accent.copy(alpha = grow.coerceIn(0f, 1f)),
                            rotationDegrees = 100f * b + a * 20f,
                        )
                    }
                }
            },
    )
}
