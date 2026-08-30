package com.pocketagent.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pocketagent.app.ui.theme.ContentInset
import com.pocketagent.app.ui.theme.ScreenGutter

/**
 * Liste und Detail nebeneinander — die eigentliche Antwort auf ein
 * aufgeklapptes Foldable oder ein Tablet.
 *
 * One UI dazu: „Stretched-out apps are harder to read and waste the extra
 * space of the large screen. Use a multi-pane layout to show more information
 * at once." Genau das war der Zustand vorher: dieselbe eine Spalte, nur
 * breiter gezogen.
 *
 * Die Auswahl liegt nicht im Navigationsstack. Das ist Absicht: in zwei
 * Spalten *ersetzt* das Öffnen einer Session nichts, es füllt nur die rechte
 * Seite. Ein Push würde die Liste verdrängen, die weiterhin sichtbar ist —
 * und die Rückwärtstaste müsste etwas rückgängig machen, das nie passiert
 * ist.
 *
 * Gehalten wird sie eine Ebene höher, im NavHost. Nur von dort aus lässt sich
 * dieselbe offene Session über einen Faltvorgang hinweg mal als Spalte und
 * mal als eigener Screen zeigen — und ein Deep Link in der Spalte statt im
 * Vollbild landen.
 */
@Composable
fun SessionListDetail(
    listFraction: Float,
    selectedId: String?,
    onSelect: (String?) -> Unit,
    onNewSession: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenDiff: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Zurück schließt erst das Detail, bevor es die App verlässt. Nur wenn
    // wirklich etwas ausgewählt ist — sonst schluckt der Handler die Taste.
    BackHandler(enabled = selectedId != null) { onSelect(null) }

    Row(modifier = modifier.fillMaxSize()) {
        Box(modifier = Modifier.fillMaxHeight().weight(listFraction)) {
            SessionListScreen(
                onNewSession = onNewSession,
                onOpenSession = { id -> onSelect(id) },
                onOpenSettings = onOpenSettings,
            )
        }
        VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Box(modifier = Modifier.fillMaxHeight().weight(1f - listFraction)) {
            if (selectedId == null) {
                NoSessionSelected()
            } else {
                SessionScreen(
                    // Ein einziges Session-VM, das bei jedem Auswahlwechsel auf
                    // die neue Id umbindet (SessionScreen.bind) — kein VM pro je
                    // geöffneter Session mehr (Fund: ViewModel-Leak). Der Verlauf
                    // der vorigen Session wird beim Umbinden zurückgesetzt.
                    sessionId = selectedId,
                    onBack = { onSelect(null) },
                    onOpenDiff = onOpenDiff,
                )
            }
        }
    }
}

/** Was in der rechten Spalte steht, solange nichts gewählt ist. */
@Composable
private fun NoSessionSelected() {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = ContentInset),
    ) {
        Icon(
            Icons.Outlined.SmartToy,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(40.dp).height(40.dp).alpha(0.5f),
        )
        Spacer(modifier = Modifier.height(ScreenGutter))
        Text(
            text = "Wähle links eine Session",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
