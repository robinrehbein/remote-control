@file:OptIn(ExperimentalMaterial3Api::class)

package com.pocketagent.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Difference
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.AgentEvent
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.PermissionDecision
import com.pocketagent.app.data.SessionInfo
import com.pocketagent.app.data.SessionStatus
import com.pocketagent.app.data.wireName
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/* ------------------------------------------------------------------ */
/* Timeline model                                                      */
/* ------------------------------------------------------------------ */

sealed interface TimelineItem {
    data class Chat(
        val role: String,
        val text: String,
    ) : TimelineItem

    data class Tool(
        val id: String,
        val tool: String,
        val title: String?,
        val input: kotlinx.serialization.json.JsonElement?,
        val result: AgentEvent.ToolResult?,
    ) : TimelineItem

    data class Approval(
        val permissionId: String,
        val kind: String,
        val title: String,
        val detail: String?,
        val diff: String?,
        val resolved: PermissionDecision?,
    ) : TimelineItem

    data class TurnEnd(
        val summary: String?,
        val commitSha: String?,
    ) : TimelineItem

    data class Pushed(
        val branch: String,
        val prUrl: String?,
        val auto: Boolean,
    ) : TimelineItem

    data class Error(val message: String) : TimelineItem
}

class SessionViewModel : ViewModel() {
    lateinit var repository: AppRepository
    var sessionId: String = ""

    private val _items = MutableStateFlow<List<TimelineItem>>(emptyList())
    val items: StateFlow<List<TimelineItem>> = _items

    private val _session = MutableStateFlow<SessionInfo?>(null)
    val session: StateFlow<SessionInfo?> = _session

    private val _input = MutableStateFlow("")
    val input: StateFlow<String> = _input

    private val _deleted = MutableStateFlow(false)
    val deleted: StateFlow<Boolean> = _deleted

    fun bind(id: String, repo: AppRepository) {
        if (sessionId == id) return
        sessionId = id
        repository = repo
        viewModelScope.launch {
            repository.sessions.collect { list ->
                _session.value = list.firstOrNull { it.id == id }
            }
        }
        viewModelScope.launch {
            repository.sessionEvents.collect { envelope ->
                if (envelope.sessionId == id) applyEvent(envelope.event)
            }
        }
        viewModelScope.launch { repository.refreshSessions() }
    }

    private fun applyEvent(event: AgentEvent) {
        when (event) {
            is AgentEvent.MessageCompleted -> append(TimelineItem.Chat(event.role, event.text))

            is AgentEvent.ToolCall -> append(
                TimelineItem.Tool(
                    id = event.id,
                    tool = event.tool,
                    title = event.title,
                    input = event.input,
                    result = null,
                )
            )

            is AgentEvent.ToolResult -> {
                _items.value = _items.value.map { item ->
                    if (item is TimelineItem.Tool && item.id == event.id) item.copy(result = event) else item
                }
            }

            is AgentEvent.PermissionRequest -> append(
                TimelineItem.Approval(
                    permissionId = event.permissionId,
                    kind = event.kind.name.lowercase(),
                    title = event.title,
                    detail = event.detail,
                    diff = event.diff,
                    resolved = null,
                )
            )

            is AgentEvent.PermissionResolved -> {
                _items.value = _items.value.map { item ->
                    if (item is TimelineItem.Approval && item.permissionId == event.permissionId) {
                        item.copy(resolved = event.decision)
                    } else item
                }
            }

            is AgentEvent.TurnCompleted -> append(TimelineItem.TurnEnd(event.summary, event.commitSha))

            is AgentEvent.Pushed -> append(TimelineItem.Pushed(event.branch, event.prUrl, event.auto))

            is AgentEvent.TurnFailed -> append(TimelineItem.Error("Turn fehlgeschlagen: ${event.error}"))
            is AgentEvent.ErrorEvent -> append(TimelineItem.Error(event.message))
            is AgentEvent.Status, is AgentEvent.MessageDelta, is AgentEvent.Ping -> Unit
        }
    }

    private fun append(item: TimelineItem) {
        _items.value = _items.value + item
    }

    fun updateInput(text: String) {
        _input.value = text
    }

    fun sendPrompt() {
        val text = _input.value.trim()
        if (text.isEmpty()) return
        repository.sendPrompt(sessionId, text, null)
        _input.value = ""
        append(TimelineItem.Chat("user", text))
    }

    fun decide(permissionId: String, decision: PermissionDecision) {
        repository.sendPermission(sessionId, permissionId, decision)
        _items.value = _items.value.map { item ->
            if (item is TimelineItem.Approval && item.permissionId == permissionId && item.resolved == null) {
                item.copy(resolved = decision)
            } else item
        }
    }

    fun abort() = repository.sendAbort(sessionId)
    fun stop() = repository.sendStop(sessionId)
    fun resume() = repository.sendResume(sessionId)
    fun push() = repository.sendPush(sessionId)

    fun delete() {
        viewModelScope.launch {
            if (repository.deleteSession(sessionId)) _deleted.value = true
        }
    }
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

@Composable
fun SessionScreen(
    sessionId: String,
    onBack: () -> Unit,
    onOpenDiff: (String) -> Unit,
) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val vm: SessionViewModel = viewModel(key = "session-$sessionId") {
        SessionViewModel().also { it.bind(sessionId, repository) }
    }
    val items by vm.items.collectAsState()
    val session by vm.session.collectAsState()
    val input by vm.input.collectAsState()
    val deleted by vm.deleted.collectAsState()

    LaunchedEffect(deleted) { if (deleted) onBack() }

    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    LaunchedEffect(items.size) {
        if (items.isNotEmpty()) listState.animateScrollToItem(items.size - 1)
    }

    var menuOpen by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = session?.repoFullName ?: "Session",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        session?.let { s ->
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                StatusBadge(s.status)
                                InfoChip(s.adapter)
                                InfoChip(s.mode.wireName())
                            }
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück")
                    }
                },
                actions = {
                    IconButton(onClick = { vm.abort() }, enabled = session?.status == SessionStatus.RUNNING) {
                        Icon(Icons.Filled.Stop, contentDescription = "Abbrechen")
                    }
                    IconButton(onClick = { vm.stop() }) {
                        Icon(Icons.Filled.Pause, contentDescription = "Stoppen")
                    }
                    IconButton(onClick = { vm.resume() }) {
                        Icon(Icons.Filled.PlayArrow, contentDescription = "Fortsetzen")
                    }
                    if (session?.mode != com.pocketagent.app.data.AgentMode.YOLO) {
                        IconButton(onClick = { vm.push() }) {
                            Icon(Icons.Filled.CloudUpload, contentDescription = "Push + Draft-PR")
                        }
                    }
                    IconButton(onClick = { onOpenDiff(sessionId) }) {
                        Icon(Icons.Filled.Difference, contentDescription = "Diff")
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "Mehr")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("Session löschen") },
                                leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null) },
                                onClick = {
                                    menuOpen = false
                                    confirmDelete = true
                                },
                            )
                        }
                    }
                },
            )
        },
        bottomBar = {
            Surface(tonalElevation = 3.dp) {
                Row(
                    verticalAlignment = Alignment.Bottom,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 8.dp)
                        .navigationBarsPadding()
                        .imePadding(),
                ) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = vm::updateInput,
                        placeholder = { Text("Nachricht an den Agenten…") },
                        modifier = Modifier.weight(1f),
                        maxLines = 5,
                    )
                    IconButton(
                        onClick = { vm.sendPrompt() },
                        enabled = input.isNotBlank(),
                        modifier = Modifier.padding(start = 4.dp, bottom = 4.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Senden")
                    }
                }
            }
        },
    ) { padding ->
        if (items.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "Noch keine Ereignisse.\nSende die erste Nachricht!",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 12.dp, end = 12.dp, top = 8.dp, bottom = 16.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(items) { item -> TimelineItemView(item, vm) }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Session löschen?") },
            text = { Text("Container und Volume werden entfernt. Das kann nicht rückgängig gemacht werden.") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; vm.delete() }) { Text("Löschen") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("Abbrechen") }
            },
        )
    }
}

/* ------------------------------------------------------------------ */
/* Timeline item views                                                 */
/* ------------------------------------------------------------------ */

@Composable
private fun TimelineItemView(item: TimelineItem, vm: SessionViewModel) {
    when (item) {
        is TimelineItem.Chat -> ChatCard(item)
        is TimelineItem.Tool -> ToolCard(item)
        is TimelineItem.Approval -> ApprovalCard(item, vm)
        is TimelineItem.TurnEnd -> TurnEndSeparator(item)
        is TimelineItem.Pushed -> PushCard(item)
        is TimelineItem.Error -> ErrorCard(item)
    }
}

@Composable
private fun ChatCard(item: TimelineItem.Chat) {
    val isUser = item.role == "user"
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (isUser) Spacer(modifier = Modifier.width(32.dp))
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = if (isUser) {
                MaterialTheme.colorScheme.surfaceVariant
            } else {
                MaterialTheme.colorScheme.primaryContainer
            },
            modifier = Modifier.weight(1f),
        ) {
            Column(Modifier.padding(10.dp)) {
                Text(
                    text = if (isUser) "Du" else "Agent",
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(text = item.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 2.dp))
            }
        }
        if (!isUser) Spacer(modifier = Modifier.width(32.dp))
    }
}

@Composable
private fun ToolCard(item: TimelineItem.Tool) {
    var expanded by remember { mutableStateOf(false) }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = item.title ?: "Tool: ${item.tool}",
                    style = MaterialTheme.typography.titleMedium,
                )
                val status = when {
                    item.result == null -> "läuft…"
                    item.result.isError == true -> "Fehler"
                    else -> "ok"
                }
                Text(
                    text = "${item.tool} · $status",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { expanded = !expanded }) {
                Icon(
                    if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = if (expanded) "Einklappen" else "Ausklappen",
                )
            }
        }
        if (expanded) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                item.input?.let { input ->
                    Text(
                        text = input.toString().take(4000),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                item.result?.let { result ->
                    Text(
                        text = result.output.take(4000),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = if (result.isError == true) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ApprovalCard(item: TimelineItem.Approval, vm: SessionViewModel) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AssistChip(onClick = {}, label = { Text(item.kind) })
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = item.title,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
            }
            item.detail?.let { detail ->
                Text(
                    text = detail.take(2000),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .padding(top = 8.dp)
                        .heightIn(max = 200.dp)
                        .verticalScroll(rememberScrollState()),
                )
            }
            item.diff?.let { diff ->
                Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                ) {
                    Column(
                        modifier = Modifier
                            .heightIn(max = 300.dp)
                            .verticalScroll(rememberScrollState())
                            .padding(8.dp)
                    ) {
                        diff.lines().forEach { line -> DiffColoredLine(line = line, monospace = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
            when (item.resolved) {
                null -> Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 12.dp),
                ) {
                    OutlinedButton(onClick = { vm.decide(item.permissionId, PermissionDecision.ONCE) }) {
                        Text("Erlauben")
                    }
                    OutlinedButton(onClick = { vm.decide(item.permissionId, PermissionDecision.ALWAYS) }) {
                        Text("Immer")
                    }
                    OutlinedButton(onClick = { vm.decide(item.permissionId, PermissionDecision.REJECT) }) {
                        Text("Ablehnen")
                    }
                }

                PermissionDecision.ONCE -> ResolvedLabel("erlaubt")
                PermissionDecision.ALWAYS -> ResolvedLabel("immer erlaubt")
                PermissionDecision.REJECT -> ResolvedLabel("abgelehnt")
            }
        }
    }
}

@Composable
private fun ResolvedLabel(label: String) {
    Text(
        text = "✓ $label",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 8.dp),
    )
}

@Composable
private fun TurnEndSeparator(item: TimelineItem.TurnEnd) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(10.dp)) {
            Text(
                text = "Turn abgeschlossen",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            item.summary?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
            item.commitSha?.let { sha ->
                Text(
                    text = "Commit: ${sha.take(10)}",
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun PushCard(item: TimelineItem.Pushed) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(
                text = if (item.auto) "Automatisch gepusht" else "Gepusht",
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = item.branch,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
            item.prUrl?.let { url ->
                Text(
                    text = url,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun ErrorCard(item: TimelineItem.Error) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = item.message,
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(12.dp),
        )
    }
}
