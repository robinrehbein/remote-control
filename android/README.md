# PocketAgent – Android-App

Android-Client (Kotlin + Jetpack Compose) für den PocketAgent-Orchestrator.
Steht per WebSocket mit dem Orchestrator in Verbindung, verwaltet
Coding-Agent-Sessions (kilo, claude, pi, junie) in Docker-Containern und
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

#### E2E hinter einem TLS-terminierenden Proxy

Ab Android 7 vertrauen Apps nur dem System-Zertifikatsspeicher. Wer auf einem
Emulator hinter einem abfangenden Proxy testet (CI, Firmen-Proxy), bekommt die
Proxy-CA ohne beschreibbare `/system`-Partition nur in den User-Store — und die
App ignoriert sie, was sich wie ein kaputter Server liest.

```bash
gradle :app:assembleDebug --no-daemon -PtrustUserCerts=true
```

Nur dann hängt sich `app/src/e2eTrustUserCerts/` in den Debug-Build ein. Das
Ergebnis ist absichtlich unterscheidbar: applicationId
`com.pocketagent.app.usercatrust`, versionName mit Suffix `-usercatrust`, und
der Build sagt es bei jedem Lauf in der Konsole.

**Dieses APK nie verteilen.** Das gewöhnliche Debug-APK ist der
Installationsweg für Endnutzer (CI-Artifact `pocketagent-debug-apk`); mit
User-Store-Vertrauen könnte dort jede eingetragene CA — MDM-Profil, VPN-App,
Schadsoftware — den Device-Token aus dem Pairing und den gesamten
`wss://`-Verkehr mitlesen.

Zwei unabhängige Sperren verhindern das:

1. Ohne den Schalter existiert das Sourceset für den Build nicht — weder lokal
   noch in `.github/workflows/android.yml`. Der Schalter wirkt allerdings auch
   aus `gradle.properties` oder `ORG_GRADLE_PROJECT_trustUserCerts`, gehört
   also **nie** in eine eingecheckte Datei.
2. Das User-Vertrauen steht in `<debug-overrides>`. Diesen Block wertet Android
   nur in einem APK mit `android:debuggable="true"` aus — in einem
   Release-Build wäre die Datei wirkungslos statt gefährlich.

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

## Sicherheit

Siehe [../SECURITY.md](../SECURITY.md) für die vollständige Security-Policy und
Known Limitations. Wichtig: der committete Keystore
(`android/keystore/pocketagent.keystore`) ist debug-gradig und wird über alle
CI-Builds geteilt – er muss vor jeder öffentlichen Verteilung rotiert werden
(„Rotate before launch“ in SECURITY.md).
