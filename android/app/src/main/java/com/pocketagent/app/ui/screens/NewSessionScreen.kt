@file:OptIn(ExperimentalMaterial3Api::class)

package com.pocketagent.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.UnfoldLess
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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

    fun addRepo(fullName: String, defaultBranch: String) {
        viewModelScope.launch {
            repository.addRepo(fullName, defaultBranch).fold(
                onSuccess = { repo ->
                    _state.value = _state.value.copy(repoId = repo.id, error = null)
                },
                onFailure = { t -> _state.value = _state.value.copy(error = t.message) },
            )
        }
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

    var showAddRepo by remember { mutableStateOf(false) }
    var advanced by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { repository.refreshRepos(); repository.refreshSessions(); repository.refreshAdapters() }
    LaunchedEffect(adapters) { vm.syncAdapterDefaults(adapters) }
    LaunchedEffect(state.createdSessionId) { state.createdSessionId?.let { onCreated(it) } }
    LaunchedEffect(repos) {
        if (repos.isNotEmpty() && state.repoId == null && repos.none { it.id == state.repoId }) {
            vm.update { it.copy(repoId = repos.first().id) }
        }
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
            /* -------- Repository -------- */
            SectionHeader("Repository", modifier = Modifier.padding(0.dp))
            RepoSelector(
                repos = repos.map { it.id to it.fullName },
                selectedId = state.repoId,
                onSelect = { id -> vm.update { it.copy(repoId = id) } },
                onAddRepo = { showAddRepo = true },
            )

            /* -------- Adapter -------- */
            SectionHeader("Agent", modifier = Modifier.padding(0.dp))
            val adapterList = adapters
            if (adapterList.isEmpty()) {
                Surface(
                    shape = MaterialTheme.shapes.large,
                    color = MaterialTheme.colorScheme.surfaceContainer,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(16.dp),
                    ) {
                        CircularProgressIndicator(
                            strokeWidth = 2.dp,
                            modifier = Modifier.width(18.dp),
                        )
                        Text(
                            text = "Lade verfügbare Agenten …",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 12.dp),
                        )
                    }
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
                adapterList.firstOrNull { it.id == state.adapter }?.let { selected ->
                    selected.description?.takeIf { it.isNotBlank() }?.let {
                        Text(
                            text = it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (!selected.capabilities.approvals && state.mode != AgentMode.YOLO) {
                        Text(
                            text = "${selected.name} unterstützt keine Remote-Approvals – Ask/AcceptEdits laufen ohne Nachfragen durch.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.tertiary,
                        )
                    }
                }
            }

            /* -------- Modus -------- */
            SectionHeader("Autonomie", modifier = Modifier.padding(0.dp))
            ModeTile(
                title = "Ask",
                subtitle = "Jede Aktion wird vor der Ausführung bestätigt",
                selected = state.mode == AgentMode.ASK,
                onClick = { vm.update { it.copy(mode = AgentMode.ASK) } },
            )
            ModeTile(
                title = "Accept Edits",
                subtitle = "Datei-Änderungen laufen automatisch, alles andere wird gefragt",
                selected = state.mode == AgentMode.ACCEPT_EDITS,
                onClick = { vm.update { it.copy(mode = AgentMode.ACCEPT_EDITS) } },
            )
            ModeTile(
                title = "Auto",
                subtitle = "Agent entscheidet selbst, Push nur manuell",
                selected = state.mode == AgentMode.AUTO,
                onClick = { vm.update { it.copy(mode = AgentMode.AUTO) } },
            )
            ModeTile(
                title = "Yolo",
                subtitle = "Vollautomatisch inkl. Push und Draft-PR – ohne Nachfrage",
                warning = true,
                selected = state.mode == AgentMode.YOLO,
                onClick = { vm.update { it.copy(mode = AgentMode.YOLO) } },
            )

            /* -------- Erweitert -------- */
            Surface(
                shape = MaterialTheme.shapes.large,
                color = MaterialTheme.colorScheme.surfaceContainer,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { advanced = !advanced },
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
                ) {
                    Text(
                        text = "Erweitert",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = { advanced = !advanced }) {
                        Icon(
                            if (advanced) Icons.Outlined.UnfoldLess else Icons.Outlined.UnfoldMore,
                            contentDescription = null,
                        )
                    }
                }
            }
            AnimatedVisibility(visible = advanced) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
                    OutlinedTextField(
                        value = state.branch,
                        onValueChange = { v -> vm.update { it.copy(branch = v) } },
                        label = { Text("Basis-Branch (optional)") },
                        placeholder = { Text("Default-Branch des Repos") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            state.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Button(
                onClick = { vm.create() },
                enabled = !state.busy && state.repoId != null,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.busy) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.width(18.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                }
                Text(if (state.busy) "Session startet …" else "Session starten")
            }
        }
    }

    if (showAddRepo) {
        AddRepoDialog(
            onDismiss = { showAddRepo = false },
            onSave = { fullName, branch ->
                vm.addRepo(fullName, branch)
                showAddRepo = false
            },
        )
    }
}

/* ------------------------------------------------------------------ */
/* Repos                                                               */
/* ------------------------------------------------------------------ */

@Composable
private fun RepoSelector(
    repos: List<Pair<String, String>>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    onAddRepo: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = repos.firstOrNull { it.first == selectedId }?.second

    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = true },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Repository",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = selectedLabel ?: "Wähle ein Repository …",
                    style = MaterialTheme.typography.titleSmall,
                )
            }
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        if (repos.isEmpty()) {
            DropdownMenuItem(
                text = { Text("Noch keine Repos") },
                enabled = false,
                onClick = {},
            )
        }
        repos.forEach { (id, label) ->
            DropdownMenuItem(text = { Text(label) }, onClick = { onSelect(id); expanded = false })
        }
        DropdownMenuItem(
            text = { Text("Repository hinzufügen …", color = MaterialTheme.colorScheme.primary) },
            leadingIcon = { Icon(Icons.Filled.Add, contentDescription = null) },
            onClick = { expanded = false; onAddRepo() },
        )
    }
}

/** Shared add-repository dialog. */
@Composable
fun AddRepoDialog(
    onDismiss: () -> Unit,
    onSave: (fullName: String, defaultBranch: String) -> Unit,
) {
    var fullName by remember { mutableStateOf("") }
    var branch by remember { mutableStateOf("") }
    val valid = Regex("^[\\w.-]+/[\\w.-]+$").matches(fullName.trim())
    val effectiveBranch = branch.trim().ifEmpty { "main" }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Repository hinzufügen") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = fullName,
                    onValueChange = { fullName = it },
                    label = { Text("owner/repo") },
                    placeholder = { Text("robinrehbein/remote-control") },
                    singleLine = true,
                    isError = fullName.isNotBlank() && !valid,
                    supportingText = if (fullName.isNotBlank() && !valid) {
                        { Text("Format: owner/repo") }
                    } else {
                        null
                    },
                )
                OutlinedTextField(
                    value = branch,
                    onValueChange = { branch = it },
                    label = { Text("Basis-Branch (optional)") },
                    placeholder = { Text("main") },
                    singleLine = true,
                )
                Text(
                    "Für private Repos zusätzlich ein github-Secret in den Einstellungen hinterlegen.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(fullName.trim(), effectiveBranch) }, enabled = valid) {
                Text("Hinzufügen")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}

/* ------------------------------------------------------------------ */
/* Mode tiles                                                          */
/* ------------------------------------------------------------------ */

@Composable
private fun ModeTile(
    title: String,
    subtitle: String,
    warning: Boolean = false,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = if (selected) {
            MaterialTheme.colorScheme.secondaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceContainer
        },
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 4.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
        ) {
            RadioButton(selected = selected, onClick = onClick)
            Column(modifier = Modifier.padding(start = 4.dp, top = 10.dp, bottom = 10.dp)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleSmall,
                    color = if (warning && selected) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
