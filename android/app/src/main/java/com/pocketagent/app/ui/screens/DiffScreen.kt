@file:OptIn(ExperimentalMaterial3Api::class)

package com.pocketagent.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.DiffEntry
import com.pocketagent.app.ui.theme.CardInset
import com.pocketagent.app.ui.theme.MonoMedium
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.PrimaryButtonHeight
import com.pocketagent.app.ui.theme.ScreenGutter
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class DiffViewModel : ViewModel() {
    lateinit var repository: AppRepository
    var sessionId: String = ""

    data class UiState(
        val loading: Boolean = true,
        val entries: List<DiffEntry> = emptyList(),
        val error: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    fun bind(id: String, repo: AppRepository) {
        if (sessionId == id) return
        sessionId = id
        repository = repo
        load()
    }

    fun load() {
        _state.value = _state.value.copy(loading = true, error = null)
        viewModelScope.launch {
            repository.loadDiff(sessionId).fold(
                onSuccess = { entries -> _state.value = UiState(loading = false, entries = entries) },
                onFailure = { t -> _state.value = UiState(loading = false, error = t.message) },
            )
        }
    }
}

@Composable
fun DiffScreen(
    sessionId: String,
    onBack: () -> Unit,
) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: DiffViewModel = viewModel(key = "diff-$sessionId") {
        DiffViewModel().also { it.bind(sessionId, repository) }
    }
    val state by vm.state.collectAsState()

    OneUiScaffold(
        title = "Änderungen",
        onBack = onBack,
        actions = {
            IconButton(onClick = { vm.load() }) {
                Icon(Icons.Outlined.Refresh, contentDescription = "Aktualisieren")
            }
        },
    ) { padding ->
        when {
            state.loading -> Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }

            state.error != null -> Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 40.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = "Änderungen konnten nicht geladen werden",
                    style = MaterialTheme.typography.titleMedium,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = state.error ?: "Unbekannter Fehler",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 6.dp),
                )
                Button(
                    onClick = { vm.load() },
                    shape = PillShape,
                    modifier = Modifier
                        .padding(top = 20.dp)
                        .height(PrimaryButtonHeight),
                ) {
                    Text("Erneut versuchen")
                }
            }

            state.entries.isEmpty() -> Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 40.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = "Keine Änderungen",
                    style = MaterialTheme.typography.titleMedium,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = "Der Agent hat im Working Tree bisher nichts verändert.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }

            else -> LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(
                    start = ScreenGutter,
                    end = ScreenGutter,
                    top = 0.dp,
                    bottom = 24.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item(key = "__summary__") {
                    val totals = state.entries
                        .filter { it.binary != true }
                        .fold(0 to 0) { acc, entry ->
                            val (a, r) = diffStats(entry.patch)
                            (acc.first + a) to (acc.second + r)
                        }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = CardInset, end = CardInset, top = 12.dp, bottom = 2.dp),
                    ) {
                        Text(
                            text = if (state.entries.size == 1) "1 Datei" else "${state.entries.size} Dateien",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.weight(1f),
                        )
                        DiffStat(added = totals.first, removed = totals.second)
                    }
                }
                items(state.entries, key = { it.path }) { entry ->
                    DiffEntryCard(entry)
                }
            }
        }
    }
}

private fun diffStats(patch: String): Pair<Int, Int> {
    var added = 0
    var removed = 0
    patch.lines().forEach { line ->
        when {
            line.startsWith("+") && !line.startsWith("+++") -> added++
            line.startsWith("-") && !line.startsWith("---") -> removed++
        }
    }
    return added to removed
}

@Composable
private fun DiffEntryCard(entry: DiffEntry) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(vertical = 12.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = CardInset),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = entry.path.substringAfterLast('/'),
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    // Only the folder — repeating the filename earns nothing.
                    entry.path.substringBeforeLast('/', "")
                        .takeIf { it.isNotEmpty() }
                        ?.let { dir ->
                            Text(
                                text = dir,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                }
                if (entry.binary != true) {
                    val (added, removed) = diffStats(entry.patch)
                    Spacer(modifier = Modifier.width(10.dp))
                    DiffStat(added = added, removed = removed)
                }
            }
            if (entry.binary == true) {
                Text(
                    text = "Binäre Datei – kein Textdiff verfügbar",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = CardInset, vertical = 8.dp),
                )
            } else {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerHighest,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 8.dp)
                        .padding(top = 10.dp),
                ) {
                    DiffBody(
                        lines = entry.patch.lines(),
                        style = MonoMedium,
                        modifier = Modifier.padding(vertical = 6.dp),
                    )
                }
            }
        }
    }
}
