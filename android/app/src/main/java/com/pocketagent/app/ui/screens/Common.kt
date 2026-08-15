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
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pocketagent.app.data.SessionStatus
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
/* Status                                                             */
/* ------------------------------------------------------------------ */

@Composable
fun statusColor(status: SessionStatus): Color {
    val s = semantic()
    return when (status) {
        SessionStatus.RUNNING -> s.success
        SessionStatus.IDLE -> MaterialTheme.colorScheme.onSurfaceVariant
        SessionStatus.CREATING -> s.warning
        SessionStatus.STOPPED -> MaterialTheme.colorScheme.outline
        SessionStatus.ERROR -> MaterialTheme.colorScheme.error
    }
}

fun statusLabel(status: SessionStatus): String = when (status) {
    SessionStatus.CREATING -> "Startet"
    SessionStatus.RUNNING -> "Aktiv"
    SessionStatus.IDLE -> "Bereit"
    SessionStatus.STOPPED -> "Gestoppt"
    SessionStatus.ERROR -> "Fehler"
}

/** Quiet pill: small dot + label. Pulse signals live activity. */
@Composable
fun StatusBadge(status: SessionStatus, modifier: Modifier = Modifier, pulse: Boolean = false) {
    val color = statusColor(status)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .background(color.copy(alpha = 0.13f), RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        PulsingDot(color = color, pulse = pulse, size = 6.dp)
        Spacer(modifier = Modifier.width(5.dp))
        Text(
            text = statusLabel(status),
            color = color,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
fun PulsingDot(color: Color, pulse: Boolean, size: androidx.compose.ui.unit.Dp = 8.dp) {
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

/** One UI grouped-list container: white/dark card, 26dp rounds. */
@Composable
fun GroupCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp),
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
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
        modifier = modifier.padding(start = 28.dp, end = 28.dp, top = 20.dp, bottom = 8.dp),
    )
}

@Composable
fun InfoChip(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp))
            .padding(horizontal = 7.dp, vertical = 3.dp),
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
        modifier = modifier
            .background(bg)
            .padding(horizontal = 8.dp, vertical = 0.5.dp)
            .fillMaxWidth(),
    )
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

/** Column that stacks vertically within a composable scope. */
@Composable
fun LabeledColumn(label: String, content: @Composable () -> Unit) {
    Column {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        content()
    }
}
