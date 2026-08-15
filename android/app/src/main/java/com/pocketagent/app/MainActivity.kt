package com.pocketagent.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.rememberNavController
import com.pocketagent.app.ui.PocketAgentNavHost
import com.pocketagent.app.ui.screens.PairingScreen
import com.pocketagent.app.ui.screens.RequestNotificationPermission
import com.pocketagent.app.ui.theme.PocketAgentTheme
import kotlinx.coroutines.flow.first

class MainActivity : ComponentActivity() {

    private var deepLinkSessionId by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleDeepLink(intent)
        setContent {
            PocketAgentTheme {
                AppRoot(
                    deepLinkSessionId = deepLinkSessionId,
                    onConsumeDeepLink = { deepLinkSessionId = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "pocketagent" && data.host == "session") {
            data.lastPathSegment?.let { deepLinkSessionId = it }
        }
    }
}

@Composable
private fun AppRoot(deepLinkSessionId: String?, onConsumeDeepLink: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as PocketAgentApp
    var paired by remember { mutableStateOf<Boolean?>(null) }

    LaunchedEffect(Unit) {
        paired = app.container.tokenStore.setup.first() != null
    }

    when (paired) {
        null -> Unit
        false -> PairingScreen(onPaired = { paired = true })
        true -> {
            RequestNotificationPermission()
            val navController = rememberNavController()
            LaunchedEffect(deepLinkSessionId) {
                deepLinkSessionId?.let { id ->
                    navController.navigate("session/$id")
                    onConsumeDeepLink()
                }
            }
            PocketAgentNavHost(navController = navController)
        }
    }
}
