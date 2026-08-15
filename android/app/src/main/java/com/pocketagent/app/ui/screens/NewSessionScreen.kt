@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package com.pocketagent.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AdapterDescriptor
import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.semantic
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class NewSessionViewModel : ViewModel() {
    lateinit var repository: AppRepository

    data class UiState(
        val repoId: String? = null,
        val adapter: String = "",
        val provider: String = "",
        val providerCustom: Boolean = false,
        val model: String = "",
        val mode: AgentMode = AgentMode.AUTO,
        val branch: String = "",
        val networkPolicy: String = "allowlist",
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
            _state.value = s.copy(adapter = first.id, provider = defaultProviderFor(first))
        }
    }

    fun onAdapterSelected(adapter: AdapterDescriptor) {
        _state.value = _state.value.copy(
            adapter = adapter.id,
            provider = defaultProviderFor(adapter),
            providerCustom = false,
        )
    }

    private fun defaultProviderFor(adapter: AdapterDescriptor): String =
        adapter.defaults.provider.ifBlank { adapter.providerEnv.keys.firstOrNull().orEmpty() }

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
                networkPolicy = s.networkPolicy,
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

/* ------------------------------------------------------------------ */
/* Provider display names                                              */
/* ------------------------------------------------------------------ */

private fun providerDisplayName(key: String): String = when (key) {
    "openai" -> "OpenAI"
    "anthropic" -> "Anthropic"
    "zai" -> "Z.AI"
    "moonshot" -> "Moonshot/Kimi"
    "kimi" -> "Kimi"
    "google" -> "Google Gemini"
    "groq" -> "Groq"
    "openrouter" -> "OpenRouter"
    "xai" -> "xAI"
    else -> key
}

/** Provider keys in display order: default provider first, then the rest. */
private fun orderedProviderKeys(descriptor: AdapterDescriptor): List<String> {
    val keys = descriptor.providerEnv.keys.toList()
    val def = descriptor.defaults.provider
    return if (def.isNotBlank() && def in keys) {
        listOf(def) + keys.filterNot { it == def }
    } else {
        keys
    }
}

/** True when a usable secret for this adapter exists (card-level status). */
private fun adapterKeyPresent(descriptor: AdapterDescriptor, secretKinds: Set<String>): Boolean = when {
    descriptor.credentials.isNotEmpty() -> descriptor.credentials.keys.any { it in secretKinds }
    descriptor.providerEnv.isNotEmpty() -> descriptor.providerEnv.keys.any { it in secretKinds }
    else -> true
}

@Composable
fun NewSessionScreen(
    onCreated: (String) -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: NewSessionViewModel = viewModel { NewSessionViewModel().also { it.repository = repository } }
    val state by vm.state.collectAsState()
    val repos by repository.repos.collectAsState()
    val adapters by repository.adapters.collectAsState()
    val secrets by repository.secrets.collectAsState()

    var showAddRepo by remember { mutableStateOf(false) }
    var advanced by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        repository.refreshRepos()
        repository.refreshSessions()
        repository.refreshAdapters()
        repository.loadSecrets()
    }
    LaunchedEffect(adapters) { vm.syncAdapterDefaults(adapters) }
    LaunchedEffect(state.createdSessionId) { state.createdSessionId?.let { onCreated(it) } }
    LaunchedEffect(repos) {
        if (repos.isNotEmpty() && state.repoId == null && repos.none { it.id == state.repoId }) {
            vm.update { it.copy(repoId = repos.first().id) }
        }
    }

    val secretKinds = remember(secrets) { secrets.map { it.kind }.toSet() }
    val selectedDescriptor = adapters.firstOrNull { it.id == state.adapter }

    OneUiScaffold(title = "Neue Session", onBack = onBack) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            /* -------- Repository -------- */
            SectionHeader("Repository")
            RepoSelector(
                repos = repos.map { it.id to it.fullName },
                selectedId = state.repoId,
                onSelect = { id -> vm.update { it.copy(repoId = id) } },
                onAddRepo = { showAddRepo = true },
            )

            /* -------- Agent -------- */
            SectionHeader("Agent")
            if (adapters.isEmpty()) {
                GroupCard {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(16.dp),
                    ) {
                        CircularProgressIndicator(
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(18.dp),
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
                adapters.forEach { descriptor ->
                    AdapterCard(
                        descriptor = descriptor,
                        selected = state.adapter == descriptor.id,
                        keyPresent = adapterKeyPresent(descriptor, secretKinds),
                        onClick = { vm.onAdapterSelected(descriptor) },
                    )
                }
                selectedDescriptor?.let { selected ->
                    if (!selected.capabilities.approvals && state.mode != AgentMode.YOLO) {
                        Text(
                            text = "${selected.name} unterstützt keine Remote-Approvals – Ask/AcceptEdits laufen ohne Nachfragen durch.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.tertiary,
                            modifier = Modifier.padding(horizontal = 28.dp),
                        )
                    }
                }
            }

            /* -------- Provider -------- */
            if (selectedDescriptor != null && selectedDescriptor.providerEnv.isNotEmpty()) {
                SectionHeader("Provider")
                GroupCard {
                    Column(
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            orderedProviderKeys(selectedDescriptor).forEach { key ->
                                ProviderChip(
                                    label = providerDisplayName(key),
                                    selected = !state.providerCustom && state.provider == key,
                                    keyPresent = key in secretKinds,
                                    onClick = { vm.update { it.copy(provider = key, providerCustom = false) } },
                                )
                            }
                            FilterChip(
                                selected = state.providerCustom,
                                onClick = { vm.update { it.copy(providerCustom = true) } },
                                shape = PillShape,
                                label = { Text("Anderer Provider …") },
                            )
                        }
                        AnimatedVisibility(visible = state.providerCustom) {
                            OutlinedTextField(
                                value = state.provider,
                                onValueChange = { v -> vm.update { it.copy(provider = v) } },
                                label = { Text("Provider") },
                                placeholder = { Text("z. B. deepseek") },
                                singleLine = true,
                                shape = MaterialTheme.shapes.small,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
            }

            /* -------- Key-Warnung -------- */
            selectedDescriptor?.let { descriptor ->
                val missingFor: String? = if (descriptor.credentials.isNotEmpty()) {
                    if (descriptor.credentials.keys.none { it in secretKinds }) descriptor.name else null
                } else {
                    val p = state.provider.trim()
                    if (p.isNotEmpty() && p !in secretKinds) providerDisplayName(p) else null
                }
                if (missingFor != null) {
                    Surface(
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.tertiaryContainer,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp),
                    ) {
                        Column(modifier = Modifier.padding(start = 20.dp, end = 12.dp, top = 14.dp, bottom = 4.dp)) {
                            Text(
                                text = "Für $missingFor ist noch kein Key hinterlegt.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onTertiaryContainer,
                            )
                            TextButton(onClick = onOpenSettings) {
                                Text("Zu den Einstellungen")
                            }
                        }
                    }
                }
            }

            /* -------- Autonomie -------- */
            SectionHeader("Autonomie")
            GroupCard {
                Column {
                    ModeTile(
                        title = "Ask",
                        subtitle = "Jede Aktion wird vor der Ausführung bestätigt",
                        selected = state.mode == AgentMode.ASK,
                        onClick = { vm.update { it.copy(mode = AgentMode.ASK) } },
                    )
                    TileDivider()
                    ModeTile(
                        title = "Accept Edits",
                        subtitle = "Datei-Änderungen laufen automatisch, alles andere wird gefragt",
                        selected = state.mode == AgentMode.ACCEPT_EDITS,
                        onClick = { vm.update { it.copy(mode = AgentMode.ACCEPT_EDITS) } },
                    )
                    TileDivider()
                    ModeTile(
                        title = "Auto",
                        subtitle = "Agent entscheidet selbst, Push nur manuell",
                        selected = state.mode == AgentMode.AUTO,
                        onClick = { vm.update { it.copy(mode = AgentMode.AUTO) } },
                    )
                    TileDivider()
                    ModeTile(
                        title = "Yolo",
                        subtitle = "Vollautomatisch inkl. Push und Draft-PR – ohne Nachfrage",
                        warning = true,
                        selected = state.mode == AgentMode.YOLO,
                        onClick = { vm.update { it.copy(mode = AgentMode.YOLO) } },
                    )
                }
            }

            /* -------- Netzwerk -------- */
            SectionHeader("Netzwerk")
            GroupCard {
                Column {
                    ModeTile(
                        title = "Allowlist",
                        subtitle = "Nur GitHub, KI-Anbieter & Paket-Registries (empfohlen)",
                        selected = state.networkPolicy == "allowlist",
                        onClick = { vm.update { it.copy(networkPolicy = "allowlist") } },
                    )
                    TileDivider()
                    ModeTile(
                        title = "Isoliert",
                        subtitle = "Kein Internetzugriff – nur für lokale Aufgaben",
                        selected = state.networkPolicy == "isolated",
                        onClick = { vm.update { it.copy(networkPolicy = "isolated") } },
                    )
                    TileDivider()
                    ModeTile(
                        title = "Offen",
                        subtitle = "Vollständiger Netzwerkzugriff (wie lokal)",
                        selected = state.networkPolicy == "open",
                        onClick = { vm.update { it.copy(networkPolicy = "open") } },
                    )
                }
            }
            Text(
                text = "Standard ist Allowlist – der Agent kommt nur an whitelistede Domains.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 28.dp),
            )

            /* -------- Erweitert -------- */
            Spacer(modifier = Modifier.height(8.dp))
            GroupCard {
                Column {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { advanced = !advanced }
                            .padding(start = 20.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
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
                    AnimatedVisibility(visible = advanced) {
                        Column(
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                            modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
                        ) {
                            OutlinedTextField(
                                value = state.model,
                                onValueChange = { v -> vm.update { it.copy(model = v) } },
                                label = { Text("Modell") },
                                placeholder = { Text("Default") },
                                singleLine = true,
                                shape = MaterialTheme.shapes.small,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            OutlinedTextField(
                                value = state.branch,
                                onValueChange = { v -> vm.update { it.copy(branch = v) } },
                                label = { Text("Basis-Branch (optional)") },
                                placeholder = { Text("Default-Branch des Repos") },
                                singleLine = true,
                                shape = MaterialTheme.shapes.small,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
            }

            state.error?.let {
                Text(
                    text = it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 28.dp),
                )
            }

            /* -------- Start -------- */
            Spacer(modifier = Modifier.height(8.dp))
            Button(
                onClick = { vm.create() },
                enabled = !state.busy && state.repoId != null,
                shape = PillShape,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp)
                    .height(52.dp),
            ) {
                if (state.busy) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                }
                Text(if (state.busy) "Session startet …" else "Session starten")
            }
            Spacer(modifier = Modifier.height(20.dp))
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
/* Agent cards                                                         */
/* ------------------------------------------------------------------ */

@Composable
private fun AdapterCard(
    descriptor: AdapterDescriptor,
    selected: Boolean,
    keyPresent: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = if (selected) {
            MaterialTheme.colorScheme.secondaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceContainer
        },
        border = if (selected) {
            BorderStroke(2.dp, MaterialTheme.colorScheme.primary)
        } else {
            null
        },
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .clickable(onClick = onClick),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = descriptor.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                KeyStatusBadge(keyPresent = keyPresent)
            }
            descriptor.description?.takeIf { it.isNotBlank() }?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            val caps = descriptor.capabilities
            if (caps.approvals || caps.resume || caps.streaming) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (caps.approvals) CapabilityChip("Rückfragen")
                    if (caps.resume) CapabilityChip("Fortsetzen")
                    if (caps.streaming) CapabilityChip("Streaming")
                }
            }
        }
    }
}

@Composable
private fun CapabilityChip(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, PillShape)
            .padding(horizontal = 9.dp, vertical = 3.dp),
    )
}

@Composable
private fun KeyStatusBadge(keyPresent: Boolean) {
    val s = semantic()
    val color = if (keyPresent) s.success else s.warning
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .background(color, CircleShape),
        )
        Spacer(modifier = Modifier.width(5.dp))
        Text(
            text = if (keyPresent) "Zugang hinterlegt" else "Key fehlt",
            style = MaterialTheme.typography.labelSmall,
            color = color,
        )
    }
}

/* ------------------------------------------------------------------ */
/* Provider chips                                                      */
/* ------------------------------------------------------------------ */

@Composable
private fun ProviderChip(
    label: String,
    selected: Boolean,
    keyPresent: Boolean,
    onClick: () -> Unit,
) {
    val s = semantic()
    FilterChip(
        selected = selected,
        onClick = onClick,
        shape = PillShape,
        label = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .background(if (keyPresent) s.success else s.warning, CircleShape),
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(label)
            }
        },
    )
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
            .padding(horizontal = 12.dp)
            .clickable { expanded = true },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 18.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
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
                    shape = MaterialTheme.shapes.small,
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
                    shape = MaterialTheme.shapes.small,
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
/* Mode tiles (grouped list rows, One UI settings style)               */
/* ------------------------------------------------------------------ */

@Composable
private fun TileDivider() {
    HorizontalDivider(
        color = MaterialTheme.colorScheme.outlineVariant,
        modifier = Modifier.padding(start = 56.dp, end = 16.dp),
    )
}

@Composable
private fun ModeTile(
    title: String,
    subtitle: String,
    warning: Boolean = false,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(start = 4.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
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
