@file:OptIn(ExperimentalMaterial3Api::class)

package com.pocketagent.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
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
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
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
import com.pocketagent.app.data.ProviderDescriptor
import com.pocketagent.app.data.SecretInfo
import com.pocketagent.app.data.SecretValidation
import com.pocketagent.app.data.WsClient
import com.pocketagent.app.ui.theme.CardInset
import com.pocketagent.app.ui.theme.SectionSpacing
import com.pocketagent.app.ui.theme.TileMinHeight
import com.pocketagent.app.ui.theme.semantic
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Fehlermeldung für den Nutzer: eine deutsche Ansage mit nächstem Schritt.
 * Die rohe Exception-Message landet, falls vorhanden, nur als Nebensatz —
 * nie als Überschrift, denn Server-/Exception-Text ist selten verständlich.
 */
private fun userMessage(headline: String, cause: Throwable): String {
    val detail = cause.message?.trim()?.takeIf { it.isNotBlank() }
    return if (detail != null) "$headline ($detail)" else headline
}

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
                onFailure = { _error.value = userMessage("Zugang konnte nicht gespeichert werden. Prüf die Verbindung zum Server und versuch es erneut.", it) },
            )
            onDone()
        }
    }

    /** Live-Prüfung beim Anbieter; unabhängig vom Speichern. */
    fun validateSecret(kind: String, value: String, onResult: (Result<SecretValidation>) -> Unit) {
        viewModelScope.launch { onResult(repository.validateSecret(kind, value)) }
    }

    fun deleteSecret(id: String) {
        viewModelScope.launch { repository.deleteSecret(id) }
    }

    fun addRepo(fullName: String, defaultBranch: String, onDone: () -> Unit) {
        viewModelScope.launch {
            repository.addRepo(fullName, defaultBranch).fold(
                onSuccess = { _error.value = null },
                onFailure = { _error.value = userMessage("Repository konnte nicht hinzugefügt werden. Prüf den Namen und versuch es erneut.", it) },
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
    /** Seite zum Erstellen des Keys — kommt aus dem Adapter-Manifest. */
    val keyUrl: String? = null,
)

private val SECRET_CATALOG = listOf(
    SecretMeta("github", "GitHub", "Personal Access Token mit repo-Scope — für private Repos, Push & PRs"),
    SecretMeta("claude_oauth", "Claude Abo (Setup-Token)", "Auf dem Laptop `claude setup-token` ausführen und Token einfügen (Pro/Max, ~1 Jahr gültig)"),
    SecretMeta("anthropic", "Anthropic API", "API-Key von console.anthropic.com (sk-ant-…)"),
    SecretMeta("openai", "OpenAI", "API-Key von platform.openai.com (sk-…)"),
    SecretMeta("zai", "Z.AI", "API-Key aus dem Z.AI-Dashboard"),
    // "moonshot" und "kimi" waren zwei Katalog-Einträge für denselben
    // Zugang — mancher Adapter (z. B. pi) mappt beide Provider-Ids sogar auf
    // dieselbe Umgebungsvariable. Fund: "Secret-Katalog … Duplikat
    // (moonshot/kimi)". Ein Eintrag, Alias über [SECRET_KIND_ALIASES].
    SecretMeta("moonshot", "Moonshot / Kimi", "API-Key von platform.moonshot.ai"),
    SecretMeta("google", "Google Gemini", "API-Key aus Google AI Studio"),
    SecretMeta("groq", "Groq", "API-Key von console.groq.com"),
    SecretMeta("openrouter", "OpenRouter", "API-Key von openrouter.ai (sk-or-…)"),
    SecretMeta("xai", "xAI", "API-Key von console.x.ai"),
    SecretMeta("junie", "JetBrains Junie", "Junie API-Key (usage-based)"),
    SecretMeta("kilo", "Kilo Gateway", "Kompletter Inhalt der Gateway-auth.json einfügen", multiline = true),
)

/**
 * Kind-Ids, die serverseitig zwei Provider-Ids desselben Zugangs sind
 * (siehe SECRET_CATALOG-Kommentar zu "moonshot"/"kimi"). Rein clientseitige
 * Anzeige-Zusammenführung — ein bereits unter dem Alias gespeicherter Secret
 * bleibt unter seiner echten Kind-Id funktionsfähig (Löschen läuft über die
 * Id, nicht die Art), zeigt aber denselben Anzeigenamen wie der Kanon.
 */
private val SECRET_KIND_ALIASES = mapOf("kimi" to "moonshot")

private fun canonicalKind(kind: String): String = SECRET_KIND_ALIASES[kind] ?: kind

/** Soft format hints per kind — warn, never block. */
private val KIND_PREFIXES = mapOf(
    "github" to listOf("ghp_", "github_pat_"),
    "anthropic" to listOf("sk-ant-"),
    "openai" to listOf("sk-"),
    "openrouter" to listOf("sk-or-"),
)

/**
 * Konkrete Ansage statt Warnung ohne Ausweg: "Sieht ungewöhnlich aus" nennt
 * ein mögliches Problem und nimmt es im selben Satz zurück. Das hier sagt
 * stattdessen, wie ein gültiger Wert für diese Art aussieht.
 */
private fun prefixHint(displayName: String, prefixes: List<String>): String {
    val joined = if (prefixes.size == 1) {
        prefixes.first()
    } else {
        prefixes.dropLast(1).joinToString(", ") + " oder " + prefixes.last()
    }
    return "Ein $displayName-Token beginnt mit $joined."
}

/**
 * Der statische Katalog bleibt die Grundlage (er kennt auch Arten, die kein
 * installierter Adapter meldet), wird aber pro Art mit den Manifest-Angaben
 * des Servers überschrieben — der Server weiß besser, wie sein Adapter den
 * Zugang nennt und wo man den Key holt.
 */
private fun buildCatalog(adapters: List<AdapterDescriptor>): List<SecretMeta> {
    val manifest = LinkedHashMap<String, ProviderDescriptor>()
    adapters.forEach { adapter ->
        adapter.providers.forEach { provider ->
            if (provider.id !in manifest) manifest[provider.id] = provider
        }
    }

    val enriched = SECRET_CATALOG.map { meta ->
        val provider = manifest[meta.kind] ?: return@map meta
        meta.copy(
            displayName = provider.name.ifBlank { meta.displayName },
            description = provider.hint?.takeIf { it.isNotBlank() } ?: meta.description,
            keyUrl = provider.keyUrl,
        )
    }

    // Alias-Ids (z. B. "kimi") zählen als bekannt, sonst würde ein Adapter,
    // der sie als eigene providerEnv-Id führt, den Katalog-Eintrag erneut
    // duplizieren, den SECRET_KIND_ALIASES gerade zusammengeführt hat.
    val known = SECRET_CATALOG.map { it.kind }.toSet() + SECRET_KIND_ALIASES.keys
    val dynamic = adapters
        .flatMap { it.credentials.keys + it.providerEnv.keys }
        .distinct()
        .filter { it !in known }
        .sorted()
        .map { kind ->
            val provider = manifest[kind]
            SecretMeta(
                kind = kind,
                displayName = provider?.name?.takeIf { it.isNotBlank() } ?: kind,
                description = provider?.hint?.takeIf { it.isNotBlank() }
                    ?: "Wird von einem installierten Adapter genutzt",
                keyUrl = provider?.keyUrl,
            )
        }
    return enriched + dynamic
}

/** Kanonisiert Alias-Kinds (siehe [SECRET_KIND_ALIASES]) vor dem Nachschlagen —
 *  ein bereits unter "kimi" gespeicherter Zugang zeigt so denselben Namen
 *  wie ein neu unter "moonshot" angelegter. */
private fun metaFor(kind: String, catalog: List<SecretMeta>): SecretMeta =
    catalog.firstOrNull { it.kind == canonicalKind(kind) } ?: SecretMeta(kind, kind, "")

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
    val connState by repository.connState.collectAsState()
    val error by vm.error.collectAsState()
    val connected = connState is WsClient.ConnState.Connected

    val catalog = buildCatalog(adapters)
    val existingKinds = secrets.map { it.kind }.toSet()
    val recommended = recommendedKinds(adapters, existingKinds)

    // Faltbare Geräte: ein Faltvorgang darf die offenen Dialoge nicht
    // schließen. Boolean/String überleben das ohne eigenen Saver.
    var showSecretDialog by rememberSaveable { mutableStateOf(false) }
    var secretDialogKind by rememberSaveable { mutableStateOf<String?>(null) }
    var manageSecret by remember { mutableStateOf<SecretInfo?>(null) }
    var confirmDeleteSecret by remember { mutableStateOf<SecretInfo?>(null) }
    var showAddRepo by rememberSaveable { mutableStateOf(false) }
    var confirmLogout by rememberSaveable { mutableStateOf(false) }
    var serverDetailsOpen by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.refresh() }

    OneUiScaffold(title = "Einstellungen", onBack = onBack) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            /* ---------- Server ---------- */
            // Nur Verbindung ist auf einen Blick sichtbar — Sessions/
            // Container/Laufzeit sind Debug-Werte ohne Handlungswert und
            // beantworten keine Frage, die die App stellt (Fund:
            // "Server-Statistik-Block … ohne Handlungswert"). Wer sie
            // braucht, tippt "Details" auf.
            SectionHeader("Server")
            GroupCard {
                Column(Modifier.padding(vertical = 4.dp)) {
                    val s = stats
                    SettingsRow(
                        label = "Verbindung",
                        value = if (connected) "verbunden" else "offline",
                    )
                    ListDivider(CardInset)
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { serverDetailsOpen = !serverDetailsOpen }
                            .heightIn(min = TileMinHeight)
                            .padding(horizontal = CardInset),
                    ) {
                        Text(
                            "Details",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.weight(1f),
                        )
                        Icon(
                            if (serverDetailsOpen) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                            contentDescription = if (serverDetailsOpen) "Details einklappen" else "Details ausklappen",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    AnimatedVisibility(visible = serverDetailsOpen) {
                        Column {
                            ListDivider(CardInset)
                            SettingsRow(label = "Aktive Sessions", value = s?.sessionsActive?.toString() ?: "…")
                            ListDivider(CardInset)
                            SettingsRow(label = "Laufende Container", value = s?.containersRunning?.toString() ?: "…")
                            ListDivider(CardInset)
                            SettingsRow(label = "Laufzeit", value = s?.let { formatUptime(it.uptimeSec) } ?: "…")
                        }
                    }
                }
            }

            /* ---------- Sicherheit ---------- */
            SectionHeader("Sicherheit")
            GroupCard {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .toggleable(
                            value = biometric,
                            role = Role.Switch,
                            onValueChange = { vm.setBiometric(it) },
                        )
                        .heightIn(min = TileMinHeight)
                        .padding(horizontal = CardInset, vertical = 8.dp),
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
                    Switch(checked = biometric, onCheckedChange = null)
                }
            }

            /* ---------- Repositories ---------- */
            SectionHeader("Repositories")
            GroupCard {
                Column(Modifier.padding(vertical = 4.dp)) {
                    if (repos.isEmpty()) {
                        EmptyRow("Noch keine Repositories")
                    }
                    repos.forEachIndexed { index, repo ->
                        if (index > 0) ListDivider()
                        SettingsTile(
                            icon = Icons.Outlined.Folder,
                            title = repo.fullName,
                            subtitle = "Basis: ${repo.defaultBranch}",
                        )
                    }
                    ListDivider()
                    AddRow(label = "Repository hinzufügen", onClick = { showAddRepo = true })
                }
            }

            /* ---------- Empfohlen ---------- */
            if (recommended.isNotEmpty()) {
                SectionHeader("Empfohlen")
                GroupCard {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        recommended.forEachIndexed { index, kind ->
                            if (index > 0) ListDivider()
                            val meta = metaFor(kind, catalog)
                            val users = adaptersUsing(kind, adapters)
                            SettingsTile(
                                icon = Icons.Outlined.Key,
                                title = meta.displayName,
                                // The long how-to belongs in the dialog, not here.
                                subtitle = if (users.isEmpty()) {
                                    "Noch nicht hinterlegt"
                                } else {
                                    "Wird von ${users.joinToString(", ")} gebraucht"
                                },
                                onClick = {
                                    secretDialogKind = kind
                                    showSecretDialog = true
                                },
                                trailing = {
                                    Icon(
                                        Icons.Filled.Add,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier.size(20.dp),
                                    )
                                },
                            )
                        }
                    }
                }
            }

            /* ---------- Zugänge ---------- */
            SectionHeader("Zugänge")
            GroupCard {
                Column(Modifier.padding(vertical = 4.dp)) {
                    if (secrets.isEmpty()) {
                        EmptyRow("Noch nichts hinterlegt – nötig für private Repos und Agenten")
                    }
                    secrets.forEachIndexed { index, secret ->
                        if (index > 0) ListDivider()
                        val meta = metaFor(secret.kind, catalog)
                        val users = adaptersUsing(secret.kind, adapters)
                        val age = relativeTime(secret.createdAt)
                        val ageText = if (age == "jetzt") "gerade hinterlegt" else "hinterlegt vor $age"
                        // Wisch fragt statt sofort zu löschen — dasselbe
                        // Muster wie der Lösch-Wisch der Session-Liste (Fund:
                        // "Secret-Löschen per Wisch ohne Bestätigung und ohne
                        // Undo"). Der Tap-Weg über das Sheet (unten) hatte
                        // diese Sicherung schon; jetzt gilt sie auf beiden Wegen.
                        SwipeToDismissRow(onRequestDelete = { confirmDeleteSecret = secret }) {
                            SettingsTile(
                                icon = Icons.Outlined.Key,
                                title = meta.displayName,
                                subtitle = if (users.isEmpty()) {
                                    ageText
                                } else {
                                    "für ${users.joinToString(", ")} · $ageText"
                                },
                                onClick = { manageSecret = secret },
                                modifier = Modifier.background(MaterialTheme.colorScheme.surfaceContainer),
                            )
                        }
                    }
                    ListDivider()
                    AddRow(label = "Zugang hinzufügen", onClick = {
                        secretDialogKind = null
                        showSecretDialog = true
                    })
                }
            }
            SectionNote("Werte liegen verschlüsselt im Server-Vault und werden nie an die App zurückgeschickt.")

            error?.let { SectionError(it) }

            /* ---------- Gerät ---------- */
            SectionHeader("Gerät")
            GroupCard {
                Column(Modifier.padding(vertical = 4.dp)) {
                    // A destructive list row, not a red button — same
                    // vocabulary as every other row on this screen.
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { confirmLogout = true }
                            .heightIn(min = TileMinHeight)
                            .padding(horizontal = CardInset),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Outlined.Logout,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Text(
                            "Von diesem Gerät abmelden",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
            Spacer(modifier = Modifier.height(SectionSpacing))
        }
    }

    if (showSecretDialog) {
        SecretDialog(
            catalog = catalog,
            initialKind = secretDialogKind,
            onDismiss = { showSecretDialog = false },
            onSave = { kind, value -> vm.addSecret(kind, value) { showSecretDialog = false } },
            onValidate = { kind, value, onResult -> vm.validateSecret(kind, value, onResult) },
        )
    }
    manageSecret?.let { secret ->
        val meta = metaFor(secret.kind, catalog)
        // Per-item Optionen sind ein Menü, kein betitelter Dialog — dieselbe
        // Form wie das Kontextmenü der Session-Liste (SettingSheet + GroupCard).
        SettingSheet(title = meta.displayName, onDismiss = { manageSecret = null }) {
            GroupCard {
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
            }
        }
    }
    confirmDeleteSecret?.let { secret ->
        val meta = metaFor(secret.kind, catalog)
        OneUiDialog(
            onDismissRequest = { confirmDeleteSecret = null },
            title = "„${meta.displayName}“ löschen?",
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
        OneUiDialog(
            onDismissRequest = { confirmLogout = false },
            title = "Abmelden?",
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

/** Icon + title + subtitle row. Every content row on this screen is one. */
@Composable
private fun SettingsTile(
    icon: ImageVector,
    title: String,
    subtitle: String?,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .heightIn(min = TileMinHeight)
            .padding(horizontal = CardInset, vertical = 8.dp),
    ) {
        SettingsIcon(icon)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!subtitle.isNullOrBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        trailing?.let {
            Spacer(modifier = Modifier.width(12.dp))
            it()
        }
    }
}

@Composable
private fun SettingsRow(label: String, value: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = TileMinHeight)
            .padding(horizontal = CardInset),
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
private fun EmptyRow(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = CardInset, vertical = 12.dp),
    )
}

@Composable
private fun AddRow(label: String, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = TileMinHeight)
            .padding(horizontal = CardInset),
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
            .heightIn(min = TileMinHeight)
            .padding(horizontal = 8.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Spacer(modifier = Modifier.width(14.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = tint)
    }
}

/**
 * Der Wisch löscht nicht mehr direkt — er federt immer zurück und meldet
 * nur die Absicht ([onRequestDelete]), die der Aufrufer hinter einen
 * Bestätigungsdialog hängt (dieselbe Sicherung, die der Tap-Weg über das
 * Sheet schon hatte). Endgültiges Löschen ohne Rückfrage per Wisch war eine
 * Schutzlücke (Fund, HOCH).
 */
@Composable
private fun SwipeToDismissRow(onRequestDelete: () -> Unit, content: @Composable () -> Unit) {
    val request by rememberUpdatedState(onRequestDelete)
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) request()
            false
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
    onValidate: (kind: String, value: String, onResult: (Result<SecretValidation>) -> Unit) -> Unit,
) {
    var selectedKind by remember(initialKind) { mutableStateOf(initialKind) }
    // Ein halb eingetippter Zugang muss einen Faltvorgang überleben.
    var customKind by rememberSaveable { mutableStateOf("") }
    var value by rememberSaveable { mutableStateOf("") }
    var showValue by rememberSaveable { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }
    var checking by remember { mutableStateOf(false) }
    var check by remember { mutableStateOf<SecretValidation?>(null) }
    var checkError by remember { mutableStateOf<String?>(null) }
    val uriHandler = LocalUriHandler.current

    // Ein Ergebnis gilt immer nur für genau den Wert, der geprüft wurde.
    fun resetCheck() {
        check = null
        checkError = null
    }

    val customMode = selectedKind == CUSTOM_KIND
    val selectedMeta = selectedKind?.takeIf { it != CUSTOM_KIND }?.let { metaFor(it, catalog) }
    val effectiveKind = if (customMode) customKind.trim() else selectedKind.orEmpty()
    val multiline = !customMode && selectedMeta?.multiline == true

    val expectedPrefixes = KIND_PREFIXES[effectiveKind]
    val looksOdd = !multiline &&
        value.isNotBlank() &&
        expectedPrefixes != null &&
        expectedPrefixes.none { value.trim().startsWith(it) }
    val prefixHintText = expectedPrefixes?.let { prefixHint(selectedMeta?.displayName ?: effectiveKind, it) }

    OneUiDialog(
        onDismissRequest = onDismiss,
        title = if (initialKind != null && initialKind != CUSTOM_KIND) "Zugang aktualisieren" else "Zugang hinzufügen",
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
                                        // Anzeigename + Beschreibung genügen —
                                        // die rohe Kind-Id ist nur für "Eigene
                                        // Art" relevant (Fund: "kryptische
                                        // Kind-Ids im Dialog").
                                        meta.description.takeIf { it.isNotBlank() }?.let { desc ->
                                            Text(
                                                text = desc,
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                },
                                onClick = {
                                    selectedKind = meta.kind
                                    resetCheck()
                                    expanded = false
                                },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text("Eigene Art …") },
                            onClick = {
                                selectedKind = CUSTOM_KIND
                                resetCheck()
                                expanded = false
                            },
                        )
                    }
                }

                if (customMode) {
                    OutlinedTextField(
                        value = customKind,
                        onValueChange = { customKind = it; resetCheck() },
                        label = { Text("Eigene Art") },
                        supportingText = { Text("Kleinbuchstaben und Unterstriche, z. B. mein_provider") },
                        singleLine = true,
                        shape = MaterialTheme.shapes.small,
                        keyboardOptions = KeyboardOptions(
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Ascii,
                            imeAction = ImeAction.Next,
                        ),
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

                // Der Weg zum Key gehört dorthin, wo er gebraucht wird.
                selectedMeta?.keyUrl?.takeIf { it.isNotBlank() }?.let { url ->
                    TextButton(
                        onClick = { runCatching { uriHandler.openUri(url) } },
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Outlined.OpenInNew,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Auf der Website anlegen")
                    }
                }

                if (multiline) {
                    OutlinedTextField(
                        value = value,
                        onValueChange = { value = it; resetCheck() },
                        label = { Text("Wert") },
                        minLines = 3,
                        maxLines = 6,
                        shape = MaterialTheme.shapes.small,
                        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    OutlinedTextField(
                        value = value,
                        onValueChange = { value = it; resetCheck() },
                        label = { Text("Wert") },
                        singleLine = true,
                        shape = MaterialTheme.shapes.small,
                        visualTransformation = if (showValue) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Done,
                        ),
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
                                    prefixHintText.orEmpty(),
                                    color = semantic().warning,
                                )
                            }
                        } else {
                            null
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                CheckResultRow(checking = checking, result = check, error = checkError)
            }
        },
        confirmButton = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // Prüfen ist optional: Speichern bleibt jederzeit möglich,
                // auch wenn die Prüfung fehlschlägt oder gar nicht existiert.
                TextButton(
                    onClick = {
                        checking = true
                        resetCheck()
                        onValidate(effectiveKind, value.trim()) { result ->
                            checking = false
                            result.fold(
                                onSuccess = { check = it },
                                onFailure = { checkError = it.message ?: "Prüfung fehlgeschlagen" },
                            )
                        }
                    },
                    enabled = !checking && effectiveKind.isNotBlank() && value.isNotBlank(),
                ) { Text("Prüfen") }
                Spacer(modifier = Modifier.width(4.dp))
                TextButton(
                    onClick = { onSave(effectiveKind, value.trim()) },
                    enabled = effectiveKind.isNotBlank() && value.isNotBlank(),
                ) { Text("Speichern") }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Abbrechen") }
        },
    )
}

/**
 * Ergebniszeile der Live-Prüfung. Grün nur bei bestätigtem Zugang; Arten ohne
 * Prüfung bleiben bewusst neutral, damit „ungeprüft" nicht wie „geprüft" aussieht.
 */
@Composable
private fun CheckResultRow(
    checking: Boolean,
    result: SecretValidation?,
    error: String?,
) {
    if (!checking && result == null && error == null) return

    val (icon, tint, text) = when {
        checking -> Triple(null, MaterialTheme.colorScheme.onSurfaceVariant, "Zugang wird geprüft …")
        error != null -> Triple(Icons.Outlined.ErrorOutline, MaterialTheme.colorScheme.error, error)
        result != null && result.unverified -> Triple(
            Icons.Outlined.Info,
            MaterialTheme.colorScheme.onSurfaceVariant,
            result.detail ?: "Keine Live-Prüfung verfügbar — gespeichert wird trotzdem",
        )

        result != null && result.ok -> Triple(
            Icons.Outlined.CheckCircleOutline,
            semantic().success,
            result.detail ?: "Zugang funktioniert",
        )

        else -> Triple(
            Icons.Outlined.ErrorOutline,
            MaterialTheme.colorScheme.error,
            result?.detail ?: "Zugang konnte nicht bestätigt werden",
        )
    }

    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        if (icon == null) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
        } else {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        }
        Spacer(modifier = Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = tint)
    }
}
