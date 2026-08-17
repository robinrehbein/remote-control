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
import androidx.compose.runtime.saveable.rememberSaveable
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
import kotlinx.coroutines.flow.map

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
            // Intent als verarbeitet markieren: getIntent() liefert nach jeder
            // Konfigurationsänderung (Fold, Rotation, ...) weiterhin denselben
            // Intent zurück. Ohne das würde der Session-Screen bei jedem Recreate
            // erneut auf den Back-Stack gepusht.
            intent.data = null
        }
    }
}

@Composable
private fun AppRoot(deepLinkSessionId: String?, onConsumeDeepLink: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as PocketAgentApp
    // rememberSaveable statt remember: die Activity wird bei Fold/Rotation neu erzeugt
    // (siehe AndroidManifest configChanges), aber der Compose-State sonst nicht über
    // solche Recreates hinweg erhalten. Ohne das landet der Nutzer bei jedem Aufklappen
    // wieder vor dem BiometricPrompt und verliert den Nav-Stack. Übersteht keinen
    // Prozesstod — dafür bleibt paired/unlocked bewusst ungesichert (kein Secret).
    var paired by rememberSaveable { mutableStateOf<Boolean?>(null) }
    var unlocked by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        paired = app.container.tokenStore.setup.first() != null
    }

    when (paired) {
        null -> Unit
        false -> PairingScreen(onPaired = { paired = true })
        true -> {
            RequestNotificationPermission()
            // initial = null statt false: der Platzhalter vor der ersten
            // DataStore-Emission darf nicht wie "Sperre deaktiviert" aussehen
            // — sonst läuft BiometricGate synchron mit enabled=false durch
            // onUnlocked(), bevor der echte Wert (ggf. true) nachkommt, und
            // die Sperre greift beim Kaltstart nie (der guarded return in
            // BiometricGate blockt den späteren Prompt dann sogar).
            val nullableBiometricEnabled = remember(app) {
                app.container.tokenStore.biometricEnabled.map { it as Boolean? }
            }
            val biometricEnabled by nullableBiometricEnabled.collectAsState(initial = null)
            BiometricGate(enabled = biometricEnabled, unlocked = unlocked) {
                unlocked = true
            }
            if (unlocked) {
                val navController = rememberNavController()
                // Der Deep Link wird bewusst nicht mehr hier navigiert: ob
                // eine Session als eigener Screen oder als rechte Spalte
                // gehört, weiß nur der NavHost — er kennt die Fensterbreite.
                PocketAgentNavHost(
                    navController = navController,
                    deepLinkSessionId = deepLinkSessionId,
                    onConsumeDeepLink = onConsumeDeepLink,
                )
            }
        }
    }
}

/**
 * Optional app lock: when enabled in settings, require device biometrics
 * (fingerprint / face) or fallback credential before showing content.
 *
 * [enabled] is nullable on purpose: `null` means the DataStore value hasn't
 * arrived yet (the very first composition, before the first Flow emission).
 * Treating that placeholder as `false` would unlock the app before the real
 * value — possibly `true` — is known, which is exactly how the lock used to
 * be bypassed on every cold start. So `null` neither unlocks nor prompts; it
 * just waits.
 */
@Composable
private fun BiometricGate(enabled: Boolean?, unlocked: Boolean, onUnlocked: () -> Unit) {
    val context = LocalContext.current
    val activity = context as? FragmentActivity
    LaunchedEffect(enabled) {
        if (unlocked || activity == null) return@LaunchedEffect
        if (enabled == null) return@LaunchedEffect // noch nicht geladen: weder entsperren noch prompten
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
