@file:OptIn(ExperimentalMaterial3Api::class)

package com.pocketagent.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.RepoInfo
import com.pocketagent.app.data.SecretInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class SettingsViewModel : ViewModel() {
    lateinit var repository: AppRepository

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    fun refresh() {
        viewModelScope.launch {
            repository.refreshStats()
            repository.loadSecrets()
            repository.refreshSessions()
            repository.refreshRepos()
        }
    }

    fun addSecret(kind: String, value: String, onDone: () -> Unit) {
        viewModelScope.launch {
            repository.addSecret(kind, value).fold(
                onSuccess = { _error.value = null },
                onFailure = { _error.value = it.message },
            )
            onDone()
        }
    }

    fun deleteSecret(id: String) {
        viewModelScope.launch { repository.deleteSecret(id) }
    }

    fun addRepo(fullName: String, defaultBranch: String, onDone: () -> Unit) {
        viewModelScope.launch {
            repository.addRepo(fullName, defaultBranch).fold(
                onSuccess = { _error.value = null },
                onFailure = { _error.value = it.message },
            )
            onDone()
        }
    }

    fun setBiometric(enabled: Boolean) {
        viewModelScope.launch { repository.tokenStore.setBiometricEnabled(enabled) }
    }

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            repository.tokenStore.clear()
            onDone()
        }
    }
}

private val SECRET_KINDS = listOf("github", "zai", "openai", "moonshot", "anthropic", "claude_oauth", "junie", "kilo")

@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: SettingsViewModel = viewModel { SettingsViewModel().also { it.repository = repository } }
    val stats by repository.stats.collectAsState()
    val secrets by repository.secrets.collectAsState()
    val repos by repository.repos.collectAsState()
    val biometric by repository.tokenStore.biometricEnabled.collectAsState(initial = false)
    val error by vm.error.collectAsState()

    var showAddSecret by remember { mutableStateOf(false) }
    var showAddRepo by remember { mutableStateOf(false) }
    var confirmLogout by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.refresh() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Einstellungen") },
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
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            /* ---------- Server ---------- */
            SectionHeader("Server")
            GroupCard {
                Column(Modifier.padding(vertical = 8.dp)) {
                    val s = stats
                    SettingsRow(label = "Status", value = if (s != null) "verbunden" else "–")
                    HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                    SettingsRow(label = "Aktive Sessions", value = s?.sessionsActive?.toString() ?: "…")
                    HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                    SettingsRow(label = "Laufende Container", value = s?.containersRunning?.toString() ?: "…")
                    HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                    SettingsRow(label = "Uptime", value = s?.let { formatUptime(it.uptimeSec) } ?: "…")
                }
            }

            /* ---------- Sicherheit ---------- */
            SectionHeader("Sicherheit")
            GroupCard {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                ) {
                    SettingsIcon(Icons.Outlined.Fingerprint)
                    Column(modifier = Modifier.weight(1f)) {
                        Text("App-Sperre", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            text = "Biometrie oder Gerätesperre beim Start",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = biometric, onCheckedChange = { vm.setBiometric(it) })
                }
            }

            /* ---------- Repositories ---------- */
            SectionHeader("Repositories")
            GroupCard {
                Column(Modifier.padding(vertical = 8.dp)) {
                    if (repos.isEmpty()) {
                        Text(
                            text = "Noch keine Repos hinzugefügt",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                    repos.forEachIndexed { index, repo ->
                        if (index > 0) HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        ) {
                            SettingsIcon(Icons.Outlined.Folder)
                            Column(modifier = Modifier.weight(1f)) {
                                Text(repo.fullName, style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    text = "Basis: ${repo.defaultBranch}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                    AddRow(label = "Repository hinzufügen", onClick = { showAddRepo = true })
                }
            }

            /* ---------- Secrets ---------- */
            SectionHeader("Secrets")
            GroupCard {
                Column(Modifier.padding(vertical = 8.dp)) {
                    if (secrets.isEmpty()) {
                        Text(
                            text = "Keine Secrets – für private Repos und Provider nötig",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                    secrets.forEachIndexed { index, secret ->
                        if (index > 0) HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                        SwipeToDismissRow(onDismiss = { vm.deleteSecret(secret.id) }) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 10.dp),
                            ) {
                                SettingsIcon(Icons.Outlined.Key)
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(secret.kind, style = MaterialTheme.typography.bodyLarge)
                                    Text(
                                        text = "hinterlegt ${relativeTime(secret.createdAt)}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                    HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                    AddRow(label = "Secret hinzufügen", onClick = { showAddSecret = true })
                }
            }

            error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 28.dp, vertical = 8.dp),
                )
            }

            /* ---------- Abmelden ---------- */
            SectionHeader("Gerät")
            GroupCard {
                Box(Modifier.padding(vertical = 4.dp)) {
                    TextButton(
                        onClick = { confirmLogout = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            "Von diesem Gerät abmelden",
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(vertical = 6.dp),
                        )
                    }
                }
            }
        }
    }

    if (showAddSecret) {
        AddSecretDialog(
            onDismiss = { showAddSecret = false },
            onSave = { kind, value -> vm.addSecret(kind, value) { showAddSecret = false } },
        )
    }
    if (showAddRepo) {
        AddRepoDialog(
            onDismiss = { showAddRepo = false },
            onSave = { fullName, branch -> vm.addRepo(fullName, branch) { showAddRepo = false } },
        )
    }
    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Abmelden?") },
            text = { Text("Device-Token und Server-URL werden von diesem Gerät gelöscht.") },
            confirmButton = {
                TextButton(onClick = { confirmLogout = false; onBack(); vm.logout {} }) { Text("Abmelden") }
            },
            dismissButton = {
                TextButton(onClick = { confirmLogout = false }) { Text("Abbrechen") }
            },
        )
    }
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

@Composable
private fun SettingsIcon(icon: ImageVector) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .background(MaterialTheme.colorScheme.secondaryContainer, MaterialTheme.shapes.small),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSecondaryContainer,
            modifier = Modifier.size(19.dp),
        )
    }
    Spacer(modifier = Modifier.width(16.dp))
}

@Composable
private fun SettingsRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 11.dp),
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun AddRow(label: String, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 13.dp),
    ) {
        Icon(
            Icons.Filled.Add,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(20.dp),
        )
        Spacer(modifier = Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun SwipeToDismissRow(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) {
                onDismiss()
                true
            } else {
                false
            }
        },
    )
    SwipeToDismissBox(
        state = state,
        enableDismissFromStartToEnd = false,
        backgroundContent = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 6.dp)
                    .background(MaterialTheme.colorScheme.errorContainer, MaterialTheme.shapes.large),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Icon(
                    Icons.Outlined.Delete,
                    contentDescription = "Löschen",
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.padding(end = 24.dp),
                )
            }
        },
        content = { content() },
    )
}

private fun formatUptime(sec: Long): String {
    val h = sec / 3600
    val m = (sec % 3600) / 60
    return if (h > 0) "$h h $m min" else "$m min"
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

@Composable
private fun AddSecretDialog(
    onDismiss: () -> Unit,
    onSave: (kind: String, value: String) -> Unit,
) {
    var kind by remember { mutableStateOf(SECRET_KINDS.first()) }
    var customKind by remember { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    var kindDropdown by remember { mutableStateOf(false) }

    val effectiveKind = if (kind == "custom") customKind.trim() else kind

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Secret hinzufügen") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Art", style = MaterialTheme.typography.labelSmall)
                Surface(
                    shape = MaterialTheme.shapes.small,
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Box {
                        TextButton(onClick = { kindDropdown = true }) { Text(kind) }
                        DropdownMenuKind(
                            expanded = kindDropdown,
                            onDismiss = { kindDropdown = false },
                            current = kind,
                            onSelect = { kind = it; kindDropdown = false },
                        )
                    }
                }
                if (kind == "custom") {
                    OutlinedTextField(
                        value = customKind,
                        onValueChange = { customKind = it },
                        label = { Text("Eigene Art") },
                        singleLine = true,
                    )
                }
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    label = { Text("Wert") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSave(effectiveKind, value) },
                enabled = effectiveKind.isNotBlank() && value.isNotBlank(),
            ) { Text("Speichern") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Abbrechen") }
        },
    )
}

@Composable
private fun DropdownMenuKind(
    expanded: Boolean,
    onDismiss: () -> Unit,
    current: String,
    onSelect: (String) -> Unit,
) {
    androidx.compose.material3.DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        SECRET_KINDS.forEach { k ->
            androidx.compose.material3.DropdownMenuItem(
                text = { Text(k, fontWeight = if (k == current) FontWeight.SemiBold else FontWeight.Normal) },
                onClick = { onSelect(k) },
            )
        }
        androidx.compose.material3.DropdownMenuItem(
            text = { Text("custom …") },
            onClick = { onSelect("custom") },
        )
    }
}
