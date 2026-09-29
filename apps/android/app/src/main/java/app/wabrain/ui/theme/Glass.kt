package app.wabrain.ui.theme

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarData
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.wabrain.R

val GlassShape = RoundedCornerShape(20.dp)

/** Mint gradient with two soft blobs drifting slowly behind the content. */
@Composable
fun MintBackdrop(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val g = LocalGlass.current
    val transition = rememberInfiniteTransition(label = "backdrop")
    val drift by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(14_000, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "drift",
    )
    Box(
        modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(Brush.verticalGradient(listOf(g.backdropTop, g.backdropBottom)))
                val a = Offset(size.width * (0.02f + 0.16f * drift), size.height * (0.34f - 0.05f * drift))
                val ra = size.minDimension * (0.55f + 0.08f * drift)
                drawCircle(Brush.radialGradient(listOf(g.blobA.copy(alpha = 0.55f), g.blobA.copy(alpha = 0f)), center = a, radius = ra), ra, a)
                val b = Offset(size.width * (1.02f - 0.14f * drift), size.height * (0.74f - 0.06f * drift))
                val rb = size.minDimension * (0.6f + 0.06f * (1f - drift))
                drawCircle(Brush.radialGradient(listOf(g.blobB.copy(alpha = 0.7f), g.blobB.copy(alpha = 0f)), center = b, radius = rb), rb, b)
            },
        content = content,
    )
}

/** Translucent card: soft fill, bright hairline edge and (in light mode) a green-tinted shadow. */
fun Modifier.glass(g: GlassColors, shape: Shape = GlassShape, elevation: Dp = 8.dp): Modifier {
    val lifted = if (g.cardShadow) {
        shadow(elevation, shape, clip = false, ambientColor = g.shadow.copy(alpha = 0.18f), spotColor = g.shadow.copy(alpha = 0.3f))
    } else {
        this
    }
    return lifted.background(g.card, shape).border(1.dp, g.cardBorder, shape)
}

/** The WABrain logo. Decorative: callers label the surrounding control. */
@Composable
fun WabLogo(size: Dp, modifier: Modifier = Modifier) {
    Image(painterResource(R.drawable.wab_logo), contentDescription = null, modifier = modifier.size(size))
}

/** Four-point star, the same shape as the sparkles in the logo. */
fun DrawScope.drawSparkle(center: Offset, radius: Float, color: Color, rotationDegrees: Float = 0f) {
    val k = radius / 10f
    val path = Path().apply {
        moveTo(0f, -10f * k)
        cubicTo(1f * k, -4f * k, 4f * k, -1f * k, 10f * k, 0f)
        cubicTo(4f * k, 1f * k, 1f * k, 4f * k, 0f, 10f * k)
        cubicTo(-1f * k, 4f * k, -4f * k, 1f * k, -10f * k, 0f)
        cubicTo(-4f * k, -1f * k, -1f * k, -4f * k, 0f, -10f * k)
        close()
    }
    translate(center.x, center.y) {
        rotate(rotationDegrees, pivot = Offset.Zero) { drawPath(path, color) }
    }
}

/** Glossy green action button, lit from the top left like the logo. */
@Composable
fun GlossyFab(onClick: () -> Unit, contentDescription: String, modifier: Modifier = Modifier) {
    val g = LocalGlass.current
    val shape = RoundedCornerShape(20.dp)
    Box(
        modifier
            .size(58.dp)
            .shadow(14.dp, shape, ambientColor = g.accentDeep, spotColor = g.accentDeep)
            .clip(shape)
            .drawBehind {
                drawRect(
                    Brush.radialGradient(
                        0f to Color(0xFF98F7C1),
                        0.5f to g.accent,
                        1f to g.accentDeep,
                        center = Offset(size.width * 0.34f, size.height * 0.24f),
                        radius = size.maxDimension,
                    ),
                )
                drawRect(Color.White.copy(alpha = 0.45f), size = size.copy(height = 2.dp.toPx()), topLeft = Offset(0f, 1.dp.toPx()))
            }
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(WabIcons.Plus, contentDescription, tint = Color.White, modifier = Modifier.size(26.dp))
    }
}

/** Dark glass snackbar with a mint action. */
@Composable
fun GlassSnackbar(data: SnackbarData) {
    val g = LocalGlass.current
    Snackbar(
        snackbarData = data,
        shape = RoundedCornerShape(14.dp),
        containerColor = g.snackbar,
        contentColor = g.onSnackbar,
        actionColor = g.snackbarAction,
    )
}
