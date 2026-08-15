@file:OptIn(ExperimentalMaterial3Api::class)

package com.pocketagent.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AppRepository
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

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            repository.tokenStore.clear()
            onDone()
        }
    }
}

private val SECRET_KINDS = listOf("openai", "zai", "moonshot", "anthropic", "github", "claude_oauth", "junie")

@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: SettingsViewModel = viewModel { SettingsViewModel().also { it.repository = repository } }
    val stats by repository.stats.collectAsState()
    val secrets by repository.secrets.collectAsState()
    val error by vm.error.collectAsState()

    var showAddDialog by remember { mutableStateOf(false) }
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
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Server-Status", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    val s = stats
                    if (s == null) {
                        Text("Keine Statistik verfügbar", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        StatRow("Aktive Sessions", s.sessionsActive.toString())
                        StatRow("Sessions total", s.sessionsTotal.toString())
                        StatRow("Container läuft", s.containersRunning.toString())
                        StatRow("Uptime", formatUptime(s.uptimeSec))
                        if (s.versions.isNotEmpty()) {
                            Text(
                                text = s.versions.entries.joinToString("\n") { "${it.key}: ${it.value}" },
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                        }
                    }
                    TextButton(onClick = { vm.refresh() }) { Text("Aktualisieren") }
                }
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = "Secrets",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { showAddDialog = true }) {
                    Icon(Icons.Filled.Add, contentDescription = "Secret hinzufügen")
                }
            }
            if (secrets.isEmpty()) {
                Text("Keine Secrets hinterlegt.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                secrets.forEach { secret ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(secret.kind, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    text = "angelegt: ${relativeTime(secret.createdAt)}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            IconButton(onClick = { vm.deleteSecret(secret.id) }) {
                                Icon(Icons.Filled.Delete, contentDescription = "Löschen")
                            }
                        }
                    }
                }
            }

            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }

            Button(
                onClick = { confirmLogout = true },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Abmelden (Token löschen)")
            }
        }
    }

    if (showAddDialog) {
        AddSecretDialog(
            onDismiss = { showAddDialog = false },
            onSave = { kind, value ->
                vm.addSecret(kind, value) { showAddDialog = false }
            },
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

private fun formatUptime(sec: Long): String {
    val h = sec / 3600
    val m = (sec % 3600) / 60
    return if (h > 0) "$h h $m min" else "$m min"
}

@Composable
private fun StatRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
    }
}

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
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { kindDropdown = true }) { Text(kind) }
                    DropdownMenu(expanded = kindDropdown, onDismissRequest = { kindDropdown = false }) {
                        SECRET_KINDS.forEach { k ->
                            DropdownMenuItem(text = { Text(k) }, onClick = { kind = k; kindDropdown = false })
                        }
                        DropdownMenuItem(text = { Text("custom …") }, onClick = { kind = "custom"; kindDropdown = false })
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
