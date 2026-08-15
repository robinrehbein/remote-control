# PocketAgent – Android-App

Android-Client (Kotlin + Jetpack Compose) für den PocketAgent-Orchestrator.
Steht per WebSocket mit dem Orchestrator in Verbindung, verwaltet
Coding-Agent-Sessions (opencode, claude, pi, junie) in Docker-Containern und
zeigt die normalisierte Event-Timeline (Chat, Tools, Approvals, Diffs, Push/PRs).

## Architektur

```
app/src/main/java/com/pocketagent/app/
├── PocketAgentApp.kt        Application + AppContainer (DI ohne Hilt), Firebase-Init (manuell)
├── MainActivity.kt          Einstieg, NavHost-Gate (paired/unpaired), Deep-Links pocketagent://session/<id>
├── data/
│   ├── Protocol.kt          Alle Contract-Typen (packages/protocol), manueller JSON-Decode/Encode
│   ├── TokenStore.kt        DataStore + Android-Keystore AES-GCM (deviceToken verschlüsselt)
│   ├── PairingApi.kt        POST /api/pairing/confirm, URL-Normalisierung, WS-URL
│   ├── WsClient.kt          OkHttp-WebSocket, hello, StateFlow<ConnState>, Backoff 1s–60s + Jitter
│   └── AppRepository.kt     StateFlows (sessions/repos/secrets/stats), request/response über
│                            requestId + CompletableDeferred (Timeout 15 s), FCM-Register
├── fcm/PocketFcmService.kt  FCM → Notification (Channel "sessions") + Deep-Link + fcm.register
└── ui/
    ├── Nav.kt               NavHost: main → newSession → session/{id} → diff/{id}, settings
    ├── theme/Theme.kt       Material3, dynamische Farben ab Android 12
    └── screens/             Pairing, SessionList, NewSession, Session (Timeline/Approvals),
                             Diff, Settings (Stats, Secrets, Logout) – je ViewModel (StateFlow)
```

Protokoll-Details: siehe `packages/protocol/src/index.ts` im Repo-Root.
Die App verbindet sich nach erfolgreichem Pairing mit `{serverUrl}/ws` (konvertiert
http→ws / https→wss) und sendet zuerst `hello {deviceId, token}`.

## Build

### Voraussetzungen

- JDK 17
- Gradle 8.11 (CI installiert ihn via `gradle/actions/setup-gradle@v4`; lokal:
  `sdkman install gradle 8.11` oder Wrapper ergänzen)
- Android SDK, compileSdk 35 (minSdk 26, targetSdk 35)

### Lokal

```bash
cd android
gradle :app:assembleDebug --no-daemon        # APK: app/build/outputs/apk/debug/app-debug.apk
gradle :app:testDebugUnitTest --no-daemon    # Unit-Tests (Protocol- & Pairing-Decoder)
```

Release-Build ist unsigned (`assembleRelease`), Signing muss selbst ergänzt werden.

### CI (GitHub Actions)

Der Workflow liegt im Repo-Root unter `.github/workflows/android.yml` und ist direkt aktiv.

Der Workflow baut das Debug-APK, führt die Unit-Tests aus und lädt das APK als
Artifact hoch (`pocketagent-debug-apk`).

## Pairing

1. Orchestrator starten, Pairing-Code erzeugen: `npm run pair` (8 Zeichen, TTL 10 min)
2. App öffnen → Server-URL, Code, Gerätename eingeben → „Koppeln“
3. App speichert `deviceId` + verschlüsseltes `deviceToken` (AES-GCM, Key
   `pocketagent_master` im Android-Keystore; Backup-Regeln schließen die Tokens aus)

## Firebase (optional, für Push)

Ohne Firebase-Konfiguration läuft die App normal (kein Push). Für echtes FCM:

1. Firebase-Projekt anlegen, Android-App mit `com.pocketagent.app` registrieren
2. Werte in `app/build.gradle.kts` überschreiben (oder aus CI-Env injecten):
   `FBM_PROJECT_ID`, `FBM_APPLICATION_ID`, `FBM_API_KEY`, `FBM_SENDER_ID`
3. Server-Seite: FCM-Server-Key hinterlegen; App registriert sich nach Token-Erhalt
   mit `{type: "fcm.register", token}`; Push-Payload: `sessionId`, `title`, `body`,
   `eventType` → Notification mit Deep-Link `pocketagent://session/<sessionId>`

## Tests

- `ProtocolDecodeTest`: ServerMessage-Decode (session.event/tool.call, request.ok,
  session.list) inkl. unbekannter Felder
- `PairingDecodeTest`: Pairing-Response, URL/WS-Normalisierung
