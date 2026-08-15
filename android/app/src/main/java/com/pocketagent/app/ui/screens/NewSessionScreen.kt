@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package com.pocketagent.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AdapterDescriptor
import com.pocketagent.app.data.AgentMode
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.RepoInfo
import com.pocketagent.app.ui.theme.CardInset
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.PrimaryButtonHeight
import com.pocketagent.app.ui.theme.RadioRowDividerInset
import com.pocketagent.app.ui.theme.ScreenGutter
import com.pocketagent.app.ui.theme.SectionSpacing
import com.pocketagent.app.ui.theme.TileMinHeight
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

/**
 * Anzeigenamen kommen aus dem Adapter-Manifest (`providers`). Die Tabelle
 * hier greift nur noch bei Adaptern ohne dieses Feld (ältere Server) und bei
 * frei eingetippten Providern.
 */
private fun fallbackProviderName(key: String): String = when (key) {
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

private fun providerDisplayName(key: String, descriptor: AdapterDescriptor?): String =
    descriptor?.providers?.firstOrNull { it.id == key }?.name ?: fallbackProviderName(key)

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

    OneUiScaffold(
        title = "Neue Session",
        onBack = onBack,
        bottomBar = {
            // The commit action stays in the thumb zone instead of hiding
            // at the end of a long scroll.
            Surface(color = MaterialTheme.colorScheme.background, tonalElevation = 0.dp) {
                Column(modifier = Modifier.navigationBarsPadding()) {
                    state.error?.let { SectionError(it) }
                    Button(
                        onClick = { vm.create() },
                        enabled = !state.busy && state.repoId != null,
                        shape = PillShape,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = ScreenGutter, vertical = 10.dp)
                            .height(PrimaryButtonHeight),
                    ) {
                        if (state.busy) {
                            CircularProgressIndicator(
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                        }
                        Text(if (state.busy) "Session startet …" else "Session starten")
                    }
                }
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            /* -------- Repository -------- */
            SectionHeader("Repository")
            RepoSelector(
                repos = repos,
                selectedId = state.repoId,
                onSelect = { id -> vm.update { it.copy(repoId = id) } },
                onAddRepo = { showAddRepo = true },
            )

            /* -------- Agent -------- */
            SectionHeader("Agent")
            GroupCard {
                Column {
                    if (adapters.isEmpty()) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .heightIn(min = TileMinHeight)
                                .padding(horizontal = CardInset),
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
                    adapters.forEachIndexed { index, descriptor ->
                        if (index > 0) ListDivider(RadioRowDividerInset)
                        AgentTile(
                            descriptor = descriptor,
                            selected = state.adapter == descriptor.id,
                            keyMissing = !adapterKeyPresent(descriptor, secretKinds),
                            onClick = { vm.onAdapterSelected(descriptor) },
                        )
                    }
                }
            }
            selectedDescriptor?.let { selected ->
                if (!selected.capabilities.approvals && state.mode != AgentMode.YOLO) {
                    SectionNote(
                        "${selected.name} kann nicht remote nachfragen – Ask und Accept Edits " +
                            "laufen bei diesem Agenten ohne Rückfragen durch.",
                    )
                }
            }

            /* -------- Provider -------- */
            if (selectedDescriptor != null && selectedDescriptor.providerEnv.isNotEmpty()) {
                SectionHeader("Provider")
                GroupCard {
                    Column(
                        modifier = Modifier.padding(horizontal = CardInset, vertical = 14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            orderedProviderKeys(selectedDescriptor).forEach { key ->
                                ProviderChip(
                                    label = providerDisplayName(key, selectedDescriptor),
                                    selected = !state.providerCustom && state.provider == key,
                                    keyMissing = key !in secretKinds,
                                    onClick = { vm.update { it.copy(provider = key, providerCustom = false) } },
                                )
                            }
                            FilterChip(
                                selected = state.providerCustom,
                                onClick = { vm.update { it.copy(providerCustom = true) } },
                                shape = PillShape,
                                label = { Text("Anderer …") },
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
                                keyboardOptions = KeyboardOptions(
                                    autoCorrectEnabled = false,
                                    keyboardType = KeyboardType.Ascii,
                                    imeAction = ImeAction.Done,
                                ),
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
                    if (p.isNotEmpty() && p !in secretKinds) providerDisplayName(p, descriptor) else null
                }
                if (missingFor != null) {
                    Spacer(modifier = Modifier.height(SectionSpacing))
                    NoticeCard(
                        text = "Für $missingFor ist noch kein Zugang hinterlegt – die Session " +
                            "startet, der Agent kann aber nicht arbeiten.",
                        actionLabel = "Zugang hinterlegen",
                        onAction = onOpenSettings,
                    )
                }
            }

            /* -------- Autonomie -------- */
            SectionHeader("Autonomie")
            GroupCard {
                Column {
                    SelectableTile(
                        title = "Ask",
                        subtitle = "Jede Aktion wird vorher bestätigt",
                        selected = state.mode == AgentMode.ASK,
                        onClick = { vm.update { it.copy(mode = AgentMode.ASK) } },
                    )
                    ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = "Accept Edits",
                        subtitle = "Datei-Änderungen laufen durch, alles andere wird gefragt",
                        selected = state.mode == AgentMode.ACCEPT_EDITS,
                        onClick = { vm.update { it.copy(mode = AgentMode.ACCEPT_EDITS) } },
                    )
                    ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = "Auto",
                        subtitle = "Agent entscheidet selbst, Push nur manuell",
                        selected = state.mode == AgentMode.AUTO,
                        onClick = { vm.update { it.copy(mode = AgentMode.AUTO) } },
                    )
                    ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = "Yolo",
                        subtitle = "Vollautomatisch inklusive Push und Draft-PR",
                        selected = state.mode == AgentMode.YOLO,
                        titleColor = if (state.mode == AgentMode.YOLO) {
                            MaterialTheme.colorScheme.error
                        } else {
                            Color.Unspecified
                        },
                        onClick = { vm.update { it.copy(mode = AgentMode.YOLO) } },
                    )
                }
            }

            /* -------- Netzwerk -------- */
            SectionHeader("Netzwerk")
            GroupCard {
                Column {
                    SelectableTile(
                        title = "Allowlist",
                        subtitle = "Nur GitHub, KI-Anbieter und Paket-Registries (empfohlen)",
                        selected = state.networkPolicy == "allowlist",
                        onClick = { vm.update { it.copy(networkPolicy = "allowlist") } },
                    )
                    ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = "Isoliert",
                        subtitle = "Kein Internetzugriff – nur für lokale Aufgaben",
                        selected = state.networkPolicy == "isolated",
                        onClick = { vm.update { it.copy(networkPolicy = "isolated") } },
                    )
                    ListDivider(RadioRowDividerInset)
                    SelectableTile(
                        title = "Offen",
                        subtitle = "Vollständiger Netzwerkzugriff wie lokal",
                        selected = state.networkPolicy == "open",
                        onClick = { vm.update { it.copy(networkPolicy = "open") } },
                    )
                }
            }

            /* -------- Erweitert -------- */
            Spacer(modifier = Modifier.height(SectionSpacing))
            GroupCard {
                Column {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { advanced = !advanced }
                            .heightIn(min = TileMinHeight)
                            .padding(horizontal = CardInset),
                    ) {
                        Text(
                            text = "Erweitert",
                            style = MaterialTheme.typography.titleSmall,
                            modifier = Modifier.weight(1f),
                        )
                        Icon(
                            if (advanced) Icons.Outlined.UnfoldLess else Icons.Outlined.UnfoldMore,
                            contentDescription = if (advanced) "Erweitert einklappen" else "Erweitert ausklappen",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    AnimatedVisibility(visible = advanced) {
                        Column(
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                            modifier = Modifier.padding(
                                start = CardInset,
                                end = CardInset,
                                bottom = CardInset,
                            ),
                        ) {
                            OutlinedTextField(
                                value = state.model,
                                onValueChange = { v -> vm.update { it.copy(model = v) } },
                                label = { Text("Modell") },
                                placeholder = { Text(selectedDescriptor?.defaults?.model ?: "Standard des Agenten") },
                                singleLine = true,
                                shape = MaterialTheme.shapes.small,
                                keyboardOptions = KeyboardOptions(
                                    autoCorrectEnabled = false,
                                    keyboardType = KeyboardType.Ascii,
                                    imeAction = ImeAction.Next,
                                ),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            OutlinedTextField(
                                value = state.branch,
                                onValueChange = { v -> vm.update { it.copy(branch = v) } },
                                label = { Text("Basis-Branch") },
                                placeholder = { Text("Default-Branch des Repos") },
                                singleLine = true,
                                shape = MaterialTheme.shapes.small,
                                keyboardOptions = KeyboardOptions(
                                    autoCorrectEnabled = false,
                                    keyboardType = KeyboardType.Ascii,
                                    imeAction = ImeAction.Done,
                                ),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
            }
            Spacer(modifier = Modifier.height(SectionSpacing))
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
/* Agent list                                                          */
/* ------------------------------------------------------------------ */

/**
 * An agent is picked the same way an autonomy mode is picked: a radio row
 * in a grouped card. Capabilities ride along as neutral chips; only a
 * *missing* key is called out, because only that needs acting on.
 */
@Composable
private fun AgentTile(
    descriptor: AdapterDescriptor,
    selected: Boolean,
    keyMissing: Boolean,
    onClick: () -> Unit,
) {
    val caps = descriptor.capabilities
    SelectableTile(
        title = descriptor.name,
        subtitle = descriptor.description?.takeIf { it.isNotBlank() },
        selected = selected,
        onClick = onClick,
        trailing = if (keyMissing) {
            { DotLabel(color = semantic().warning, label = "Kein Zugang") }
        } else {
            null
        },
        extra = if (caps.approvals || caps.resume || caps.streaming) {
            {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (caps.approvals) InfoChip("Rückfragen")
                    if (caps.resume) InfoChip("Fortsetzen")
                    if (caps.streaming) InfoChip("Streaming")
                }
            }
        } else {
            null
        },
    )
}

/* ------------------------------------------------------------------ */
/* Provider chips                                                      */
/* ------------------------------------------------------------------ */

@Composable
private fun ProviderChip(
    label: String,
    selected: Boolean,
    keyMissing: Boolean,
    onClick: () -> Unit,
) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        shape = PillShape,
        label = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // Silence is "fine". Only a missing key gets a marker.
                if (keyMissing) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .background(semantic().warning, CircleShape),
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                }
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
    repos: List<RepoInfo>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    onAddRepo: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = repos.firstOrNull { it.id == selectedId }

    Box {
        GroupCard {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = true }
                    .heightIn(min = TileMinHeight)
                    .padding(start = CardInset, end = 10.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = selected?.fullName ?: "Repository wählen",
                        style = MaterialTheme.typography.titleSmall,
                        color = if (selected == null) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    selected?.let {
                        Text(
                            text = "Basis: ${it.defaultBranch}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
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
                    text = { Text("Noch keine Repositories") },
                    enabled = false,
                    onClick = {},
                )
            }
            repos.forEach { repo ->
                DropdownMenuItem(
                    text = { Text(repo.fullName) },
                    onClick = { onSelect(repo.id); expanded = false },
                )
            }
            DropdownMenuItem(
                text = { Text("Repository hinzufügen", color = MaterialTheme.colorScheme.primary) },
                leadingIcon = {
                    Icon(
                        Icons.Filled.Add,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                },
                onClick = { expanded = false; onAddRepo() },
            )
        }
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
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                        imeAction = ImeAction.Next,
                    ),
                    supportingText = if (fullName.isNotBlank() && !valid) {
                        { Text("Format: owner/repo") }
                    } else {
                        null
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = branch,
                    onValueChange = { branch = it },
                    label = { Text("Basis-Branch") },
                    placeholder = { Text("main") },
                    singleLine = true,
                    shape = MaterialTheme.shapes.small,
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                        imeAction = ImeAction.Done,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Private Repos brauchen zusätzlich einen GitHub-Zugang in den Einstellungen.",
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

