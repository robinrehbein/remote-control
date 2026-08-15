package com.pocketagent.app.ui.screens

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pocketagent.app.PocketAgentApp
import com.pocketagent.app.R
import com.pocketagent.app.data.SessionInfo
import com.pocketagent.app.data.WsClient
import com.pocketagent.app.data.wireName

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    onNewSession: () -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val app = LocalContext.current.applicationContext as PocketAgentApp
    val repository = app.container.repository
    val sessions by repository.sessions.collectAsState()
    val connState by repository.connState.collectAsState()

    LaunchedEffect(Unit) { repository.refreshSessions() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.session_list_title)) },
                actions = {
                    ConnIndicator(connState)
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "Einstellungen")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onNewSession,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("Neue Session") },
            )
        },
    ) { padding ->
        if (sessions.isEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    Icons.Outlined.Terminal,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.outline,
                )
                Text(
                    text = stringResource(R.string.session_list_empty),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 12.dp, start = 32.dp, end = 32.dp),
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(sessions, key = { it.id }) { session ->
                    SessionCard(session = session, onClick = { onOpenSession(session.id) })
                }
            }
        }
    }
}

@Composable
private fun ConnIndicator(state: WsClient.ConnState) {
    val (label, color) = when (state) {
        is WsClient.ConnState.Connected -> "verbunden" to Color(0xFF22C55E)
        is WsClient.ConnState.Connecting -> "verbinde…" to Color(0xFFF59E0B)
        is WsClient.ConnState.Waiting -> "warte…" to Color(0xFFF59E0B)
        is WsClient.ConnState.Failed -> "offline" to Color(0xFFEF4444)
        WsClient.ConnState.Idle -> "offline" to Color(0xFFEF4444)
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(end = 4.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(color = color, shape = CircleShape),
        )
        Spacer(modifier = Modifier.width(4.dp))
        Text(label, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun SessionCard(session: SessionInfo, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                StatusBadge(session.status)
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    text = relativeTime(session.lastActiveAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            session.repoFullName?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(top = 8.dp),
            ) {
                InfoChip(session.adapter)
                InfoChip(session.model)
                InfoChip(session.mode.wireName())
            }
            session.prUrl?.let { url ->
                Text(
                    text = "PR: $url",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}
