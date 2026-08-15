package com.pocketagent.app.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/* ------------------------------------------------------------------ */
/* Material 3 first: dynamic color on Android 12+ (the Android         */
/* design language). Hand-tuned tonal fallback below, built around     */
/* a single indigo accent. The craft goal is hierarchy & calm, not     */
/* decoration.                                                         */
/* ------------------------------------------------------------------ */

private val Indigo40 = Color(0xFF4655F0)
private val Indigo80 = Color(0xFFB9C3FF)
private val Indigo90 = Color(0xFFDDE0FF)
private val Indigo10 = Color(0xFF000CAD)
private val Indigo20 = Color(0xFF10249B)
private val Indigo30 = Color(0xFF2A41C9)

private val Neutral90 = Color(0xFFE9E9F2)
private val Neutral10 = Color(0xFF1A1B21)
private val Neutral99 = Color(0xFFFCF8FF)
private val NeutralVariant90 = Color(0xFFE2E1EC)
private val NeutralVariant30 = Color(0xFF46464F)
private val NeutralVariant60 = Color(0xFF90909B)

private val LightColors = lightColorScheme(
    primary = Indigo40,
    onPrimary = Color.White,
    primaryContainer = Indigo90,
    onPrimaryContainer = Indigo10,
    secondary = Color(0xFF595E71),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFDDE1F9),
    onSecondaryContainer = Color(0xFF161B2C),
    tertiary = Color(0xFF75546F),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFD7F3),
    onTertiaryContainer = Color(0xFF2C1229),
    background = Neutral99,
    onBackground = Neutral10,
    surface = Neutral99,
    onSurface = Neutral10,
    surfaceVariant = NeutralVariant90,
    onSurfaceVariant = Color(0xFF45464F),
    surfaceContainer = Color(0xFFEFEDF4),
    surfaceContainerHigh = Color(0xFFE9E7EF),
    surfaceContainerHighest = Color(0xFFE3E1E9),
    outline = Color(0xFF757680),
    outlineVariant = Color(0xFFC6C5D0),
    error = Color(0xFFBA1A1A),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
)

private val DarkColors = darkColorScheme(
    primary = Indigo80,
    onPrimary = Color(0xFF0A1BAA),
    primaryContainer = Indigo30,
    onPrimaryContainer = Indigo90,
    secondary = Color(0xFFC1C5DD),
    onSecondary = Color(0xFF2B3042),
    secondaryContainer = Color(0xFF414659),
    onSecondaryContainer = Color(0xFFDDE1F9),
    tertiary = Color(0xFFE4BAD7),
    onTertiary = Color(0xFF43273F),
    tertiaryContainer = Color(0xFF5B3D56),
    onTertiaryContainer = Color(0xFFFFD7F3),
    background = Color(0xFF121318),
    onBackground = Neutral90,
    surface = Color(0xFF121318),
    onSurface = Neutral90,
    surfaceVariant = Color(0xFF46464F),
    onSurfaceVariant = NeutralVariant90,
    surfaceContainer = Color(0xFF1E1F25),
    surfaceContainerHigh = Color(0xFF292A2F),
    surfaceContainerHighest = Color(0xFF34343A),
    outline = NeutralVariant60,
    outlineVariant = Color(0xFF46464F),
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

/* Type: M3 roles with slightly tightened titles. */
private val AppTypography = Typography(
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 24.sp, letterSpacing = 0.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = 0.3.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp, letterSpacing = 0.2.sp),
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 18.sp, letterSpacing = 0.2.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.4.sp),
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

/* Shape ramp tuned towards One UI: soft, chunky rounds, pill buttons. */
private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(10.dp),
    small = RoundedCornerShape(14.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/** One UI-style fully rounded pill (buttons, input chips). */
val PillShape = RoundedCornerShape(50)

@Composable
fun PocketAgentTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(
        colorScheme = colorScheme,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}

@Composable
fun semantic(): Semantic = if (isSystemInDarkTheme()) DarkSemantic else LightSemantic
