package com.pocketagent.app.data

import android.content.Context
import android.util.Base64
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

private val Context.dataStore by preferencesDataStore(name = "pocket_agent")

data class DeviceSetup(
    val serverUrl: String,
    val deviceId: String,
    val deviceName: String,
    val encryptedToken: String,
)

data class DeviceCredentials(val deviceId: String, val deviceToken: String)

class TokenStore(private val context: Context) {

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val DEVICE_NAME = stringPreferencesKey("device_name")
        val DEVICE_TOKEN_ENC = stringPreferencesKey("device_token_enc")
    }

    val setup: Flow<DeviceSetup?> = context.dataStore.data.map { prefs ->
        val enc = prefs[Keys.DEVICE_TOKEN_ENC]
        if (enc == null) null
        else DeviceSetup(
            serverUrl = prefs[Keys.SERVER_URL] ?: "",
            deviceId = prefs[Keys.DEVICE_ID] ?: "",
            deviceName = prefs[Keys.DEVICE_NAME] ?: "",
            encryptedToken = enc,
        )
    }

    val deviceName: Flow<String> = context.dataStore.data.map { it[Keys.DEVICE_NAME] ?: "Android" }

    suspend fun credentials(): DeviceCredentials? {
        val s = setup.first() ?: return null
        val token = runCatching { decrypt(s.encryptedToken) }.getOrNull() ?: return null
        return DeviceCredentials(deviceId = s.deviceId, deviceToken = token)
    }

    suspend fun save(serverUrl: String, deviceId: String, deviceName: String, deviceToken: String) {
        val enc = encrypt(deviceToken)
        context.dataStore.edit { prefs ->
            prefs[Keys.SERVER_URL] = serverUrl
            prefs[Keys.DEVICE_ID] = deviceId
            prefs[Keys.DEVICE_NAME] = deviceName
            prefs[Keys.DEVICE_TOKEN_ENC] = enc
        }
    }

    suspend fun clear() {
        context.dataStore.edit { prefs ->
            prefs.remove(Keys.SERVER_URL)
            prefs.remove(Keys.DEVICE_ID)
            prefs.remove(Keys.DEVICE_NAME)
            prefs.remove(Keys.DEVICE_TOKEN_ENC)
        }
    }

    /* ---------------- Android Keystore AES-GCM ---------------- */

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val encrypted = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv + encrypted, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String {
        val all = Base64.decode(encoded, Base64.NO_WRAP)
        require(all.size > GCM_IV_BYTES) { "ciphertext too short" }
        val iv = all.copyOfRange(0, GCM_IV_BYTES)
        val ct = all.copyOfRange(GCM_IV_BYTES, all.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(ct), Charsets.UTF_8)
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "pocketagent_master"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_IV_BYTES = 12
    }
}
