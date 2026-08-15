package com.pocketagent.app.ui.screens

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pocketagent.app.data.SessionStatus
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

fun statusColor(status: SessionStatus): Color = when (status) {
    SessionStatus.RUNNING -> Color(0xFF22C55E)
    SessionStatus.IDLE -> Color(0xFF3B82F6)
    SessionStatus.CREATING -> Color(0xFFF59E0B)
    SessionStatus.STOPPED -> Color(0xFF8B5CF6)
    SessionStatus.ERROR -> Color(0xFFEF4444)
}

fun statusLabel(status: SessionStatus): String = when (status) {
    SessionStatus.CREATING -> "erstellt"
    SessionStatus.RUNNING -> "läuft"
    SessionStatus.IDLE -> "idle"
    SessionStatus.STOPPED -> "gestoppt"
    SessionStatus.ERROR -> "Fehler"
}

@Composable
fun StatusBadge(status: SessionStatus, modifier: Modifier = Modifier) {
    val color = statusColor(status)
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        color = color.copy(alpha = 0.16f),
    ) {
        Text(
            text = statusLabel(status),
            color = color,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp),
        )
    }
}

@Composable
fun InfoChip(text: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}

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
        minutes < 1 -> "gerade eben"
        minutes < 60 -> "vor $minutes Min."
        minutes < 60 * 24 -> "vor ${dur.toHours()} Std."
        else -> "vor ${dur.toDays()} Tg."
    }
}

@Composable
fun DiffColoredLine(line: String, monospace: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier) {
    val color = when {
        line.startsWith("+") -> Color(0xFF22C55E)
        line.startsWith("-") -> Color(0xFFEF4444)
        else -> MaterialTheme.colorScheme.onSurface
    }
    Text(
        text = line,
        style = monospace,
        color = color,
        modifier = modifier.padding(end = 8.dp),
    )
}
