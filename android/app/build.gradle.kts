plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.pocketagent.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pocketagent.app"
        minSdk = 26
        targetSdk = 35
        // Greenfield-Marke (GREENFIELD-PI.md): deutlicher Sprung, aber gleiche
        // applicationId und Signierung — nur so liefert der In-App-Updater das
        // Update an die installierte 0.13.0 aus.
        versionCode = 20
        versionName = "0.20.0"

        buildConfigField("String", "FBM_PROJECT_ID", "\"replace-me\"")
        buildConfigField("String", "FBM_APPLICATION_ID", "\"replace-me\"")
        buildConfigField("String", "FBM_API_KEY", "\"replace-me\"")
        buildConfigField("String", "FBM_SENDER_ID", "\"replace-me\"")
    }

    /*
     * Signierung: bevorzugt aus Secrets, sonst Fallback auf den committeden
     * Keystore (SECURITY.md, „Rotate before launch").
     *
     * Gelesen werden POCKETAGENT_KEYSTORE_FILE, POCKETAGENT_KEYSTORE_PASSWORD,
     * POCKETAGENT_KEY_ALIAS und POCKETAGENT_KEY_PASSWORD — jeweils erst als
     * Umgebungsvariable, dann als Gradle-Property. Nur wenn ALLE vier gesetzt
     * sind, wird ausschließlich damit signiert; die Keystore-Datei wird dabei
     * nicht auf Existenz geprüft (das passiert erst beim Signieren selbst,
     * damit die Konfigurationsphase nie an einer fehlenden Datei scheitert).
     *
     * Fehlt etwas, signiert der Build wie bisher mit dem committeden Keystore
     * samt Klartext-Passwörtern und warnt deutlich. Bewusst KEIN Fehlschlag:
     * der Maintainer kann die GitHub-Secrets nachziehen, ohne dass CI-Debug-
     * Builds oder Releases vorher brechen.
     */
    signingConfigs {
        create("shared") {
            fun secret(name: String): String? =
                providers.environmentVariable(name)
                    .orElse(providers.gradleProperty(name))
                    .orNull
                    ?.takeIf { it.isNotBlank() }

            val secretStoreFile = secret("POCKETAGENT_KEYSTORE_FILE")
            val secretStorePassword = secret("POCKETAGENT_KEYSTORE_PASSWORD")
            val secretKeyAlias = secret("POCKETAGENT_KEY_ALIAS")
            val secretKeyPassword = secret("POCKETAGENT_KEY_PASSWORD")

            if (secretStoreFile != null && secretStorePassword != null &&
                secretKeyAlias != null && secretKeyPassword != null
            ) {
                storeFile = File(secretStoreFile)
                storePassword = secretStorePassword
                keyAlias = secretKeyAlias
                keyPassword = secretKeyPassword
                logger.lifecycle("app: Signierung mit Keystore aus POCKETAGENT_KEYSTORE_*-Secrets.")
            } else {
                storeFile = rootProject.file("keystore/pocketagent.keystore")
                storePassword = "pocketagent-debug-2026"
                keyAlias = "pocketagent"
                keyPassword = "pocketagent-debug-2026"
                logger.warn(
                    "app: WARNUNG – POCKETAGENT_KEYSTORE_*-Variablen unvollständig oder nicht gesetzt. " +
                        "Fallback auf den UNSICHEREN committeden Keystore " +
                        "(android/keystore/pocketagent.keystore, Passwörter im Repo). " +
                        "Für verteilbare Releases ungeeignet – siehe SECURITY.md.",
                )
            }
        }
    }

    /*
     * E2E gegen einen Emulator hinter einem TLS-terminierenden Proxy braucht
     * eine App, die der Proxy-CA aus dem User-Zertifikatsspeicher vertraut.
     * Das darf nur auf ausdrückliche Anforderung passieren: das Debug-APK ist
     * laut README/RUNBOOK der Installationsweg für Endnutzer (CI-Artifact
     * `pocketagent-debug-apk`), und dort wäre User-Store-Vertrauen eine offene
     * Tür für jede eingetragene CA — MDM, VPN-App, Schadsoftware.
     *
     * Ohne den Schalter wird das Sourceset nicht eingehängt: das Manifest
     * bekommt kein networkSecurityConfig, es bleibt beim System-Speicher.
     * Weder `gradle :app:assembleDebug` noch .github/workflows/android.yml
     * setzen ihn.
     *
     * Achtung: gradleProperty liest nicht nur `-PtrustUserCerts=true` von der
     * Kommandozeile, sondern auch `gradle.properties` und
     * ORG_GRADLE_PROJECT_trustUserCerts aus der Umgebung. Der Schalter lässt
     * sich damit dauerhaft stellen — deshalb darf er nie in eine eingecheckte
     * gradle.properties wandern, und der Build meldet ihn bei jedem Lauf.
     * Als zweite, davon unabhängige Sperre liegt das User-Vertrauen in
     * <debug-overrides> und greift nur in einem debuggable APK.
     */
    if (providers.gradleProperty("trustUserCerts").orNull == "true") {
        sourceSets.getByName("debug") {
            manifest.srcFile("src/e2eTrustUserCerts/AndroidManifest.xml")
            res.srcDir("src/e2eTrustUserCerts/res")
        }
        logger.lifecycle(
            "app: Debug-Build vertraut dem User-Zertifikatsspeicher (-PtrustUserCerts=true). " +
                "applicationId com.pocketagent.app.usercatrust, versionName …-usercatrust — NICHT verteilen.",
        )
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
            // Das Ergebnis darf nicht mit dem verteilbaren Debug-APK
            // verwechselbar sein: eigene applicationId (installiert sich neben
            // der echten App statt sie zu ersetzen) und ein versionName, der
            // in „App-Info" und `adb shell dumpsys package` sofort auffällt.
            if (providers.gradleProperty("trustUserCerts").orNull == "true") {
                applicationIdSuffix = ".usercatrust"
                versionNameSuffix = "-usercatrust"
            }
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    testOptions {
        unitTests {
            isReturnDefaultValues = true
            // Robolectric braucht das gemergte Manifest und die Ressourcen
            // der App, sonst kann kein Compose-Baum aufgebaut werden.
            isIncludeAndroidResources = true
        }
    }
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material3.window.size)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.window)
    implementation(libs.material)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.biometric)
    implementation(libs.firebase.messaging)

    debugImplementation(libs.androidx.ui.tooling)
    // Liefert die ComponentActivity, in der createComposeRule() rendert.
    // debugImplementation, weil Robolectric-Unit-Tests gegen das gemergte
    // Debug-Manifest laufen — testImplementation würde nicht gemergt.
    debugImplementation(libs.androidx.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.ui.test.junit4)
}
