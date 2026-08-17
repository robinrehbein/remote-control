package com.pocketagent.app.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
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
import com.pocketagent.app.ui.ProvideAppInsets

/* ------------------------------------------------------------------ */
/* One UI (Samsung) design language: signature blue accent, grouped    */
/* white cards on a soft gray canvas, chunky 26dp rounds, pill         */
/* buttons, near-black OLED dark mode. Dynamic color is intentionally  */
/* off — the Samsung palette is the brand.                             */
/* ------------------------------------------------------------------ */

/*
 * One UI publishes three blues with three jobs, not one accent:
 *
 *   Primary dark  #0072de (hell) / #3e91ff (dunkel) — gefüllte Buttons
 *   Primary       #0381fe                           — FAB, Slider
 *   Color control #3e91ff                           — Checkbox, Schalter
 *
 * Die Trennung ist keine Kosmetik: Weiß auf #0381fe erreicht nur 3,77:1 und
 * verfehlt damit AA. Der dunklere Ton existiert genau deshalb, weil auf
 * gefüllten Buttons weiße Schrift steht.
 */
private val OneUiBlue = Color(0xFF0381FE)
private val OneUiBlueButton = Color(0xFF0072DE)
private val OneUiBlueDark = Color(0xFF3E91FF)
private val OneUiBlueDeep = Color(0xFF003A75)
private val OneUiBlueTint = Color(0xFFD8E9FF)

/**
 * Schrift auf dem gefüllten Button im dunklen Thema. One UI schreibt für den
 * Button-Hintergrund #3e91ff vor und sagt nichts über die Schrift; Weiß käme
 * dort auf 3,13:1. Diese dunkle Tinte erreicht 5,45:1 und folgt zugleich der
 * Material-Konvention, im dunklen Thema hell zu füllen und dunkel zu
 * beschriften.
 */
private val OneUiOnBlueDark = Color(0xFF001D36)

/** FAB und Slider tragen den helleren Primary — dort steht keine Schrift. */
val OneUiAccent = OneUiBlue

private val LightColors = lightColorScheme(
    primary = OneUiBlueButton,
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
    // 6B6B71 kam auf dem eigenen Chip-Grund nur auf 4,37:1. One UI verlangt
    // „at least a 4.5:1 contrast" für kleine Schrift; dieser Ton erreicht
    // 5,23:1 auf surfaceVariant und 6,34:1 auf der weißen Karte.
    onSurfaceVariant = Color(0xFF5F5F65),
    surfaceContainer = Color.White,
    surfaceContainerHigh = Color.White,
    surfaceContainerHighest = Color(0xFFEDEDEF),
    outline = Color(0xFFC7C7CB),
    outlineVariant = Color(0xFFE8E8EA),
    // D93831 auf seinem eigenen 13%-Tint (StatusBadge „Fehler") ergab 3,81:1.
    // Dieser Ton kommt auf 4,80:1 und bleibt als Rot erkennbar.
    error = Color(0xFFC0271F),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
)

private val DarkColors = darkColorScheme(
    primary = OneUiBlueDark,
    onPrimary = OneUiOnBlueDark,
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

/*
 * Type: One UI leans on medium/semibold titles and roomy body text.
 *
 * Sizes that map onto a documented One UI role carry it in a comment. The
 * list-row title is deliberately NOT one of them — titleSmall also carries
 * chat and markdown headings, where 17sp Regular would collide with body
 * text. That role has its own token, [ListItemTitle], below.
 */
private val AppTypography = Typography(
    headlineLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 30.sp, letterSpacing = 0.sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 26.sp, letterSpacing = 0.sp),
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 23.sp, letterSpacing = 0.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.5.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 23.sp, letterSpacing = 0.2.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.1.sp),
    /** One UI secondary text: textAppearanceSmall, 13sp. */
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, letterSpacing = 0.1.sp),
    /** One UI button label: 15sp Bold, never all-caps. */
    labelLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 15.sp),
    /** One UI section header: ListSeparator, 13sp Bold. */
    labelMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 13.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.2.sp),
)

/**
 * Title of a row in a grouped list — the One UI `textAppearanceListItem`:
 * 17sp Regular, not a smaller semibold. Small half-bold text surrounded by
 * generous whitespace reads as cramped and vague at once; the roomier
 * regular is what makes a One UI list scan.
 *
 * Every grouped-list row uses this, so agents, autonomy modes, repositories
 * and settings rows all read identically. Chat and markdown keep titleSmall.
 */
val ListItemTitle = TextStyle(
    fontWeight = FontWeight.Normal,
    fontSize = 17.sp,
    lineHeight = 22.sp,
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
/*                                                                     */
/* Measured against the SESL8 resources (One UI 8). Samsung publishes  */
/* no complete dp specification, so these mirror the values Samsung's  */
/* own components carry rather than a documented grid. One UI does not */
/* follow an 8pt rhythm — odd values like 13 and 5 are deliberate.     */
/* ------------------------------------------------------------------ */

/** Outer gutter of every card, list and full-width button. */
val ScreenGutter = 10.dp

/**
 * Inner padding of a card — text inside a card starts at Gutter+Card.
 *
 * 14 statt 12, damit [ContentInset] die einzige harte Zahl trifft, die One UI
 * überhaupt veröffentlicht: „display information and place interactive
 * components with margins of at least 24 dp on both the left and right sides"
 * (one-ui/layout/grid). 10 + 14 = 24.
 */
val CardInset = 14.dp

/** Where free-standing text (section headers, notes) starts: 10+12. */
val ContentInset = ScreenGutter + CardInset

/** Minimum height of a tappable list row (listPreferredItemHeightSmall). */
val TileMinHeight = 56.dp

/** Vertical padding inside a list row, above and below its text block. */
val RowVerticalPadding = 14.dp

/** Android's minimum comfortable touch target. */
val MinTouchTarget = 48.dp

/** Height of the primary full-width action button (Button.Custom). */
val PrimaryButtonHeight = 44.dp

/** Label size of that button — noticeably larger than a Material button. */
val PrimaryButtonTextSize = 18.sp

/**
 * Height of one composer line: the input pill and the round send button
 * next to it share it, so the two read as a single row. Never below
 * [MinTouchTarget].
 */
val ComposerHeight = 56.dp

/**
 * Sichtbare Höhe eines Einstell-Chips — die Pille, die einen Wert nennt und
 * ihr Sheet öffnet. Bewusst klein: ein Chip ist von Natur aus kompakt.
 *
 * Das ist ausdrücklich **nur die gezeichnete Höhe**. Die Tippfläche misst
 * [MinTouchTarget]; One UI verlangt Flächen, die „large enough to be touched
 * easily" sind, und ein 34-dp-Ziel ist das für das primäre Bedienelement
 * zweier Screens nicht.
 */
val ChipHeight = 34.dp

/** Luft zwischen zwei Chips — groß genug gegen Danebentippen. */
val ChipSpacing = 8.dp

/**
 * Widest a chip's value may get before it ellipsizes. Long model ids would
 * otherwise push every other chip off the row.
 */
val ChipValueMaxWidth = 160.dp

/**
 * Breiteste Lesespalte. One UI: „Stretched-out apps are harder to read and
 * waste the extra space of the large screen." Auf einem Tablet liefe eine
 * Zeile sonst über die volle Gerätebreite, und „Session starten" wäre ein
 * tausend dp breiter Knopf.
 *
 * Der Wert ist nicht dokumentiert — die Guideline nennt für Inhaltsbreiten
 * keine Zahl. Er ist gewählt, nicht zitiert.
 */
val ContentMaxWidth = 640.dp

/** Vertical air between one section's card and the next section header. */
val SectionSpacing = 20.dp

/**
 * Luft unter einer unten verankerten Fläche — Dialog oder Sheet — zusätzlich
 * zu dem Platz, den Gestenleiste bzw. Tastatur ohnehin schon beanspruchen.
 *
 * Der [ScreenGutter] allein reicht dort nicht: er ist der Abstand zwischen
 * zwei Karten, nicht der zwischen einer Aktionszeile und einer Leiste, die auf
 * eine Wischgeste wartet. One UI verlangt Tippflächen, die „large enough to be
 * touched easily" sind — ein „Abbrechen", das 10 dp über dem Gestenbalken
 * endet, ist das nicht: der untere Rand seiner Tippfläche liegt dann schon im
 * Bereich, in dem das System die Geste abfängt.
 */
val BottomSurfaceGap = 16.dp

/**
 * Seitlicher Einzug eines zentrierten Leer-/Fehler-Zustands (Liste ohne
 * Sessions, Session ohne Verlauf, Diff ohne Änderungen oder mit Fehler).
 * War an allen vier Stellen dieselbe hartkodierte Zahl ohne Token — der
 * einzige wiederkehrende Wert im Spacing-System, der eine Grid-Änderung
 * vergessen hätte.
 */
val EmptyStateInset = 40.dp

/* ------------------------------------------------------------------ */
/* Bewegung                                                            */
/*                                                                     */
/* One UI veröffentlicht hier drei Dinge und sonst nichts: eine        */
/* Untergrenze, eine Obergrenze und eine Kurve. Die Zuordnung einzelner */
/* Dauern zu einzelnen Übergängen ist nicht dokumentiert — die Werte    */
/* unten sind eine Wahl innerhalb des veröffentlichten Fensters, keine  */
/* Vorgabe von Samsung.                                                 */
/* ------------------------------------------------------------------ */

/**
 * One UI Basic Path Interpolator, Kontrollpunkte (0.22, 0.25, 0.00, 1.00)
 * aus one-ui/motion/basic. Beschleunigt kurz und bremst lang aus — das ist
 * der Grund, warum sich One UI zugleich flink und ruhig anfühlt.
 */
val OneUiEasing = CubicBezierEasing(0.22f, 0.25f, 0.00f, 1.00f)

/**
 * Kurze Bewegung: Ein- und Ausblenden. „at least 100 ms, which is the minimum
 * recognizable length" (one-ui/motion/basic).
 */
const val MotionShort = 250

/**
 * Bewegung mit Ortswechsel — Screenwechsel, Aufklappen. Bleibt unter der
 * dokumentierten Grenze: „should never exceed 500 ms to avoid interfering
 * with subsequent tasks" (one-ui/motion/basic).
 */
const val MotionMedium = 400

/** Air above a section header (sesl_list_subheader_padding_top). */
val SectionHeaderTop = 13.dp

/** Air below a section header, before its card. */
val SectionHeaderBottom = 5.dp

/*
 * Divider insets are measured from the card's edge, and the card already
 * sits at ScreenGutter. One UI insets its dividers slightly rather than
 * aligning them to the text, so both values stay small.
 */

/** Divider inset for rows with a leading 36dp icon (14 + 36 + 14). */
val IconRowDividerInset = 64.dp

/** Divider inset for a plain or radio row: 14 from the card, 24 from the screen. */
val RadioRowDividerInset = 14.dp

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
        ) {
            // Hier — und nur hier — sind die Fenster-Insets die des App-Fensters.
            // Dialoge und Sheets bekommen sie von hier gereicht (siehe
            // ProvideAppInsets), weil ihr eigenes Fenster sie nicht verlässlich
            // meldet.
            ProvideAppInsets(content)
        }
    }
}

/**
 * Status/diff colors. Reads the value the theme published, so it follows
 * an explicitly forced theme instead of only the system setting.
 */
@Composable
fun semantic(): Semantic = LocalSemantic.current
