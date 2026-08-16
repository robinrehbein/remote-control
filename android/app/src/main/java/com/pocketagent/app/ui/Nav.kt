package com.pocketagent.app.ui

// slideIntoContainer/slideOutOfContainer sind Member von
// AnimatedContentTransitionScope und werden über den Receiver aufgelöst — ein
// Top-Level-Import darauf existiert nicht und bricht den Build.
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import com.pocketagent.app.ui.screens.DiffScreen
import com.pocketagent.app.ui.screens.NewSessionScreen
import com.pocketagent.app.ui.screens.SessionListDetail
import com.pocketagent.app.ui.screens.SessionListScreen
import com.pocketagent.app.ui.screens.SessionScreen
import com.pocketagent.app.ui.screens.SettingsScreen
import com.pocketagent.app.ui.theme.MotionMedium
import com.pocketagent.app.ui.theme.OneUiEasing

object Routes {
    const val MAIN = "main"
    const val NEW_SESSION = "newSession"
    const val SESSION = "session/{id}"
    const val DIFF = "diff/{id}"
    const val SETTINGS = "settings"

    fun session(id: String) = "session/$id"
    fun diff(id: String) = "diff/$id"
}

/*
 * One UI Basic Motion (one-ui/motion/basic): Ortswechsel-Übergänge (Screenwechsel)
 * "should never exceed 500 ms" — wir nutzen dafür MotionMedium (400 ms). Die
 * dokumentierte Kurve gilt für die Bewegung (Slide); Transparenz-Übergänge
 * (Fade) bekommen dort ausdrücklich Linear zugewiesen, nicht die Basiskurve.
 */
private fun AnimatedContentTransitionScope<NavBackStackEntry>.pushEnter() =
    slideIntoContainer(
        AnimatedContentTransitionScope.SlideDirection.Left,
        animationSpec = tween(MotionMedium, easing = OneUiEasing),
    ) + fadeIn(animationSpec = tween(MotionMedium, easing = LinearEasing))

private fun AnimatedContentTransitionScope<NavBackStackEntry>.pushExit() =
    slideOutOfContainer(
        AnimatedContentTransitionScope.SlideDirection.Left,
        animationSpec = tween(MotionMedium, easing = OneUiEasing),
    ) + fadeOut(animationSpec = tween(MotionMedium, easing = LinearEasing))

private fun AnimatedContentTransitionScope<NavBackStackEntry>.popEnter() =
    slideIntoContainer(
        AnimatedContentTransitionScope.SlideDirection.Right,
        animationSpec = tween(MotionMedium, easing = OneUiEasing),
    ) + fadeIn(animationSpec = tween(MotionMedium, easing = LinearEasing))

private fun AnimatedContentTransitionScope<NavBackStackEntry>.popExit() =
    slideOutOfContainer(
        AnimatedContentTransitionScope.SlideDirection.Right,
        animationSpec = tween(MotionMedium, easing = OneUiEasing),
    ) + fadeOut(animationSpec = tween(MotionMedium, easing = LinearEasing))

/**
 * Die Dauerziele der App. Drei Stück — zu wenig für eine Tab-Leiste unten
 * (One UI: „has to display less than 4"), aber genug, damit auf einem breiten
 * Fenster eine Rail sichtbar bleibt: „By keeping the menu on the screen all
 * the time, users are able see more and navigate quickly without switching
 * screens."
 */
private data class RailTarget(
    val route: String,
    val label: String,
    val icon: ImageVector,
)

private val RailTargets = listOf(
    RailTarget(Routes.MAIN, "Sessions", Icons.Outlined.SmartToy),
    RailTarget(Routes.NEW_SESSION, "Neu", Icons.Filled.Add),
    RailTarget(Routes.SETTINGS, "Einstellungen", Icons.Outlined.Settings),
)

@Composable
fun PocketAgentNavHost(
    navController: NavHostController,
    modifier: Modifier = Modifier,
) {
    val widthDp = LocalConfiguration.current.screenWidthDp
    val widthClass = widthClassFor(widthDp)
    val foldedVertically by rememberVerticalFold()
    val currentRoute = navController.currentBackStackEntryAsState().value?.destination?.route

    Row(modifier = modifier.fillMaxSize()) {
        // Erst ab Medium. Auf einem Telefon nähme die Rail Breite weg, die
        // der Inhalt braucht, und One UI sieht sie dort auch nicht vor.
        if (widthClass != WidthClass.COMPACT) {
            NavigationRail(containerColor = MaterialTheme.colorScheme.background) {
                RailTargets.forEach { target ->
                    NavigationRailItem(
                        selected = currentRoute == target.route,
                        onClick = {
                            if (currentRoute != target.route) {
                                navController.navigate(target.route) {
                                    // Kein Stapel aus Dauerzielen: zurück
                                    // führt immer zur Liste, nicht durch die
                                    // Besuchsreihenfolge der Rail.
                                    popUpTo(Routes.MAIN) {
                                        inclusive = target.route == Routes.MAIN
                                    }
                                    launchSingleTop = true
                                }
                            }
                        },
                        icon = { Icon(target.icon, contentDescription = null) },
                        label = { Text(target.label) },
                    )
                }
            }
        }
        NavHost(
            navController = navController,
            startDestination = Routes.MAIN,
            modifier = Modifier.fillMaxSize(),
            enterTransition = { pushEnter() },
            exitTransition = { pushExit() },
            popEnterTransition = { popEnter() },
            popExitTransition = { popExit() },
        ) {
            composable(Routes.MAIN) {
                if (usesTwoPanes(widthClass)) {
                    SessionListDetail(
                        listFraction = listPaneFraction(widthDp, foldedVertically),
                        onNewSession = { navController.navigate(Routes.NEW_SESSION) },
                        onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                        onOpenDiff = { sid -> navController.navigate(Routes.diff(sid)) },
                    )
                } else {
                    SessionListScreen(
                        onNewSession = { navController.navigate(Routes.NEW_SESSION) },
                        onOpenSession = { id -> navController.navigate(Routes.session(id)) },
                        onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                    )
                }
            }
            composable(Routes.NEW_SESSION) {
                NewSessionScreen(
                    onCreated = { id ->
                        navController.navigate(Routes.session(id)) {
                            popUpTo(Routes.MAIN)
                        }
                    },
                    onBack = { navController.popBackStack() },
                    onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                )
            }
            composable(
                Routes.SESSION,
                enterTransition = {
                    // NEW_SESSION -> SESSION nutzt popUpTo(MAIN): fachlich ein Replace,
                    // kein Vorwärts-Push (der Nutzer "bewegt" sich nicht tiefer, die
                    // Sitzung ersetzt nur den Erstellungs-Dialog). Ein horizontaler
                    // Slide würde hier fälschlich Vorwärtsbewegung suggerieren, darum
                    // nur ein Fade. Alle anderen Wege zu SESSION (z. B. von MAIN aus)
                    // sind echte Pushes und behalten den Slide.
                    if (initialState.destination.route == Routes.NEW_SESSION) {
                        fadeIn(animationSpec = tween(MotionMedium, easing = LinearEasing))
                    } else {
                        pushEnter()
                    }
                },
                // composable() lässt popEnterTransition sonst auf enterTransition
                // zurückfallen (siehe Navigation-Compose-Default) — ohne diese explizite
                // Angabe würde auch das Zurück-Wischen von Diff nach Session fälschlich
                // die Fade/Push-Verzweigung oben statt des normalen Pop-Reveals nutzen.
                popEnterTransition = { popEnter() },
            ) { backStack ->
                val id = backStack.arguments?.getString("id").orEmpty()
                SessionScreen(
                    sessionId = id,
                    onBack = { navController.popBackStack() },
                    onOpenDiff = { sid -> navController.navigate(Routes.diff(sid)) },
                )
            }
            composable(Routes.DIFF) { backStack ->
                val id = backStack.arguments?.getString("id").orEmpty()
                DiffScreen(
                    sessionId = id,
                    onBack = { navController.popBackStack() },
                )
            }
            composable(Routes.SETTINGS) {
                SettingsScreen(onBack = { navController.popBackStack() })
            }
        }
    }
}
