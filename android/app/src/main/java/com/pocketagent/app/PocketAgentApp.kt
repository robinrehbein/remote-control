package com.pocketagent.app

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.pocketagent.app.data.AppRepository
import com.pocketagent.app.data.PairingApi
import com.pocketagent.app.data.TokenStore
import com.pocketagent.app.data.WsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class AppContainer(app: Application, scope: CoroutineScope) {
    val tokenStore = TokenStore(app)
    val pairingApi = PairingApi(PairingApi.default())
    val wsClient = WsClient(PairingApi.default())
    val repository = AppRepository(wsClient, tokenStore, scope)
}

class PocketAgentApp : Application() {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this, appScope)
        initFirebase()
        container.repository.start()
    }

    private fun initFirebase() {
        try {
            if (FirebaseApp.getApps(this).isNotEmpty()) return
            val options = FirebaseOptions.Builder()
                .setProjectId(BuildConfig.FBM_PROJECT_ID)
                .setApplicationId(BuildConfig.FBM_APPLICATION_ID)
                .setApiKey(BuildConfig.FBM_API_KEY)
                .setGcmSenderId(BuildConfig.FBM_SENDER_ID)
                .build()
            FirebaseApp.initializeApp(this, options)
        } catch (_: Exception) {
            // App works fully without Firebase push (placeholders set).
        }
    }
}
