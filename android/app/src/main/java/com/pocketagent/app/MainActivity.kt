package com.pocketagent.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.navigation.compose.rememberNavController
import com.pocketagent.app.ui.PocketAgentNavHost
import com.pocketagent.app.ui.screens.PairingScreen
import com.pocketagent.app.ui.screens.RequestNotificationPermission
import com.pocketagent.app.ui.theme.PocketAgentTheme
import kotlinx.coroutines.flow.first

class MainActivity : FragmentActivity() {

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
    var unlocked by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        paired = app.container.tokenStore.setup.first() != null
    }

    when (paired) {
        null -> Unit
        false -> PairingScreen(onPaired = { paired = true })
        true -> {
            RequestNotificationPermission()
            val biometricEnabled by app.container.tokenStore.biometricEnabled.collectAsState(initial = false)
            BiometricGate(enabled = biometricEnabled, unlocked = unlocked) {
                unlocked = true
            }
            if (unlocked) {
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
}

/**
 * Optional app lock: when enabled in settings, require device biometrics
 * (fingerprint / face) or fallback credential before showing content.
 */
@Composable
private fun BiometricGate(enabled: Boolean, unlocked: Boolean, onUnlocked: () -> Unit) {
    val context = LocalContext.current
    val activity = context as? FragmentActivity
    LaunchedEffect(enabled) {
        if (unlocked || activity == null) return@LaunchedEffect
        if (!enabled) {
            onUnlocked() // lock disabled: show content immediately
            return@LaunchedEffect
        }
        val manager = BiometricManager.from(context)
        val canAuth = manager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        )
        if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
            onUnlocked() // device without biometrics: don't lock the user out
            return@LaunchedEffect
        }
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(context),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    onUnlocked()
                }

                override fun onAuthenticationError(code: Int, msg: CharSequence) {
                    if (code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                        code == BiometricPrompt.ERROR_USER_CANCELED
                    ) {
                        activity.finish()
                    } else {
                        onUnlocked()
                    }
                }
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("PocketAgent entsperren")
                .setSubtitle("Deine Agenten sind durch die Gerätesperre geschützt")
                .setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_WEAK or
                        BiometricManager.Authenticators.DEVICE_CREDENTIAL
                )
                .build()
        )
    }
}
