package com.pocketagent.app.ui.screens

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.pocketagent.app.data.SessionStatus
import com.pocketagent.app.data.WsClient
import com.pocketagent.app.ui.theme.ContentInset
import com.pocketagent.app.ui.theme.IconRowDividerInset
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.ScreenGutter
import com.pocketagent.app.ui.theme.TileMinHeight
import com.pocketagent.app.ui.theme.semantic
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

@Composable
fun RequestNotificationPermission() {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) {
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

/* ------------------------------------------------------------------ */
/* Status — one dot primitive, three presentations                     */
/* ------------------------------------------------------------------ */

@Composable
fun statusColor(status: SessionStatus): Color {
    val s = semantic()
    return when (status) {
        SessionStatus.RUNNING -> s.success
        SessionStatus.CREATING -> s.warning
        SessionStatus.ERROR -> MaterialTheme.colorScheme.error
        // Idle and stopped are both "nothing is happening" — one quiet grey.
        SessionStatus.IDLE, SessionStatus.STOPPED -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}

fun statusLabel(status: SessionStatus): String = when (status) {
    SessionStatus.CREATING -> "Startet"
    SessionStatus.RUNNING -> "Aktiv"
    SessionStatus.IDLE -> "Bereit"
    SessionStatus.STOPPED -> "Gestoppt"
    SessionStatus.ERROR -> "Fehler"
}

/** True while the session is doing something — the only case that earns motion. */
fun SessionStatus.isLive(): Boolean =
    this == SessionStatus.RUNNING || this == SessionStatus.CREATING

@Composable
fun PulsingDot(color: Color, pulse: Boolean, size: Dp = 8.dp) {
    if (!pulse) {
        Box(modifier = Modifier.size(size).background(color, CircleShape))
        return
    }
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.25f,
        animationSpec = infiniteRepeatable(tween(850), RepeatMode.Reverse),
        label = "pulseAlpha",
    )
    Box(modifier = Modifier.size(size).alpha(alpha).background(color, CircleShape))
}

/**
 * Dot + label in the dot's own color. The single source of truth for
 * every status readout in the app — badge, connection line, key hint.
 */
@Composable
fun DotLabel(
    color: Color,
    label: String,
    modifier: Modifier = Modifier,
    pulse: Boolean = false,
    tinted: Boolean = false,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = if (tinted) {
            modifier
                .background(color.copy(alpha = 0.13f), PillShape)
                .padding(horizontal = 8.dp, vertical = 3.dp)
        } else {
            modifier
        },
    ) {
        PulsingDot(color = color, pulse = pulse, size = 6.dp)
        Spacer(modifier = Modifier.width(6.dp))
        Text(
            text = label,
            color = color,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

/** Tinted pill for list rows. */
@Composable
fun StatusBadge(status: SessionStatus, modifier: Modifier = Modifier) {
    DotLabel(
        color = statusColor(status),
        label = statusLabel(status),
        modifier = modifier,
        pulse = status.isLive(),
        tinted = true,
    )
}

/**
 * Untinted one-liner for app-bar subtitles: colored dot, then the status
 * and any facts worth carrying, separated by middots.
 */
@Composable
fun StatusLine(status: SessionStatus, details: List<String>, modifier: Modifier = Modifier) {
    val text = (listOf(statusLabel(status)) + details.filter { it.isNotBlank() }).joinToString(" · ")
    Row(verticalAlignment = Alignment.CenterVertically, modifier = modifier) {
        PulsingDot(color = statusColor(status), pulse = status.isLive(), size = 6.dp)
        Spacer(modifier = Modifier.width(6.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/* ------------------------------------------------------------------ */
/* Verbindung                                                          */
/* ------------------------------------------------------------------ */

/**
 * Was die Verbindungszeile sagt — als reine Funktion, damit der Text
 * überall derselbe ist. null heißt: alles in Ordnung, nichts anzeigen.
 *
 * Die Zustände sind bewusst ehrlich. Es gibt kein „gescheitert“, solange
 * die App weiterprobiert; wartet sie, steht die Restzeit dabei.
 */
fun connectionLabel(state: WsClient.ConnState): String? = when (state) {
    is WsClient.ConnState.Connected -> null
    is WsClient.ConnState.Connecting -> "Verbinde mit dem Server …"
    is WsClient.ConnState.Waiting -> "Keine Verbindung – neuer Versuch in ${state.retryInSec}s"
    is WsClient.ConnState.Disconnected -> "Getrennt – ${state.reason}"
    WsClient.ConnState.Idle -> "Nicht verbunden"
}

/**
 * Eine ruhige Zeile über dem Inhalt, wenn die Verbindung nicht steht.
 * Solange gerade verbunden wird, ist sie nur Information; wartet die App
 * oder ist sie getrennt, holt ein Tap den Versuch nach vorn.
 */
@Composable
fun ConnectionLine(
    state: WsClient.ConnState,
    onReconnect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val label = connectionLabel(state) ?: return
    val connecting = state is WsClient.ConnState.Connecting
    val severe = state is WsClient.ConnState.Disconnected
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
        modifier = modifier
            .fillMaxWidth()
            .then(if (connecting) Modifier else Modifier.clickable(onClick = onReconnect))
            .heightIn(min = 36.dp)
            .padding(horizontal = ScreenGutter, vertical = 4.dp),
    ) {
        DotLabel(
            color = if (severe) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            label = label,
            pulse = connecting,
        )
        if (!connecting) {
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = "Jetzt verbinden",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

/* ------------------------------------------------------------------ */
/* One UI scaffold: collapsing large title, centered when expanded     */
/* ------------------------------------------------------------------ */

/**
 * Samsung One UI style screen scaffold: tall app bar with the title
 * centered in the expanded area, collapsing into a compact bar on
 * scroll. All screens share this so the app reads as one system.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OneUiScaffold(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    floatingActionButton: @Composable () -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        containerColor = MaterialTheme.colorScheme.background,
        floatingActionButton = floatingActionButton,
        bottomBar = bottomBar,
        topBar = {
            LargeTopAppBar(
                title = {
                    val collapsed = scrollBehavior.state.collapsedFraction > 0.5f
                    Box(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = title,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier
                                .align(if (collapsed) Alignment.CenterStart else Alignment.Center)
                                .padding(end = if (collapsed) 12.dp else 0.dp),
                        )
                    }
                },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück")
                        }
                    }
                },
                actions = actions,
                colors = TopAppBarDefaults.largeTopAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                    scrolledContainerColor = MaterialTheme.colorScheme.background,
                ),
                scrollBehavior = scrollBehavior,
            )
        },
        content = content,
    )
}

/* ------------------------------------------------------------------ */
/* Grouped list containers (One UI settings style)                     */
/* ------------------------------------------------------------------ */

/** One UI grouped-list container: white/dark card on the screen gutter. */
@Composable
fun GroupCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = ScreenGutter),
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        tonalElevation = 0.dp,
    ) { content() }
}

/**
 * Free-standing card that lines up with [GroupCard] — same gutter, same
 * shape, same fill. Anything that is not a grouped list uses this so no
 * two cards on a screen have different optical widths.
 */
@Composable
fun ScreenCard(
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.surfaceContainer,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = ScreenGutter),
        shape = MaterialTheme.shapes.large,
        color = color,
        tonalElevation = 0.dp,
    ) { content() }
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(start = ContentInset, end = ContentInset, top = 20.dp, bottom = 8.dp),
    )
}

/** Quiet footnote under a section — same optical inset as its header. */
@Composable
fun SectionNote(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(start = ContentInset, end = ContentInset, top = 8.dp),
    )
}

/** Inline error under a section — same inset, error color. */
@Composable
fun SectionError(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
        modifier = modifier.padding(start = ContentInset, end = ContentInset, top = 8.dp),
    )
}

/** Hairline between rows of a grouped list, inset to line up with the text. */
@Composable
fun ListDivider(startInset: Dp = IconRowDividerInset) {
    HorizontalDivider(
        color = MaterialTheme.colorScheme.outlineVariant,
        modifier = Modifier.padding(start = startInset),
    )
}

/**
 * The one warning surface in the app: something is missing or will behave
 * unexpectedly. Semantic warning colors, never the accent.
 */
@Composable
fun NoticeCard(
    text: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val s = semantic()
    ScreenCard(color = s.warningContainer) {
        Column(
            modifier = Modifier.padding(
                start = 18.dp,
                end = 18.dp,
                top = 14.dp,
                bottom = if (actionLabel != null) 8.dp else 14.dp,
            ),
        ) {
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium,
                color = s.warning,
            )
            if (actionLabel != null && onAction != null) {
                TextButton(
                    onClick = onAction,
                    shape = PillShape,
                    modifier = Modifier.padding(top = 4.dp).heightIn(min = 44.dp),
                ) {
                    Text(actionLabel, color = s.warning, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

/**
 * A single-select row of a grouped list: radio, title, subtitle, and an
 * optional trailing badge or trailing block of chips. Every "pick one of
 * these" list in the app is built from this, so agents, autonomy modes
 * and network policies all read identically.
 */
@Composable
fun SelectableTile(
    title: String,
    subtitle: String?,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    titleColor: Color = Color.Unspecified,
    trailing: (@Composable () -> Unit)? = null,
    extra: (@Composable () -> Unit)? = null,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .selectable(selected = selected, onClick = onClick, role = Role.RadioButton)
            .heightIn(min = TileMinHeight)
            .padding(start = 4.dp, end = 16.dp),
    ) {
        RadioButton(selected = selected, onClick = null)
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = 4.dp, top = 10.dp, bottom = 10.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                color = if (titleColor == Color.Unspecified) MaterialTheme.colorScheme.onSurface else titleColor,
            )
            if (!subtitle.isNullOrBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            extra?.let {
                Spacer(modifier = Modifier.height(6.dp))
                it()
            }
        }
        trailing?.let {
            Spacer(modifier = Modifier.width(10.dp))
            it()
        }
    }
}

/** Small neutral fact chip. Grey, never colored — status has its own dot. */
@Composable
fun InfoChip(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, PillShape)
            .padding(horizontal = 9.dp, vertical = 3.dp),
    )
}

/* ------------------------------------------------------------------ */
/* Time                                                               */
/* ------------------------------------------------------------------ */

fun parseInstant(raw: String): Instant? = try {
    Instant.parse(raw)
} catch (_: Exception) {
    try {
        OffsetDateTime.parse(raw, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
    } catch (_: Exception) {
        null
    }
}

fun relativeTime(raw: String?, now: Instant = Instant.now()): String {
    val instant = raw?.let { parseInstant(it) } ?: return "–"
    val dur = Duration.between(instant, now)
    val minutes = dur.toMinutes()
    return when {
        minutes < 1 -> "jetzt"
        minutes < 60 -> "${minutes} Min."
        minutes < 60 * 24 -> "${dur.toHours()} Std."
        else -> "${dur.toDays()} Tg."
    }
}

/* ------------------------------------------------------------------ */
/* Diff                                                               */
/* ------------------------------------------------------------------ */

@Composable
fun DiffLine(
    line: String,
    style: TextStyle,
    showBackground: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val s = semantic()
    val (fg, bg) = when {
        line.startsWith("+") -> s.added to if (showBackground) s.addedBg else Color.Transparent
        line.startsWith("-") -> s.removed to if (showBackground) s.removedBg else Color.Transparent
        line.startsWith("@@") -> MaterialTheme.colorScheme.primary to Color.Transparent
        else -> MaterialTheme.colorScheme.onSurface to Color.Transparent
    }
    Text(
        text = line.ifEmpty { " " },
        style = style,
        color = fg,
        maxLines = 1,
        softWrap = false,
        modifier = modifier
            .fillMaxWidth()
            .background(bg)
            .padding(horizontal = 8.dp, vertical = 0.5.dp),
    )
}

/**
 * Diff body: lines never wrap, the block scrolls sideways instead, and
 * the +/- tint spans the widest line so the stripes stay rectangular.
 */
@Composable
fun DiffBody(lines: List<String>, style: TextStyle, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .horizontalScroll(rememberScrollState())
            .width(IntrinsicSize.Max),
    ) {
        lines.forEach { line -> DiffLine(line = line, style = style) }
    }
}

@Composable
fun DiffStat(added: Int, removed: Int, modifier: Modifier = Modifier) {
    val s = semantic()
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        Text("+$added", color = s.added, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.width(8.dp))
        Text("−$removed", color = s.removed, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
    }
}
