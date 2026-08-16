@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package com.pocketagent.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.data.SessionInfo
import com.pocketagent.app.data.SessionStatus
import com.pocketagent.app.data.WsClient
import com.pocketagent.app.data.wireName
import com.pocketagent.app.ui.theme.CardInset
import com.pocketagent.app.ui.theme.PillShape
import com.pocketagent.app.ui.theme.PrimaryButtonHeight
import com.pocketagent.app.ui.theme.ScreenGutter
import com.pocketagent.app.ui.theme.TileMinHeight
import kotlinx.coroutines.launch

/**
 * Wie weit gewischt werden muss, bevor die Geste zählt — bewusst über der
 * Hälfte der Zeilenbreite. Ein Antippen oder ein schräges Scrollen federt
 * darum folgenlos zurück.
 */
private const val SwipeThreshold = 0.55f

/** Divider-Einzug der Menüzeilen im Aktions-Sheet: Karteninnenrand + Icon + Abstand. */
private val SheetRowDividerInset = 50.dp

@Composable
fun SessionListScreen(
    onNewSession: () -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val allSessions by repository.sessions.collectAsState()
    val connState by repository.connState.collectAsState()
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    val uriHandler = LocalUriHandler.current

    val active = remember(allSessions) { activeSessions(allSessions) }
    val archived = remember(allSessions) { archivedSessions(allSessions) }

    var archiveOpen by remember { mutableStateOf(false) }
    // Sheets und Dialoge halten nur die Id — die Session selbst kommt immer
    // frisch aus dem Flow, damit ein Statuswechsel sofort durchschlägt.
    var menuFor by remember { mutableStateOf<String?>(null) }
    var renameFor by remember { mutableStateOf<String?>(null) }
    var deleteFor by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { repository.refreshSessions() }
    // Ist das Archiv leer, gibt es nichts aufzuklappen.
    LaunchedEffect(archived.isEmpty()) { if (archived.isEmpty()) archiveOpen = false }

    /**
     * Archivieren bzw. Zurückholen mit Rückgängig-Angebot. Beides ist
     * gefahrlos: der Arbeitsstand bleibt in jedem Fall erhalten.
     */
    fun setArchived(session: SessionInfo, archive: Boolean) {
        scope.launch {
            val result = repository.setArchived(session.id, archive)
            if (result.isFailure) {
                snackbarHostState.showSnackbar(
                    if (archive) "Archivieren fehlgeschlagen" else "Wiederherstellen fehlgeschlagen",
                )
                return@launch
            }
            val choice = snackbarHostState.showSnackbar(
                message = archiveDoneLabel(archive),
                actionLabel = "Rückgängig",
                duration = SnackbarDuration.Short,
            )
            if (choice == SnackbarResult.ActionPerformed) {
                repository.setArchived(session.id, !archive)
            }
        }
    }

    fun deleteNow(sessionId: String) {
        scope.launch {
            if (!repository.deleteSession(sessionId)) {
                snackbarHostState.showSnackbar("Löschen fehlgeschlagen – keine Verbindung?")
            }
        }
    }

    OneUiScaffold(
        title = "PocketAgent",
        actions = {
            IconButton(onClick = onOpenSettings) {
                Icon(Icons.Outlined.Settings, contentDescription = "Einstellungen")
            }
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onNewSession) {
                Icon(Icons.Filled.Add, contentDescription = "Neue Session")
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            // Connection chrome only when it is actually worth knowing.
            // Ein Tap darauf holt den nächsten Versuch nach vorn.
            AnimatedVisibility(
                visible = connState !is WsClient.ConnState.Connected,
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                ConnectionLine(state = connState, onReconnect = { repository.reconnectNow() })
            }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    refreshing = true
                    scope.launch {
                        repository.refreshSessions()
                        refreshing = false
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                LaunchedEffect(allSessions) { refreshing = false }
                if (allSessions.isEmpty()) {
                    EmptySessions(onNewSession)
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(
                            start = ScreenGutter,
                            end = ScreenGutter,
                            top = 8.dp,
                            bottom = 96.dp,
                        ),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        if (active.isEmpty()) {
                            item(key = "no-active") {
                                Text(
                                    text = "Keine aktiven Sessions – alles liegt im Archiv.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(horizontal = CardInset, vertical = 12.dp),
                                )
                            }
                        }
                        items(active, key = { it.id }) { session ->
                            SwipeableSessionRow(
                                session = session,
                                onArchiveSwipe = { setArchived(session, true) },
                                onDeleteSwipe = { deleteFor = session.id },
                            ) {
                                SessionCard(
                                    session = session,
                                    onClick = { onOpenSession(session.id) },
                                    onLongClick = { menuFor = session.id },
                                )
                            }
                        }
                        if (archived.isNotEmpty()) {
                            item(key = "archive-toggle") {
                                ArchiveRow(
                                    count = archived.size,
                                    expanded = archiveOpen,
                                    onToggle = { archiveOpen = !archiveOpen },
                                )
                            }
                            if (archiveOpen) {
                                // Eigener Key-Namensraum: eine Session, die gerade
                                // die Sektion wechselt, startet hier mit frischer
                                // Wisch-Position statt in der alten stecken zu bleiben.
                                items(archived, key = { "archived-" + it.id }) { session ->
                                    SwipeableSessionRow(
                                        session = session,
                                        onArchiveSwipe = { setArchived(session, false) },
                                        onDeleteSwipe = { deleteFor = session.id },
                                    ) {
                                        SessionCard(
                                            session = session,
                                            onClick = { onOpenSession(session.id) },
                                            onLongClick = { menuFor = session.id },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    allSessions.firstOrNull { it.id == menuFor }?.let { session ->
        SessionActionSheet(
            session = session,
            onDismiss = { menuFor = null },
            onAction = { action ->
                menuFor = null
                when (action) {
                    SessionAction.RENAME -> renameFor = session.id
                    SessionAction.ARCHIVE -> setArchived(session, true)
                    SessionAction.UNARCHIVE -> setArchived(session, false)
                    SessionAction.STOP -> repository.sendStop(session.id)
                    SessionAction.RESUME -> repository.sendResume(session.id)
                    SessionAction.PUSH -> repository.sendPush(session.id)
                    SessionAction.OPEN_PR -> session.prUrl?.let { uriHandler.openUri(it) }
                    SessionAction.DELETE -> deleteFor = session.id
                }
            },
        )
    }

    allSessions.firstOrNull { it.id == renameFor }?.let { session ->
        RenameDialog(
            session = session,
            onDismiss = { renameFor = null },
            onSave = { name ->
                renameFor = null
                scope.launch {
                    if (repository.renameSession(session.id, name).isFailure) {
                        snackbarHostState.showSnackbar("Umbenennen fehlgeschlagen")
                    }
                }
            },
        )
    }

    allSessions.firstOrNull { it.id == deleteFor }?.let { session ->
        AlertDialog(
            onDismissRequest = { deleteFor = null },
            title = { Text("„${sessionDisplayName(session)}“ löschen?") },
            text = { Text(deleteConfirmText(session)) },
            confirmButton = {
                TextButton(onClick = {
                    deleteFor = null
                    deleteNow(session.id)
                }) {
                    Text("Löschen", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteFor = null }) { Text("Abbrechen") }
            },
        )
    }
}

/* ------------------------------------------------------------------ */
/* Wischen                                                             */
/* ------------------------------------------------------------------ */

/**
 * Eine Zeile mit beiden Wischrichtungen, wie in Samsung Mail:
 *
 * - **rechts nach links** archiviert (im Archiv: holt zurück). Das ist
 *   umkehrbar, passiert darum sofort und meldet sich per Snackbar mit
 *   „Rückgängig“.
 * - **links nach rechts** löscht. Weil dabei Verlauf und Arbeitsstand
 *   endgültig verschwinden, führt der Wisch die Aktion nicht aus, sondern
 *   fragt: die Zeile federt zurück, der Bestätigungsdialog kommt.
 */
@Composable
private fun SwipeableSessionRow(
    session: SessionInfo,
    onArchiveSwipe: () -> Unit,
    onDeleteSwipe: () -> Unit,
    content: @Composable () -> Unit,
) {
    val archiveAction by rememberUpdatedState(onArchiveSwipe)
    val deleteAction by rememberUpdatedState(onDeleteSwipe)
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            when (value) {
                SwipeToDismissBoxValue.EndToStart -> {
                    archiveAction()
                    true
                }

                SwipeToDismissBoxValue.StartToEnd -> {
                    deleteAction()
                    false
                }

                SwipeToDismissBoxValue.Settled -> true
            }
        },
        positionalThreshold = { distance -> distance * SwipeThreshold },
    )
    SwipeToDismissBox(
        state = state,
        backgroundContent = {
            SwipeBackground(direction = state.dismissDirection, archived = session.archived)
        },
        content = { content() },
    )
}

/**
 * Der Grund unter der Zeile: links das Löschen in der Fehlerfarbe, rechts
 * das Archivieren im ruhigen Primärton. Das Icon steht immer auf der
 * Seite, aus der gewischt wird.
 */
@Composable
private fun SwipeBackground(direction: SwipeToDismissBoxValue, archived: Boolean) {
    if (direction == SwipeToDismissBoxValue.Settled) return
    val deleting = direction == SwipeToDismissBoxValue.StartToEnd
    val background = if (deleting) {
        MaterialTheme.colorScheme.error
    } else {
        MaterialTheme.colorScheme.primaryContainer
    }
    val foreground = if (deleting) {
        MaterialTheme.colorScheme.onError
    } else {
        MaterialTheme.colorScheme.onPrimaryContainer
    }
    val icon = when {
        deleting -> Icons.Outlined.Delete
        archiveSwipeArchives(archived) -> Icons.Outlined.Archive
        else -> Icons.Outlined.Unarchive
    }
    val label = if (deleting) "Löschen" else archiveSwipeLabel(archived)
    Box(
        modifier = Modifier
            .fillMaxSize()
            .clip(MaterialTheme.shapes.large)
            .background(background)
            .padding(horizontal = 22.dp),
        contentAlignment = if (deleting) Alignment.CenterStart else Alignment.CenterEnd,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (deleting) {
                Icon(icon, contentDescription = label, tint = foreground, modifier = Modifier.size(22.dp))
                Spacer(modifier = Modifier.width(10.dp))
                SwipeLabel(label, foreground)
            } else {
                SwipeLabel(label, foreground)
                Spacer(modifier = Modifier.width(10.dp))
                Icon(icon, contentDescription = label, tint = foreground, modifier = Modifier.size(22.dp))
            }
        }
    }
}

@Composable
private fun SwipeLabel(text: String, color: Color) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        color = color,
        maxLines = 1,
    )
}

/* ------------------------------------------------------------------ */
/* Liste                                                               */
/* ------------------------------------------------------------------ */

@Composable
private fun EmptySessions(onNewSession: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 40.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Surface(
            shape = CircleShape,
            color = MaterialTheme.colorScheme.primaryContainer,
            modifier = Modifier.size(76.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    Icons.Outlined.SmartToy,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(36.dp),
                )
            }
        }
        Text(
            text = "Noch keine Session",
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 20.dp),
        )
        Text(
            text = "Wähle ein Repository und einen Agenten – ab dann arbeitest du vom Telefon aus: " +
                "Aufgabe stellen, Rückfragen beantworten, Diff prüfen, pushen.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp),
        )
        Button(
            onClick = onNewSession,
            shape = PillShape,
            modifier = Modifier
                .padding(top = 24.dp)
                .height(PrimaryButtonHeight),
        ) {
            Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(modifier = Modifier.width(8.dp))
            Text("Erste Session starten")
        }
    }
}

/**
 * Eine Session in der Liste. Der Name ist der Titel, wenn es einen gibt —
 * das Repository rutscht dann in die zweite Zeile zur Zeitangabe.
 * Langes Drücken öffnet das Aktions-Sheet, spürbar bestätigt.
 */
@Composable
private fun SessionCard(
    session: SessionInfo,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val second = listOfNotNull(
        sessionSubtitle(session),
        if (session.status == SessionStatus.CREATING) {
            "Container wird gestartet …"
        } else {
            relativeTime(session.lastActiveAt)
        },
    ).joinToString(" · ")
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .combinedClickable(
                onClick = onClick,
                onLongClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onLongClick()
                },
                onLongClickLabel = "Aktionen für diese Session",
            ),
    ) {
        Column(Modifier.padding(horizontal = 18.dp, vertical = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = sessionDisplayName(session),
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = second,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Spacer(modifier = Modifier.width(10.dp))
                StatusBadge(status = session.status)
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(top = 10.dp),
            ) {
                InfoChip(session.adapter)
                InfoChip(session.mode.wireName())
                session.networkPolicy
                    ?.takeIf { it != "allowlist" }
                    ?.let { policy -> InfoChip(networkPolicyLabel(policy)) }
            }
            if (session.prUrl != null) {
                Text(
                    text = "Pull Request offen",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 10.dp),
                )
            }
        }
    }
}

/**
 * Das Archiv am Listenende: eine Zeile, die aufklappt. Kein zweiter
 * Screen — archivierte Sessions bleiben genau eine Berührung entfernt.
 */
@Composable
private fun ArchiveRow(count: Int, expanded: Boolean, onToggle: () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier
            .padding(top = 6.dp)
            .fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggle)
                .heightIn(min = TileMinHeight)
                .padding(horizontal = 18.dp),
        ) {
            Icon(
                Icons.Outlined.Archive,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
            Spacer(modifier = Modifier.width(14.dp))
            Text(
                text = "Archiv ($count)",
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.weight(1f),
            )
            Icon(
                if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                contentDescription = if (expanded) "Archiv einklappen" else "Archiv ausklappen",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/* ------------------------------------------------------------------ */
/* Kontextmenü und Umbenennen                                          */
/* ------------------------------------------------------------------ */

private fun sessionActionIcon(action: SessionAction): ImageVector = when (action) {
    SessionAction.RENAME -> Icons.Outlined.DriveFileRenameOutline
    SessionAction.ARCHIVE -> Icons.Outlined.Archive
    SessionAction.UNARCHIVE -> Icons.Outlined.Unarchive
    SessionAction.STOP -> Icons.Outlined.StopCircle
    SessionAction.RESUME -> Icons.Outlined.PlayArrow
    SessionAction.PUSH -> Icons.Outlined.CloudUpload
    SessionAction.OPEN_PR -> Icons.AutoMirrored.Outlined.OpenInNew
    SessionAction.DELETE -> Icons.Outlined.Delete
}

/**
 * Das Kontextmenü als Bottom Sheet — auf großen Displays erreichbar,
 * statt als winziges Dropdown am oberen Rand zu kleben. Welche Einträge
 * erscheinen, entscheidet [sessionActions].
 */
@Composable
private fun SessionActionSheet(
    session: SessionInfo,
    onDismiss: () -> Unit,
    onAction: (SessionAction) -> Unit,
) {
    SettingSheet(title = sessionDisplayName(session), onDismiss = onDismiss) {
        GroupCard {
            Column {
                sessionActions(session).forEachIndexed { index, action ->
                    if (index > 0) ListDivider(startInset = SheetRowDividerInset)
                    SessionActionRow(action = action, onClick = { onAction(action) })
                }
            }
        }
    }
}

@Composable
private fun SessionActionRow(action: SessionAction, onClick: () -> Unit) {
    val destructive = action == SessionAction.DELETE
    val tint = if (destructive) {
        MaterialTheme.colorScheme.error
    } else {
        MaterialTheme.colorScheme.onSurface
    }
    val note = sessionActionNote(action)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = TileMinHeight)
            .padding(horizontal = CardInset, vertical = 10.dp),
    ) {
        Icon(
            sessionActionIcon(action),
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(20.dp),
        )
        Spacer(modifier = Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = sessionActionLabel(action),
                style = MaterialTheme.typography.bodyLarge,
                color = tint,
            )
            if (note != null) {
                Text(
                    text = note,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * Umbenennen. Vorbelegt mit dem aktuellen Titel; ein leeres Feld nimmt
 * ihn wieder weg, danach steht wieder das Repository in der Liste.
 */
@Composable
private fun RenameDialog(
    session: SessionInfo,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var text by remember(session.id) { mutableStateOf(session.title.orEmpty()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Session umbenennen") },
        text = {
            Column {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    label = { Text("Name") },
                    placeholder = { Text(session.repoFullName ?: "Session") },
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        imeAction = ImeAction.Done,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    text = "Leer lassen entfernt den Titel – dann steht wieder das Repository in der Liste.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(text.trim()) }) { Text("Speichern") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Abbrechen") }
        },
    )
}

/** Shared wording for the non-default network policies. */
fun networkPolicyLabel(policy: String): String = when (policy) {
    "open" -> "Netz: offen"
    "isolated" -> "Netz: isoliert"
    else -> "Netz: $policy"
}
