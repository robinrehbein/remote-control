package com.pocketagent.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/* ------------------------------------------------------------------ */
/* One UI (Samsung) design language: signature blue accent, grouped    */
/* white cards on a soft gray canvas, chunky 26dp rounds, pill         */
/* buttons, near-black OLED dark mode. Dynamic color is intentionally  */
/* off — the Samsung palette is the brand.                             */
/* ------------------------------------------------------------------ */

private val OneUiBlue = Color(0xFF0381FE)
private val OneUiBlueDark = Color(0xFF3E91FF)
private val OneUiBlueDeep = Color(0xFF003A75)
private val OneUiBlueTint = Color(0xFFD8E9FF)

private val LightColors = lightColorScheme(
    primary = OneUiBlue,
    onPrimary = Color.White,
    primaryContainer = OneUiBlueTint,
    onPrimaryContainer = OneUiBlueDeep,
    secondary = Color(0xFF54555C),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE5F0FF),
    onSecondaryContainer = Color(0xFF0A3F78),
    tertiary = Color(0xFF7A5900),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFE2A8),
    onTertiaryContainer = Color(0xFF4A3800),
    background = Color(0xFFF6F6F6),
    onBackground = Color(0xFF171717),
    surface = Color(0xFFF6F6F6),
    onSurface = Color(0xFF171717),
    surfaceVariant = Color(0xFFE9E9EC),
    onSurfaceVariant = Color(0xFF6B6B71),
    surfaceContainer = Color.White,
    surfaceContainerHigh = Color.White,
    surfaceContainerHighest = Color(0xFFEDEDEF),
    outline = Color(0xFFC7C7CB),
    outlineVariant = Color(0xFFE8E8EA),
    error = Color(0xFFD93831),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
)

private val DarkColors = darkColorScheme(
    primary = OneUiBlueDark,
    onPrimary = Color.White,
    primaryContainer = OneUiBlueDeep,
    onPrimaryContainer = Color(0xFFCFE4FF),
    secondary = Color(0xFFB9BAC2),
    onSecondary = Color(0xFF26272C),
    secondaryContainer = Color(0xFF103D66),
    onSecondaryContainer = Color(0xFFCBE2FF),
    tertiary = Color(0xFFEFC04B),
    onTertiary = Color(0xFF3E2E00),
    tertiaryContainer = Color(0xFF5A4300),
    onTertiaryContainer = Color(0xFFFFE2A8),
    background = Color(0xFF050507),
    onBackground = Color(0xFFEDEDEF),
    surface = Color(0xFF050507),
    onSurface = Color(0xFFEDEDEF),
    surfaceVariant = Color(0xFF2A2A2F),
    onSurfaceVariant = Color(0xFFA5A5AC),
    surfaceContainer = Color(0xFF19191C),
    surfaceContainerHigh = Color(0xFF232327),
    surfaceContainerHighest = Color(0xFF2D2D32),
    outline = Color(0xFF5A5A61),
    outlineVariant = Color(0xFF2C2C31),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
)

/* Semantic colors for status/diff — consistent, quiet. */
data class Semantic(
    val success: Color,
    val successContainer: Color,
    val warning: Color,
    val warningContainer: Color,
    val added: Color,
    val addedBg: Color,
    val removed: Color,
    val removedBg: Color,
)

val LightSemantic = Semantic(
    success = Color(0xFF1E6E42),
    successContainer = Color(0xFFC9F0D5),
    warning = Color(0xFF815512),
    warningContainer = Color(0xFFFFDDB3),
    added = Color(0xFF226D3C),
    addedBg = Color(0xFFDCF5E2),
    removed = Color(0xFFA63A32),
    removedBg = Color(0xFFFFDAD6),
)

val DarkSemantic = Semantic(
    success = Color(0xFF8BD8A8),
    successContainer = Color(0xFF10512E),
    warning = Color(0xFFFFB95C),
    warningContainer = Color(0xFF523D00),
    added = Color(0xFF93D9A9),
    addedBg = Color(0xFF0F3D22),
    removed = Color(0xFFFFB4AB),
    removedBg = Color(0xFF4A1611),
)

/* Type: One UI leans on medium/semibold titles and roomy body text. */
private val AppTypography = Typography(
    headlineLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 30.sp, letterSpacing = 0.sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 26.sp, letterSpacing = 0.sp),
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 23.sp, letterSpacing = 0.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.5.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 23.sp, letterSpacing = 0.2.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.1.sp),
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 17.sp, letterSpacing = 0.1.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.2.sp),
)

val MonoSmall = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 12.sp,
    lineHeight = 17.sp,
)

val MonoMedium = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 13.sp,
    lineHeight = 18.sp,
)

/* One UI shape ramp: soft, chunky rounds everywhere, 26dp cards. */
private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(10.dp),
    small = RoundedCornerShape(16.dp),
    medium = RoundedCornerShape(20.dp),
    large = RoundedCornerShape(26.dp),
    extraLarge = RoundedCornerShape(30.dp),
)

/** One UI fully rounded pill (buttons, chips, badges). */
val PillShape = RoundedCornerShape(50)

/* ------------------------------------------------------------------ */
/* Spacing tokens — one grid for every screen.                         */
/* ------------------------------------------------------------------ */

/** Outer gutter of every card, list and full-width button. */
val ScreenGutter = 12.dp

/** Inner padding of a card — text inside a card starts at Gutter+Card. */
val CardInset = 16.dp

/** Where free-standing text (section headers, notes) starts: 12+16. */
val ContentInset = ScreenGutter + CardInset

/** Minimum height of a tappable list row (One UI is generous). */
val TileMinHeight = 56.dp

/** Android's minimum comfortable touch target. */
val MinTouchTarget = 48.dp

/** Height of the primary full-width action button. */
val PrimaryButtonHeight = 52.dp

/** Vertical air between one section's card and the next section header. */
val SectionSpacing = 20.dp

/** Divider inset for rows with a leading 36dp icon (16 + 36 + 16). */
val IconRowDividerInset = 68.dp

/** Divider inset for rows with a leading radio button (4 + 48 + 4). */
val RadioRowDividerInset = 56.dp

private val LocalSemantic = staticCompositionLocalOf { LightSemantic }

@Composable
fun PocketAgentTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalSemantic provides if (darkTheme) DarkSemantic else LightSemantic) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = AppTypography,
            shapes = AppShapes,
            content = content,
        )
    }
}

/**
 * Status/diff colors. Reads the value the theme published, so it follows
 * an explicitly forced theme instead of only the system setting.
 */
@Composable
fun semantic(): Semantic = LocalSemantic.current
