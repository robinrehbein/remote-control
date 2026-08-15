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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AdapterDescriptor
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.SecretInfo
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.semantic
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
            repository.refreshAdapters()
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

/* ------------------------------------------------------------------ */
/* Secret catalog: kind -> display metadata                            */
/* ------------------------------------------------------------------ */

private data class SecretMeta(
    val kind: String,
    val displayName: String,
    val description: String,
    val multiline: Boolean = false,
)

private val SECRET_CATALOG = listOf(
    SecretMeta("github", "GitHub", "Personal Access Token mit repo-Scope — für private Repos, Push & PRs"),
    SecretMeta("claude_oauth", "Claude Abo (Setup-Token)", "Auf dem Laptop `claude setup-token` ausführen und Token einfügen (Pro/Max, ~1 Jahr gültig)"),
    SecretMeta("anthropic", "Anthropic API", "API-Key von console.anthropic.com (sk-ant-…)"),
    SecretMeta("openai", "OpenAI", "API-Key von platform.openai.com (sk-…)"),
    SecretMeta("zai", "Z.AI", "API-Key aus dem Z.AI-Dashboard"),
    SecretMeta("moonshot", "Moonshot/Kimi", "API-Key von platform.moonshot.ai"),
    SecretMeta("kimi", "Kimi", "API-Key von platform.moonshot.ai"),
    SecretMeta("google", "Google Gemini", "API-Key aus Google AI Studio"),
    SecretMeta("groq", "Groq", "API-Key von console.groq.com"),
    SecretMeta("openrouter", "OpenRouter", "API-Key von openrouter.ai (sk-or-…)"),
    SecretMeta("xai", "xAI", "API-Key von console.x.ai"),
    SecretMeta("junie", "JetBrains Junie", "Junie API-Key (usage-based)"),
    SecretMeta("kilo", "Kilo Gateway", "Kompletter Inhalt der Gateway-auth.json einfügen", multiline = true),
)

/** Soft format hints per kind — warn, never block. */
private val KIND_PREFIXES = mapOf(
    "github" to listOf("ghp_", "github_pat_"),
    "anthropic" to listOf("sk-ant-"),
    "openai" to listOf("sk-"),
    "openrouter" to listOf("sk-or-"),
)

/** Static catalog + fallback entries for kinds only known from adapter descriptors. */
private fun buildCatalog(adapters: List<AdapterDescriptor>): List<SecretMeta> {
    val known = SECRET_CATALOG.map { it.kind }.toSet()
    val dynamic = adapters
        .flatMap { it.credentials.keys + it.providerEnv.keys }
        .distinct()
        .filter { it !in known }
        .sorted()
        .map { SecretMeta(it, it, "Wird von einem installierten Adapter genutzt") }
    return SECRET_CATALOG + dynamic
}

private fun metaFor(kind: String, catalog: List<SecretMeta>): SecretMeta =
    catalog.firstOrNull { it.kind == kind } ?: SecretMeta(kind, kind, "")

/** Adapter ids that consume a secret kind (credential or provider env). */
private fun adaptersUsing(kind: String, adapters: List<AdapterDescriptor>): List<String> =
    adapters.filter { kind in it.credentials.keys || kind in it.providerEnv.keys }.map { it.id }

/**
 * Kinds worth adding: github (if missing) plus every adapter credential
 * group that has no stored alternative yet (e.g. claude is satisfied by
 * claude_oauth OR anthropic).
 */
private fun recommendedKinds(adapters: List<AdapterDescriptor>, existing: Set<String>): List<String> {
    val rec = LinkedHashSet<String>()
    if ("github" !in existing) rec += "github"
    adapters.forEach { adapter ->
        val group = adapter.credentials.keys
        if (group.isNotEmpty() && group.none { it in existing }) rec += group
    }
    rec.removeAll(existing)
    return rec.toList()
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: SettingsViewModel = viewModel { SettingsViewModel().also { it.repository = repository } }
    val stats by repository.stats.collectAsState()
    val secrets by repository.secrets.collectAsState()
    val repos by repository.repos.collectAsState()
    val adapters by repository.adapters.collectAsState()
    val biometric by repository.tokenStore.biometricEnabled.collectAsState(initial = false)
    val error by vm.error.collectAsState()

    val catalog = buildCatalog(adapters)
    val existingKinds = secrets.map { it.kind }.toSet()
    val recommended = recommendedKinds(adapters, existingKinds)

    var showSecretDialog by remember { mutableStateOf(false) }
    var secretDialogKind by remember { mutableStateOf<String?>(null) }
    var manageSecret by remember { mutableStateOf<SecretInfo?>(null) }
    var confirmDeleteSecret by remember { mutableStateOf<SecretInfo?>(null) }
    var showAddRepo by remember { mutableStateOf(false) }
    var confirmLogout by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.refresh() }

    OneUiScaffold(title = "Einstellungen", onBack = onBack) { padding ->
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

            /* ---------- Empfohlen ---------- */
            if (recommended.isNotEmpty()) {
                SectionHeader("Empfohlen")
                GroupCard {
                    Column(Modifier.padding(vertical = 8.dp)) {
                        recommended.forEachIndexed { index, kind ->
                            if (index > 0) HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                            val meta = metaFor(kind, catalog)
                            val users = adaptersUsing(kind, adapters)
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        secretDialogKind = kind
                                        showSecretDialog = true
                                    }
                                    .padding(horizontal = 16.dp, vertical = 10.dp),
                            ) {
                                SettingsIcon(Icons.Filled.Add)
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(meta.displayName, style = MaterialTheme.typography.bodyLarge)
                                    Text(
                                        text = if (users.isEmpty()) meta.description
                                        else "für ${users.joinToString(", ")} — ${meta.description}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            /* ---------- Zugänge & API-Keys ---------- */
            SectionHeader("Zugänge & API-Keys")
            GroupCard {
                Column(Modifier.padding(vertical = 8.dp)) {
                    if (secrets.isEmpty()) {
                        Text(
                            text = "Noch keine Zugänge hinterlegt — für private Repos und Provider nötig",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                    secrets.forEachIndexed { index, secret ->
                        if (index > 0) HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                        val meta = metaFor(secret.kind, catalog)
                        val users = adaptersUsing(secret.kind, adapters)
                        val age = relativeTime(secret.createdAt)
                        val ageText = if (age == "jetzt") "gerade hinterlegt" else "hinterlegt vor $age"
                        SwipeToDismissRow(onDismiss = { vm.deleteSecret(secret.id) }) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(MaterialTheme.colorScheme.surfaceContainer)
                                    .clickable { manageSecret = secret }
                                    .padding(horizontal = 16.dp, vertical = 10.dp),
                            ) {
                                SettingsIcon(Icons.Outlined.Key)
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(meta.displayName, style = MaterialTheme.typography.bodyLarge)
                                    Text(
                                        text = if (users.isEmpty()) ageText
                                        else "für ${users.joinToString(", ")} · $ageText",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                    HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
                    AddRow(label = "Zugang hinzufügen", onClick = {
                        secretDialogKind = null
                        showSecretDialog = true
                    })
                }
            }
            Text(
                text = "Werte werden verschlüsselt im Server-Vault gespeichert und nie an die App zurückgeschickt.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 28.dp, vertical = 6.dp),
            )

            error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 28.dp, vertical = 8.dp),
                )
            }

            /* ---------- Gerät ---------- */
            SectionHeader("Gerät")
            GroupCard {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                    Button(
                        onClick = { confirmLogout = true },
                        shape = PillShape,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                            contentColor = MaterialTheme.colorScheme.onErrorContainer,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Von diesem Gerät abmelden", modifier = Modifier.padding(vertical = 4.dp))
                    }
                }
            }
        }
    }

    if (showSecretDialog) {
        SecretDialog(
            catalog = catalog,
            initialKind = secretDialogKind,
            onDismiss = { showSecretDialog = false },
            onSave = { kind, value -> vm.addSecret(kind, value) { showSecretDialog = false } },
        )
    }
    manageSecret?.let { secret ->
        val meta = metaFor(secret.kind, catalog)
        AlertDialog(
            onDismissRequest = { manageSecret = null },
            title = { Text(meta.displayName) },
            text = {
                Column {
                    DialogActionRow(icon = Icons.Outlined.Edit, label = "Wert aktualisieren") {
                        secretDialogKind = secret.kind
                        showSecretDialog = true
                        manageSecret = null
                    }
                    DialogActionRow(
                        icon = Icons.Outlined.Delete,
                        label = "Löschen",
                        tint = MaterialTheme.colorScheme.error,
                    ) {
                        confirmDeleteSecret = secret
                        manageSecret = null
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { manageSecret = null }) { Text("Abbrechen") }
            },
        )
    }
    confirmDeleteSecret?.let { secret ->
        val meta = metaFor(secret.kind, catalog)
        AlertDialog(
            onDismissRequest = { confirmDeleteSecret = null },
            title = { Text("„${meta.displayName}“ löschen?") },
            text = { Text("Der Zugang wird vom Server-Vault entfernt. Adapter, die ihn nutzen, können danach nicht mehr starten.") },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteSecret(secret.id)
                    confirmDeleteSecret = null
                }) { Text("Löschen", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDeleteSecret = null }) { Text("Abbrechen") }
            },
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
private fun DialogActionRow(
    icon: ImageVector,
    label: String,
    tint: Color = MaterialTheme.colorScheme.onSurface,
    onClick: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 13.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Spacer(modifier = Modifier.width(14.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = tint)
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
/* Add/Edit secret dialog                                              */
/* ------------------------------------------------------------------ */

private const val CUSTOM_KIND = "__custom__"

@Composable
private fun SecretDialog(
    catalog: List<SecretMeta>,
    initialKind: String?,
    onDismiss: () -> Unit,
    onSave: (kind: String, value: String) -> Unit,
) {
    var selectedKind by remember(initialKind) { mutableStateOf(initialKind) }
    var customKind by remember { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    var showValue by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }

    val customMode = selectedKind == CUSTOM_KIND
    val selectedMeta = selectedKind?.takeIf { it != CUSTOM_KIND }?.let { metaFor(it, catalog) }
    val effectiveKind = if (customMode) customKind.trim() else selectedKind.orEmpty()
    val multiline = !customMode && selectedMeta?.multiline == true

    val expectedPrefixes = KIND_PREFIXES[effectiveKind]
    val looksOdd = !multiline &&
        value.isNotBlank() &&
        expectedPrefixes != null &&
        expectedPrefixes.none { value.trim().startsWith(it) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initialKind != null && initialKind != CUSTOM_KIND) "Zugang aktualisieren" else "Zugang hinzufügen") },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.verticalScroll(rememberScrollState()),
            ) {
                ExposedDropdownMenuBox(
                    expanded = expanded,
                    onExpandedChange = { expanded = it },
                ) {
                    OutlinedTextField(
                        value = if (customMode) "Eigene Art …" else selectedMeta?.displayName ?: "",
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Art") },
                        placeholder = { Text("Auswählen …") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                        singleLine = true,
                        modifier = Modifier
                            .menuAnchor()
                            .fillMaxWidth(),
                    )
                    ExposedDropdownMenu(
                        expanded = expanded,
                        onDismissRequest = { expanded = false },
                    ) {
                        catalog.forEach { meta ->
                            DropdownMenuItem(
                                text = {
                                    Column {
                                        Text(
                                            meta.displayName,
                                            fontWeight = if (meta.kind == selectedKind) FontWeight.SemiBold else FontWeight.Normal,
                                        )
                                        Text(
                                            meta.kind,
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                },
                                onClick = {
                                    selectedKind = meta.kind
                                    expanded = false
                                },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text("Eigene Art …") },
                            onClick = {
                                selectedKind = CUSTOM_KIND
                                expanded = false
                            },
                        )
                    }
                }

                if (customMode) {
                    OutlinedTextField(
                        value = customKind,
                        onValueChange = { customKind = it },
                        label = { Text("Eigene Art") },
                        supportingText = { Text("Kleinbuchstaben und Unterstriche, z. B. mein_provider") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                selectedMeta?.description?.takeIf { it.isNotBlank() }?.let { help ->
                    Text(
                        text = help,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                if (multiline) {
                    OutlinedTextField(
                        value = value,
                        onValueChange = { value = it },
                        label = { Text("Wert") },
                        minLines = 3,
                        maxLines = 6,
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    OutlinedTextField(
                        value = value,
                        onValueChange = { value = it },
                        label = { Text("Wert") },
                        singleLine = true,
                        visualTransformation = if (showValue) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        trailingIcon = {
                            IconButton(onClick = { showValue = !showValue }) {
                                Icon(
                                    if (showValue) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                    contentDescription = if (showValue) "Wert verbergen" else "Wert anzeigen",
                                )
                            }
                        },
                        supportingText = if (looksOdd) {
                            {
                                Text(
                                    "Sieht ungewöhnlich aus — trotzdem speicherbar.",
                                    color = semantic().warning,
                                )
                            }
                        } else {
                            null
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSave(effectiveKind, value.trim()) },
                enabled = effectiveKind.isNotBlank() && value.isNotBlank(),
            ) { Text("Speichern") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Abbrechen") }
        },
    )
}
