package com.pocketagent.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.pocketagent.app.ui.screens.DiffScreen
import com.pocketagent.app.ui.screens.NewSessionScreen
import com.pocketagent.app.ui.screens.SessionListScreen
import com.pocketagent.app.ui.screens.SessionScreen
import com.pocketagent.app.ui.screens.SettingsScreen

object Routes {
    const val MAIN = "main"
    const val NEW_SESSION = "newSession"
    const val SESSION = "session/{id}"
    const val DIFF = "diff/{id}"
    const val SETTINGS = "settings"

    fun session(id: String) = "session/$id"
    fun diff(id: String) = "diff/$id"
}

@Composable
fun PocketAgentNavHost(
    navController: NavHostController,
    modifier: Modifier = Modifier,
) {
    NavHost(
        navController = navController,
        startDestination = Routes.MAIN,
        modifier = modifier,
    ) {
        composable(Routes.MAIN) {
            SessionListScreen(
                onNewSession = { navController.navigate(Routes.NEW_SESSION) },
                onOpenSession = { id -> navController.navigate(Routes.session(id)) },
                onOpenSettings = { navController.navigate(Routes.SETTINGS) },
            )
        }
        composable(Routes.NEW_SESSION) {
            NewSessionScreen(
                onCreated = { id ->
                    navController.navigate(Routes.session(id)) {
                        popUpTo(Routes.MAIN)
                    }
                },
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.SESSION) { backStack ->
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
