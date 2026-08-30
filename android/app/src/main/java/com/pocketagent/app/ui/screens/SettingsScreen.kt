@file:OptIn(ExperimentalMaterial3Api::class)

package com.pocketagent.app.ui.screens

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.BatteryChargingFull
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FileDownload
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.Sync
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import com.pocketagent.app.connection.ConnectionService
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.CrashLog
import com.pocketagent.app.data.DeviceInfo
import com.pocketagent.app.data.LinkInfo
import com.pocketagent.app.data.PI_DEFAULT_PROVIDER
import com.pocketagent.app.data.PI_PROVIDERS
import com.pocketagent.app.data.PairingApi
import com.pocketagent.app.data.ReleaseInfo
import com.pocketagent.app.data.SecretInfo
import com.pocketagent.app.data.SecretValidation
import com.pocketagent.app.data.UpdateChecker
import com.pocketagent.app.data.UpdateInstaller
import com.pocketagent.app.data.WsClient
import com.pocketagent.app.data.truncateForShare
import com.pocketagent.app.ui.theme.CardInset
import com.pocketagent.app.ui.theme.ListItemTitle
import com.pocketagent.app.ui.theme.SectionSpacing
import com.pocketagent.app.ui.theme.TileMinHeight
import com.pocketagent.app.ui.theme.semantic
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

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

    private val _devices = MutableStateFlow<List<DeviceInfo>>(emptyList())
    val devices: StateFlow<List<DeviceInfo>> = _devices

    private val _links = MutableStateFlow<List<LinkInfo>>(emptyList())
    val links: StateFlow<List<LinkInfo>> = _links

    fun refresh() {
        viewModelScope.launch {
            repository.refreshStats()
            repository.loadSecrets()
            repository.refreshSessions()
            repository.refreshRepos()
        }
        loadDevices()
    }

    /** Gekoppelte Geräte und verbundene Link-Agenten holen. */
    fun loadDevices() {
        viewModelScope.launch {
            repository.loadDevices().onSuccess { _devices.value = it }
            repository.loadLinks().onSuccess { _links.value = it }
        }
    }

    fun revokeDevice(id: String) {
        viewModelScope.launch {
            repository.revokeDevice(id).fold(
                onSuccess = { _error.value = null; loadDevices() },
                onFailure = { _error.value = userMessage("Gerät konnte nicht entkoppelt werden.", it) },
            )
        }
    }

    fun revokeLink(id: String) {
        viewModelScope.launch {
            repository.revokeLink(id).fold(
                onSuccess = { _error.value = null; loadDevices() },
                onFailure = { _error.value = userMessage("Link-Agent konnte nicht getrennt werden.", it) },
            )
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

    /**
     * Speichert die Einstellung; Start/Stopp des ConnectionService übernimmt
     * der Aufrufer mit dem Activity-Kontext (VM hält bewusst keinen Context).
     */
    fun setBackgroundConnection(enabled: Boolean) {
        viewModelScope.launch { repository.tokenStore.setBackgroundConnection(enabled) }
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
    /** Seite zum Erstellen des Keys. */
    val keyUrl: String? = null,
)

/**
 * Was sich hinterlegen lässt: der GitHub-Zugang und die sechs Zugänge aus der
 * pi-Provider-Tabelle ([PI_PROVIDERS]) — mehr kennt der Server nicht. Fest
 * statt vom Server geladen, weil es nur einen Agenten mit einer festen
 * Tabelle gibt; „Eigene Art …" im Dialog bleibt trotzdem möglich.
 */
private val SECRET_CATALOG: List<SecretMeta> = listOf(
    SecretMeta("github", "GitHub", "Personal Access Token mit repo-Scope — für private Repos, Push & PRs"),
) + PI_PROVIDERS.map { provider ->
    SecretMeta(
        kind = provider.id,
        displayName = provider.name,
        description = provider.hint,
        keyUrl = provider.keyUrl,
    )
}

/** Soft format hints per kind — warn, never block. */
private val KIND_PREFIXES = mapOf(
    "github" to listOf("ghp_", "github_pat_"),
    "anthropic" to listOf("sk-ant-"),
    "openai" to listOf("sk-"),
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

/** Eine frei eingetippte Art behält ihre Id als Namen. */
private fun metaFor(kind: String): SecretMeta =
    SECRET_CATALOG.firstOrNull { it.kind == kind } ?: SecretMeta(kind, kind, "")

/**
 * Was noch fehlt, um überhaupt loslegen zu können: der GitHub-Zugang und —
 * solange gar kein Provider-Key hinterlegt ist — der Standard-Zugang von pi.
 * Ohne einen der sechs Keys startet jede Session ohne Schlüssel; ohne diesen
 * Hinweis stünde das nirgends, bevor es zu spät ist. Liegt schon irgendein
 * Provider-Key vor, wird hier keiner mehr empfohlen — welcher der richtige
 * ist, entscheidet der Anlege-Screen.
 */
private fun recommendedKinds(existing: Set<String>): List<String> {
    val rec = LinkedHashSet<String>()
    if ("github" !in existing) rec += "github"
    if (PI_PROVIDERS.none { it.id in existing }) rec += PI_DEFAULT_PROVIDER
    return rec.toList()
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: SettingsViewModel = viewModel { SettingsViewModel().also { it.repository = repository } }
    val stats by repository.stats.collectAsState()
    val secrets by repository.secrets.collectAsState()
    val repos by repository.repos.collectAsState()
    val biometric by repository.tokenStore.biometricEnabled.collectAsState(initial = false)
    // initial = true wie der Default der Einstellung: vor der ersten DataStore-
    // Emission darf der Schalter nicht kurz „aus“ zeigen (siehe BiometricGate).
    val backgroundConnection by repository.tokenStore.backgroundConnection.collectAsState(initial = true)
    val connState by repository.connState.collectAsState()
    val error by vm.error.collectAsState()
    val connected = connState is WsClient.ConnState.Connected
    val devices by vm.devices.collectAsState()
    val links by vm.links.collectAsState()
    // Eigene Geräte-Id, um das aktuelle Gerät zu markieren und sein Entkoppeln
    // dem „Abmelden“-Weg zu überlassen (kein Selbst-Rauswurf über diese Liste).
    val setup by repository.tokenStore.setup.collectAsState(initial = null)
    val currentDeviceId = setup?.deviceId
    var confirmRevokeDevice by remember { mutableStateOf<DeviceInfo?>(null) }
    var confirmRevokeLink by remember { mutableStateOf<LinkInfo?>(null) }

    val existingKinds = secrets.map { it.kind }.toSet()
    val recommended = recommendedKinds(existingKinds)

    // Faltbare Geräte: ein Faltvorgang darf die offenen Dialoge nicht
    // schließen. Boolean/String überleben das ohne eigenen Saver.
    var showSecretDialog by rememberSaveable { mutableStateOf(false) }
    var secretDialogKind by rememberSaveable { mutableStateOf<String?>(null) }
    var manageSecret by remember { mutableStateOf<SecretInfo?>(null) }
    var confirmDeleteSecret by remember { mutableStateOf<SecretInfo?>(null) }
    var showAddRepo by rememberSaveable { mutableStateOf(false) }
    var confirmLogout by rememberSaveable { mutableStateOf(false) }
    var serverDetailsOpen by rememberSaveable { mutableStateOf(false) }

    // Letzter Absturzbericht (CrashLog): einmal beim Öffnen von Platte lesen.
    var lastCrash by remember { mutableStateOf<CrashLog.LastCrash?>(null) }
    val crashScope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        lastCrash = withContext(Dispatchers.IO) { CrashLog.latest(app) }
    }

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
                    ListDivider(CardInset)
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .toggleable(
                                value = backgroundConnection,
                                role = Role.Switch,
                                onValueChange = { enabled ->
                                    vm.setBackgroundConnection(enabled)
                                    // Settings ist ein Vordergrund-Moment — der
                                    // einzige erlaubte Kontext, einen
                                    // Foreground-Service zu starten (Android 12+).
                                    if (enabled) {
                                        ConnectionService.startIfEligible(context)
                                    } else {
                                        ConnectionService.stop(context)
                                    }
                                },
                            )
                            .heightIn(min = TileMinHeight)
                            .padding(horizontal = CardInset, vertical = 8.dp),
                    ) {
                        SettingsIcon(Icons.Outlined.Sync)
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Im Hintergrund verbunden bleiben", style = MaterialTheme.typography.bodyLarge)
                            Text(
                                text = "Hält die Verbindung über eine stille Dauer-Notification – beim Öffnen der App ist sie sofort da",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(checked = backgroundConnection, onCheckedChange = null)
                    }
                    // Nur solange nötig: mit erteilter Ausnahme wäre die Zeile
                    // eine Handlung ohne Wirkung.
                    if (backgroundConnection) {
                        BatteryExemptionRow()
                    }
                }
            }

            Spacer(modifier = Modifier.height(SectionSpacing))
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

            Spacer(modifier = Modifier.height(SectionSpacing))
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
                Spacer(modifier = Modifier.height(SectionSpacing))
                SectionHeader("Empfohlen")
                GroupCard {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        recommended.forEachIndexed { index, kind ->
                            if (index > 0) ListDivider()
                            val meta = metaFor(kind)
                            SettingsTile(
                                icon = Icons.Outlined.Key,
                                title = meta.displayName,
                                // The long how-to belongs in the dialog, not here.
                                subtitle = "Noch nicht hinterlegt",
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

            Spacer(modifier = Modifier.height(SectionSpacing))
            /* ---------- Zugänge ---------- */
            SectionHeader("Zugänge")
            GroupCard {
                Column(Modifier.padding(vertical = 4.dp)) {
                    if (secrets.isEmpty()) {
                        EmptyRow("Noch nichts hinterlegt – nötig für private Repos und den Modell-Anbieter")
                    }
                    secrets.forEachIndexed { index, secret ->
                        if (index > 0) ListDivider()
                        val meta = metaFor(secret.kind)
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
                                subtitle = ageText,
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

            /* ---------- Diagnose ---------- */
            // Ohne Report keine Section — ein leerer Platzhalter würde nur
            // eine Frage aufwerfen, die die App nicht beantworten kann.
            lastCrash?.let { crash ->
                Spacer(modifier = Modifier.height(SectionSpacing))
                SectionHeader("Diagnose")
                GroupCard {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        SettingsTile(
                            icon = Icons.Outlined.BugReport,
                            title = "Letzter Absturz",
                            subtitle = "${formatCrashTime(crash.timestampIso)} · ${crash.summary}",
                        )
                        ListDivider()
                        Row(
                            horizontalArrangement = Arrangement.End,
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            TextButton(onClick = {
                                crashScope.launch {
                                    withContext(Dispatchers.IO) { CrashLog.discardAll(app) }
                                    lastCrash = null
                                }
                            }) { Text("Verwerfen", color = MaterialTheme.colorScheme.error) }
                            Spacer(modifier = Modifier.width(4.dp))
                            TextButton(onClick = { shareCrashReport(context, crash.report) }) {
                                Text("Teilen")
                            }
                        }
                    }
                }
                SectionNote("Der Bericht enthält Stacktrace, App-Version und Gerätemodell — keine Chat-Inhalte oder Zugänge.")
            }

            /* ---------- App-Update ---------- */
            AppUpdateSection()

            Spacer(modifier = Modifier.height(SectionSpacing))
            /* ---------- Gekoppelte Geräte ---------- */
            SectionHeader("Gekoppelte Geräte")
            GroupCard {
                Column(Modifier.padding(vertical = 4.dp)) {
                    if (devices.isEmpty() && links.isEmpty()) {
                        EmptyRow("Keine weiteren Geräte oder Link-Agenten verbunden")
                    }
                    devices.forEachIndexed { index, device ->
                        if (index > 0) ListDivider()
                        val self = device.id == currentDeviceId
                        SettingsTile(
                            icon = Icons.Outlined.Smartphone,
                            title = if (self) "${device.name} (dieses Gerät)" else device.name,
                            // online = lebender Socket; sonst „zuletzt aktiv" aus
                            // dem lastSeenAt-Stempel (Fallback: Kopplungszeitpunkt
                            // für einen älteren Server ohne das Feld).
                            subtitle = if (device.online) {
                                "online"
                            } else {
                                "zuletzt aktiv ${relativeTime(device.lastSeenAt ?: device.enrolledAt)}"
                            },
                            // Das eigene Gerät entkoppelt man über „Abmelden" —
                            // nicht über diese Liste (kein Selbst-Rauswurf).
                            trailing = if (self) {
                                null
                            } else {
                                {
                                    TextButton(onClick = { confirmRevokeDevice = device }) {
                                        Text("Entkoppeln", color = MaterialTheme.colorScheme.error)
                                    }
                                }
                            },
                        )
                    }
                    links.forEachIndexed { index, link ->
                        if (index > 0 || devices.isNotEmpty()) ListDivider()
                        SettingsTile(
                            icon = Icons.Outlined.Link,
                            title = link.name,
                            subtitle = "Link-Agent · verbunden ${relativeTime(link.createdAt)}",
                            trailing = {
                                TextButton(onClick = { confirmRevokeLink = link }) {
                                    Text("Trennen", color = MaterialTheme.colorScheme.error)
                                }
                            },
                        )
                    }
                }
            }
            SectionNote("Entzogene Geräte müssen neu gekoppelt werden. Das eigene Gerät meldest du unten ab.")

            Spacer(modifier = Modifier.height(SectionSpacing))
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
            initialKind = secretDialogKind,
            onDismiss = { showSecretDialog = false },
            onSave = { kind, value -> vm.addSecret(kind, value) { showSecretDialog = false } },
            onValidate = { kind, value, onResult -> vm.validateSecret(kind, value, onResult) },
        )
    }
    manageSecret?.let { secret ->
        val meta = metaFor(secret.kind)
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
        val meta = metaFor(secret.kind)
        OneUiDialog(
            onDismissRequest = { confirmDeleteSecret = null },
            title = "„${meta.displayName}“ löschen?",
            text = { Text("Der Zugang wird vom Server-Vault entfernt. Sessions, die ihn nutzen, können danach nicht mehr starten.") },
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
    confirmRevokeDevice?.let { device ->
        OneUiDialog(
            onDismissRequest = { confirmRevokeDevice = null },
            title = "„${device.name}“ entkoppeln?",
            text = { Text("Das Gerät verliert seinen Zugang und muss neu gekoppelt werden.") },
            confirmButton = {
                TextButton(onClick = {
                    vm.revokeDevice(device.id)
                    confirmRevokeDevice = null
                }) { Text("Entkoppeln", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmRevokeDevice = null }) { Text("Abbrechen") }
            },
        )
    }
    confirmRevokeLink?.let { link ->
        OneUiDialog(
            onDismissRequest = { confirmRevokeLink = null },
            title = "„${link.name}“ trennen?",
            text = { Text("Der Link-Agent wird getrennt. Auf ihm laufende Sessions gelten danach als offline.") },
            confirmButton = {
                TextButton(onClick = {
                    vm.revokeLink(link.id)
                    confirmRevokeLink = null
                }) { Text("Trennen", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmRevokeLink = null }) { Text("Abbrechen") }
            },
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
/* App-Update (GitHub-Releases)                                        */
/* ------------------------------------------------------------------ */

private sealed interface UpdateUiState {
    data object Idle : UpdateUiState
    data object Checking : UpdateUiState
    data object UpToDate : UpdateUiState
    data class Available(val release: ReleaseInfo) : UpdateUiState
    data class Downloading(val release: ReleaseInfo) : UpdateUiState
    data class Failed(val message: String) : UpdateUiState
}

/**
 * Update-Check und -Installation über die öffentlichen GitHub-Releases.
 * Läuft ausschließlich auf Nutzeraktion — bewusst kein Auto-Check im
 * Hintergrund, die App soll ohne Anlass nicht zu GitHub funken.
 */
@Composable
private fun AppUpdateSection() {
    val context = LocalContext.current
    // Version über den PackageManager, nicht BuildConfig — das
    // buildConfig-Feature ist nicht in jeder Build-Variante garantiert.
    val installedVersion = remember {
        runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull() ?: "unbekannt"
    }
    val scope = rememberCoroutineScope()
    val checker = remember { UpdateChecker(PairingApi.httpClient()) }
    val installer = remember {
        UpdateInstaller(context.applicationContext, UpdateInstaller.downloadClient())
    }
    var state by remember { mutableStateOf<UpdateUiState>(UpdateUiState.Idle) }

    fun startCheck() {
        state = UpdateUiState.Checking
        scope.launch {
            checker.fetchLatest().fold(
                onSuccess = { release ->
                    state = when {
                        release == null -> UpdateUiState.Failed("Das aktuelle Release enthält kein APK.")
                        UpdateChecker.isNewer(release.tag, installedVersion) -> UpdateUiState.Available(release)
                        else -> UpdateUiState.UpToDate
                    }
                },
                onFailure = { state = UpdateUiState.Failed(userMessage("Update-Prüfung fehlgeschlagen. Prüf die Internetverbindung.", it)) },
            )
        }
    }

    fun startDownload(release: ReleaseInfo) {
        state = UpdateUiState.Downloading(release)
        scope.launch {
            installer.download(release).fold(
                onSuccess = { file ->
                    // Zurück auf „verfügbar": bricht der Nutzer den
                    // System-Installer ab, lässt sich der Versuch direkt
                    // wiederholen.
                    state = UpdateUiState.Available(release)
                    runCatching { installer.install(file) }.onFailure {
                        state = UpdateUiState.Failed(userMessage("Installation konnte nicht gestartet werden.", it))
                    }
                },
                onFailure = { state = UpdateUiState.Failed(userMessage("Download fehlgeschlagen.", it)) },
            )
        }
    }

    Spacer(modifier = Modifier.height(SectionSpacing))
    SectionHeader("App-Update")
    GroupCard {
        Column(Modifier.padding(vertical = 4.dp)) {
            SettingsRow(label = "Installierte Version", value = installedVersion)
            ListDivider(CardInset)
            when (val s = state) {
                UpdateUiState.Checking -> UpdateBusyRow("Suche nach Update …")

                is UpdateUiState.Downloading -> UpdateBusyRow("${s.release.tag} wird heruntergeladen …")

                is UpdateUiState.Available -> {
                    Column(Modifier.padding(horizontal = CardInset, vertical = 10.dp)) {
                        Text(
                            "${s.release.tag} verfügbar",
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold,
                        )
                        if (s.release.notes.isNotBlank()) {
                            Text(
                                s.release.notes,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 4,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    ListDivider(CardInset)
                    AddRow(
                        label = "Herunterladen & installieren",
                        onClick = { startDownload(s.release) },
                        icon = Icons.Outlined.FileDownload,
                    )
                }

                else -> {
                    if (s is UpdateUiState.UpToDate) {
                        EmptyRow("Die App ist aktuell.")
                        ListDivider(CardInset)
                    }
                    if (s is UpdateUiState.Failed) {
                        Text(
                            s.message,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(horizontal = CardInset, vertical = 10.dp),
                        )
                        ListDivider(CardInset)
                    }
                    AddRow(
                        label = "Nach Update suchen",
                        onClick = { startCheck() },
                        icon = Icons.Filled.Refresh,
                    )
                }
            }
        }
    }
    SectionNote("Prüft nur auf Antippen die GitHub-Releases des Projekts — kein automatischer Check im Hintergrund.")
}

/**
 * Doze (Bildschirm aus, Gerät liegt ruhig) kappt selbst einen laufenden
 * Foreground-Service vom Netz — über Nacht stirbt die gehaltene Verbindung
 * sonst doch, nur später. Die Ausnahme von den Akku-Optimierungen hält sie
 * wirklich dauerhaft offen; die Zeile erscheint deshalb nur, solange die
 * Ausnahme noch nicht erteilt ist (ein ON_RESUME-Tick prüft nach der
 * Rückkehr aus dem Systemdialog neu).
 */
@SuppressLint("BatteryLife")
@Composable
private fun BatteryExemptionRow() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var resumeTick by remember { mutableStateOf(0) }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) resumeTick += 1
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val ignoringOptimizations = remember(resumeTick) {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        power?.isIgnoringBatteryOptimizations(context.packageName) ?: false
    }
    if (ignoringOptimizations) return
    ListDivider(CardInset)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable {
                runCatching {
                    context.startActivity(
                        Intent(
                            AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:${context.packageName}"),
                        ),
                    )
                }
            }
            .heightIn(min = TileMinHeight)
            .padding(horizontal = CardInset, vertical = 8.dp),
    ) {
        SettingsIcon(Icons.Outlined.BatteryChargingFull)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "Akku-Ausnahme erteilen",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = "Ohne die Ausnahme trennt Android die Verbindung im Doze-Modus (über Nacht). Die Ausnahme hält sie dauerhaft offen.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun UpdateBusyRow(text: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = TileMinHeight)
            .padding(horizontal = CardInset),
    ) {
        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
        Spacer(modifier = Modifier.width(12.dp))
        Text(
            text,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
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
    Spacer(modifier = Modifier.width(CardInset))
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
                style = ListItemTitle,
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
        Text(label, style = ListItemTitle, modifier = Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
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
private fun AddRow(label: String, onClick: () -> Unit, icon: ImageVector = Icons.Filled.Add) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = TileMinHeight)
            .padding(horizontal = CardInset),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(20.dp),
        )
        Spacer(modifier = Modifier.width(12.dp))
        Text(label, style = ListItemTitle, color = MaterialTheme.colorScheme.primary)
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
            .padding(horizontal = CardInset, vertical = 10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Spacer(modifier = Modifier.width(14.dp))
        Text(label, style = ListItemTitle, color = tint)
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

/** Absoluter Zeitpunkt in Lokalzeit — bei einem Absturzbericht zählt das Datum, nicht „vor 3 h". */
private fun formatCrashTime(iso: String?): String {
    if (iso == null) return "Zeitpunkt unbekannt"
    return try {
        DateTimeFormatter.ofPattern("dd.MM.yyyy, HH:mm")
            .withZone(ZoneId.systemDefault())
            .format(Instant.parse(iso))
    } catch (_: Exception) {
        iso
    }
}

/** Kompletter Report als text/plain (auf ~100 KB gekürzt) über den System-Share-Sheet. */
private fun shareCrashReport(context: Context, report: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, "PocketAgent Absturzbericht")
        putExtra(Intent.EXTRA_TEXT, truncateForShare(report))
    }
    runCatching { context.startActivity(Intent.createChooser(intent, "Absturzbericht teilen")) }
}

/* ------------------------------------------------------------------ */
/* Add/Edit secret dialog                                              */
/* ------------------------------------------------------------------ */

private const val CUSTOM_KIND = "__custom__"

@Composable
private fun SecretDialog(
    initialKind: String?,
    onDismiss: () -> Unit,
    onSave: (kind: String, value: String) -> Unit,
    onValidate: (kind: String, value: String, onResult: (Result<SecretValidation>) -> Unit) -> Unit,
) {
    var selectedKind by remember(initialKind) { mutableStateOf(initialKind) }
    // Ein halb eingetippter Zugang (nur die ART, kein Geheimnis) darf einen
    // Faltvorgang überleben.
    var customKind by rememberSaveable { mutableStateOf("") }
    // remember, NICHT rememberSaveable: der getippte Klartext-Key darf nicht ins
    // Instance-State-Bundle wandern (unverschlüsselt, überlebt auf Platte). Ihn
    // beim Falten zu verlieren ist hier das korrekte Verhalten (Fund, HOCH:
    // Secret im Klartext im SavedInstanceState).
    var value by remember { mutableStateOf("") }
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
    val selectedMeta = selectedKind?.takeIf { it != CUSTOM_KIND }?.let { metaFor(it) }
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
            // Kein eigenes verticalScroll mehr: OneUiDialog scrollt seinen
            // Textteil selbst und begrenzt ihn dabei auf den Platz, der neben
            // Titel und Aktionszeile übrig bleibt. Hier war es genau
            // andersherum — die Scrollfläche nahm sich die volle Dialoghöhe
            // und schob „Abbrechen"/„Speichern" darunter hinaus.
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
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
                        SECRET_CATALOG.forEach { meta ->
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
