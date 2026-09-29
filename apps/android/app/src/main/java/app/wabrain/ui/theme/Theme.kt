package app.wabrain.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import app.wabrain.R

/**
 * Mint Glass: the look built around the WABrain logo. Soft mint light,
 * translucent cards and a glossy green accent. The brand colours are fixed
 * (no dynamic colour) so the app matches its icon on every phone.
 */
@Immutable
data class GlassColors(
    val backdropTop: Color,
    val backdropBottom: Color,
    val blobA: Color,
    val blobB: Color,
    val card: Color,
    val cardBorder: Color,
    val shadow: Color,
    val accent: Color,
    val accentDeep: Color,
    val accentLight: Color,
    val source: Color,
    val snackbar: Color,
    val onSnackbar: Color,
    val snackbarAction: Color,
    val navBar: Color,
    val navIndicator: Color,
    /** Light cards float on a soft green shadow; dark cards stay flat. */
    val cardShadow: Boolean,
)

private val LightGlass = GlassColors(
    backdropTop = Color(0xFFF2FBF6),
    backdropBottom = Color(0xFFE3F6EB),
    blobA = Color(0xFF8FF0BB),
    blobB = Color(0xFFB9F5D5),
    card = Color(0xD9FFFFFF),
    cardBorder = Color(0xE6FFFFFF),
    shadow = Color(0xFF0C6E37),
    accent = Color(0xFF1FBF63),
    accentDeep = Color(0xFF0C8541),
    accentLight = Color(0xFFA6FBCB),
    source = Color(0xFF0C8541),
    snackbar = Color(0xEB0C281A),
    onSnackbar = Color(0xFFEAFBF1),
    snackbarAction = Color(0xFF7FF0B3),
    navBar = Color(0xB3FFFFFF),
    navIndicator = Color(0xFFC9F5DC),
    cardShadow = true,
)

private val DarkGlass = GlassColors(
    backdropTop = Color(0xFF0C1C14),
    backdropBottom = Color(0xFF06110B),
    blobA = Color(0xFF14663F),
    blobB = Color(0xFF0E4A2E),
    card = Color(0x14FFFFFF),
    cardBorder = Color(0x1FFFFFFF),
    shadow = Color(0xFF000000),
    accent = Color(0xFF34D67B),
    accentDeep = Color(0xFF1FA85A),
    accentLight = Color(0xFF8DF5BA),
    source = Color(0xFF7FF0B3),
    snackbar = Color(0xF0182E23),
    onSnackbar = Color(0xFFEAFBF1),
    snackbarAction = Color(0xFF7FF0B3),
    navBar = Color(0xCC0C1A13),
    navIndicator = Color(0xFF1B4A31),
    cardShadow = false,
)

/** The Mint Glass colours that Material's scheme has no slot for. */
val LocalGlass = staticCompositionLocalOf { LightGlass }

private val LightColors = lightColorScheme(
    primary = Color(0xFF0C8541),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFC9F5DC),
    onPrimaryContainer = Color(0xFF04331A),
    secondary = Color(0xFF4B6F5D),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFD7F1E2),
    onSecondaryContainer = Color(0xFF0D2A1B),
    tertiary = Color(0xFF3478F6),
    tertiaryContainer = Color(0xFFDDE8FF),
    onTertiaryContainer = Color(0xFF0B2A66),
    background = Color(0xFFEEF9F2),
    onBackground = Color(0xFF0D2A1B),
    surface = Color(0xFFF3FBF6),
    onSurface = Color(0xFF0D2A1B),
    surfaceVariant = Color(0xFFDCEFE3),
    onSurfaceVariant = Color(0xFF4B6F5D),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF6FCF8),
    surfaceContainer = Color(0xFFEDF8F1),
    surfaceContainerHigh = Color(0xFFE6F4EB),
    surfaceContainerHighest = Color(0xFFDFF0E6),
    outline = Color(0xFF94BBA6),
    outlineVariant = Color(0xFFCBE3D5),
    error = Color(0xFFD8443A),
    onError = Color.White,
    errorContainer = Color(0xFFFFE3DF),
    onErrorContainer = Color(0xFF5C0C06),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF6EE7A2),
    onPrimary = Color(0xFF00391B),
    primaryContainer = Color(0xFF15573A),
    onPrimaryContainer = Color(0xFFC9F5DC),
    secondary = Color(0xFFA9CDB9),
    onSecondary = Color(0xFF15352A),
    secondaryContainer = Color(0xFF223F31),
    onSecondaryContainer = Color(0xFFD7F1E2),
    tertiary = Color(0xFF9CC0FF),
    tertiaryContainer = Color(0xFF1C3766),
    onTertiaryContainer = Color(0xFFDDE8FF),
    background = Color(0xFF08140E),
    onBackground = Color(0xFFE2F2E9),
    surface = Color(0xFF0B1A13),
    onSurface = Color(0xFFE2F2E9),
    surfaceVariant = Color(0xFF1C3027),
    onSurfaceVariant = Color(0xFF9DBFAC),
    surfaceContainerLowest = Color(0xFF06100B),
    surfaceContainerLow = Color(0xFF0E1D16),
    surfaceContainer = Color(0xFF12231A),
    surfaceContainerHigh = Color(0xFF182B21),
    surfaceContainerHighest = Color(0xFF1E3328),
    outline = Color(0xFF55786A),
    outlineVariant = Color(0xFF2A4236),
    error = Color(0xFFFF8A7E),
    onError = Color(0xFF5C0C06),
    errorContainer = Color(0xFF7A1D14),
    onErrorContainer = Color(0xFFFFE3DF),
)

/** Colour used for overdue due dates. */
val OverdueColor: Color @Composable get() = MaterialTheme.colorScheme.error

val Figtree = FontFamily(
    Font(R.font.figtree_regular, FontWeight.Normal),
    Font(R.font.figtree_medium, FontWeight.Medium),
    Font(R.font.figtree_semibold, FontWeight.SemiBold),
    Font(R.font.figtree_bold, FontWeight.Bold),
)

val Sora = FontFamily(
    Font(R.font.sora_semibold, FontWeight.SemiBold),
    Font(R.font.sora_bold, FontWeight.Bold),
)

private val Base = Typography()

/** Sora for display, headline and large titles; Figtree for everything else. */
private val WabTypography = Typography(
    displayLarge = Base.displayLarge.copy(fontFamily = Sora, fontWeight = FontWeight.SemiBold),
    displayMedium = Base.displayMedium.copy(fontFamily = Sora, fontWeight = FontWeight.SemiBold),
    displaySmall = Base.displaySmall.copy(fontFamily = Sora, fontWeight = FontWeight.SemiBold),
    headlineLarge = Base.headlineLarge.copy(fontFamily = Sora, fontWeight = FontWeight.SemiBold),
    headlineMedium = Base.headlineMedium.copy(fontFamily = Sora, fontWeight = FontWeight.SemiBold),
    headlineSmall = Base.headlineSmall.copy(fontFamily = Sora, fontWeight = FontWeight.SemiBold),
    titleLarge = Base.titleLarge.copy(fontFamily = Sora, fontWeight = FontWeight.SemiBold),
    titleMedium = Base.titleMedium.copy(fontFamily = Figtree, fontWeight = FontWeight.SemiBold),
    titleSmall = Base.titleSmall.copy(fontFamily = Figtree, fontWeight = FontWeight.SemiBold),
    bodyLarge = Base.bodyLarge.copy(fontFamily = Figtree),
    bodyMedium = Base.bodyMedium.copy(fontFamily = Figtree),
    bodySmall = Base.bodySmall.copy(fontFamily = Figtree),
    labelLarge = Base.labelLarge.copy(fontFamily = Figtree, fontWeight = FontWeight.SemiBold),
    labelMedium = Base.labelMedium.copy(fontFamily = Figtree, fontWeight = FontWeight.SemiBold),
    labelSmall = Base.labelSmall.copy(fontFamily = Figtree, fontWeight = FontWeight.SemiBold),
)

/** Mint Glass theme with light and dark variants. */
@Composable
fun WabTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalGlass provides if (darkTheme) DarkGlass else LightGlass) {
        MaterialTheme(colorScheme = if (darkTheme) DarkColors else LightColors, typography = WabTypography, content = content)
    }
}
