@file:OptIn(ExperimentalMaterial3Api::class)

package com.pocketagent.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AdapterDescriptor
import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.AppRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class NewSessionViewModel : ViewModel() {
    lateinit var repository: AppRepository

    data class UiState(
        val repoId: String? = null,
        val adapter: String = "",
        val provider: String = "",
        val model: String = "",
        val mode: AgentMode = AgentMode.AUTO,
        val branch: String = "",
        val busy: Boolean = false,
        val error: String? = null,
        val createdSessionId: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    fun update(transform: (UiState) -> UiState) {
        _state.value = transform(_state.value)
    }

    fun syncAdapterDefaults(adapters: List<AdapterDescriptor>) {
        val s = _state.value
        if (s.adapter.isBlank() && adapters.isNotEmpty()) {
            val first = adapters.first()
            _state.value = s.copy(adapter = first.id, provider = first.defaults.provider)
        }
    }

    fun onAdapterSelected(adapter: AdapterDescriptor) {
        _state.value = _state.value.copy(
            adapter = adapter.id,
            provider = adapter.defaults.provider.ifBlank { "openai" },
        )
    }

    fun create() {
        val s = _state.value
        if (s.busy) return
        val repoId = s.repoId ?: run {
            _state.value = s.copy(error = "Bitte ein Repository wählen")
            return
        }
        _state.value = s.copy(busy = true, error = null)
        viewModelScope.launch {
            val result = repository.createSession(
                repoId = repoId,
                adapter = s.adapter,
                provider = s.provider.trim(),
                model = s.model.trim(),
                mode = s.mode,
                branch = s.branch.trim().ifBlank { null },
            )
            result.fold(
                onSuccess = {
                    // find fresh session for this repo+adapter (created by server)
                    val created = repository.sessions.value.firstOrNull { sess ->
                        sess.repoId == repoId && sess.adapter == s.adapter
                    }
                    _state.value = _state.value.copy(busy = false, createdSessionId = created?.id)
                },
                onFailure = { t ->
                    _state.value = _state.value.copy(busy = false, error = t.message ?: "Fehler")
                },
            )
        }
    }
}

@Composable
fun NewSessionScreen(
    onCreated: (String) -> Unit,
    onBack: () -> Unit,
) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: NewSessionViewModel = viewModel { NewSessionViewModel().also { it.repository = repository } }
    val state by vm.state.collectAsState()
    val repos by repository.repos.collectAsState()
    val adapters by repository.adapters.collectAsState()

    LaunchedEffect(Unit) { repository.refreshRepos(); repository.refreshSessions(); repository.refreshAdapters() }
    LaunchedEffect(adapters) { vm.syncAdapterDefaults(adapters) }
    LaunchedEffect(state.createdSessionId) {
        state.createdSessionId?.let { onCreated(it) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Neue Session") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SectionLabel("Repository")
            RepoDropdown(
                repos = repos.map { it.id to it.fullName },
                selectedId = state.repoId,
                onSelect = { id -> vm.update { it.copy(repoId = id) } },
            )

            SectionLabel("Adapter")
            val adapterList = adapters
            if (adapterList.isEmpty()) {
                OutlinedButton(onClick = { }, enabled = false, modifier = Modifier.fillMaxWidth()) {
                    Text("Lade Adapter…")
                }
            } else {
                SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                    adapterList.forEachIndexed { index, descriptor ->
                        SegmentedButton(
                            selected = state.adapter == descriptor.id,
                            onClick = { vm.onAdapterSelected(descriptor) },
                            shape = SegmentedButtonDefaults.itemShape(index = index, count = adapterList.size),
                        ) {
                            Text(descriptor.id)
                        }
                    }
                }
                adapterList.firstOrNull { it.id == state.adapter }?.description?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                val selected = adapterList.firstOrNull { it.id == state.adapter }
                if (selected != null && !selected.capabilities.approvals && state.mode != AgentMode.YOLO) {
                    Text(
                        text = "${selected.name}: keine Remote-Approvals – Ask/AcceptEdits laufen ohne Gates",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedTextField(
                    value = state.provider,
                    onValueChange = { v -> vm.update { it.copy(provider = v) } },
                    label = { Text("Provider") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    value = state.model,
                    onValueChange = { v -> vm.update { it.copy(model = v) } },
                    label = { Text("Modell") },
                    placeholder = { Text("Default") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
            }

            SectionLabel("Modus")
            ModeCard(
                title = "Yolo",
                subtitle = "Vollautomatisch: Auto-Push + Draft-PR nach jedem Turn. Vorsicht!",
                warning = true,
                selected = state.mode == AgentMode.YOLO,
                onClick = { vm.update { it.copy(mode = AgentMode.YOLO) } },
            )
            ModeCard(
                title = "Auto",
                subtitle = "Agent entscheidet selbst, Push manuell per Button.",
                selected = state.mode == AgentMode.AUTO,
                onClick = { vm.update { it.copy(mode = AgentMode.AUTO) } },
            )
            ModeCard(
                title = "Accept Edits",
                subtitle = "Datei-Änderungen werden automatisch akzeptiert.",
                selected = state.mode == AgentMode.ACCEPT_EDITS,
                onClick = { vm.update { it.copy(mode = AgentMode.ACCEPT_EDITS) } },
            )
            ModeCard(
                title = "Ask",
                subtitle = "Jede Aktion muss bestätigt werden.",
                selected = state.mode == AgentMode.ASK,
                onClick = { vm.update { it.copy(mode = AgentMode.ASK) } },
            )

            OutlinedTextField(
                value = state.branch,
                onValueChange = { v -> vm.update { it.copy(branch = v) } },
                label = { Text("Basis-Branch (optional)") },
                placeholder = { Text("Default-Branch des Repos") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            state.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Button(
                onClick = { vm.create() },
                enabled = !state.busy && state.repoId != null,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.busy) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.padding(end = 8.dp))
                }
                Text("Session erstellen")
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
private fun RepoDropdown(
    repos: List<Pair<String, String>>,
    selectedId: String?,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = repos.firstOrNull { it.first == selectedId }?.second

    OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
        Text(selectedLabel ?: "Repository wählen…")
    }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        if (repos.isEmpty()) {
            DropdownMenuItem(text = { Text("Keine Repos – in Settings hinzufügen") }, onClick = { expanded = false })
        }
        repos.forEach { (id, label) ->
            DropdownMenuItem(
                text = { Text(label) },
                onClick = {
                    onSelect(id)
                    expanded = false
                },
            )
        }
    }
}

@Composable
private fun ModeCard(
    title: String,
    subtitle: String,
    warning: Boolean = false,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Card(
        onClick = onClick,
        colors = if (selected) {
            CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
        } else {
            CardDefaults.cardColors()
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 4.dp, end = 14.dp, top = 4.dp, bottom = 4.dp),
        ) {
            RadioButton(selected = selected, onClick = onClick)
            Column(modifier = Modifier.padding(start = 4.dp, top = 8.dp, bottom = 8.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (warning) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}
