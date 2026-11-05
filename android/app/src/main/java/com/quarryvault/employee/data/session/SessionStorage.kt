package com.quarryvault.employee.data.session

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import javax.crypto.KeyGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

interface SessionStorage {
    fun saveSession(accessToken: String, refreshToken: String?, email: String?)
    fun saveSession(accessToken: String, refreshToken: String?, email: String?, sessionId: String?)
    fun getAccessToken(): String?
    fun getRefreshToken(): String?
    fun getEmail(): String?
    fun getUsername(): String?
    fun getSessionId(): String?
    fun clearSession()
    fun hasActiveSession(): Boolean = getAccessToken() != null
}

class InMemorySessionStorage : SessionStorage {
    private var accessToken: String? = null
    private var refreshToken: String? = null
    private var email: String? = null
    private var username: String? = null
    private var sessionId: String? = null

    override fun saveSession(accessToken: String, refreshToken: String?, email: String?) {
        saveSession(accessToken, refreshToken, email, null)
    }

    override fun saveSession(accessToken: String, refreshToken: String?, email: String?, sessionId: String?) {
        this.accessToken = accessToken
        this.refreshToken = refreshToken
        this.email = email
        this.username = email
        this.sessionId = sessionId
    }

    override fun getAccessToken(): String? = accessToken
    override fun getRefreshToken(): String? = refreshToken
    override fun getEmail(): String? = email
    override fun getUsername(): String? = username ?: email
    override fun getSessionId(): String? = sessionId

    override fun clearSession() {
        accessToken = null
        refreshToken = null
        email = null
        username = null
        sessionId = null
    }
}

internal fun interface SessionKeyProvider {
    fun getOrCreateKey(): SecretKey
}

internal class AndroidKeystoreSessionKeyProvider : SessionKeyProvider {
    override fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEY_ALIAS = "quarryvault.session.aesgcm.v2"
    }
}

internal data class DecryptedSessionValue(
    val plaintext: String,
    val migratedCiphertext: String? = null
)

/** Pure crypto boundary so migration and fail-closed behavior can be unit-tested without Android Keystore. */
internal class SessionCipher(private val keyProvider: SessionKeyProvider) {
    fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance(CIPHER_ALGO)
        cipher.init(Cipher.ENCRYPT_MODE, keyProvider.getOrCreateKey())
        val iv = cipher.iv ?: throw IllegalStateException("Keystore did not provide a GCM IV")
        if (iv.size != IV_SIZE) throw IllegalStateException("Unexpected GCM IV length")
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val combined = ByteArray(iv.size + encrypted.size)
        System.arraycopy(iv, 0, combined, 0, iv.size)
        System.arraycopy(encrypted, 0, combined, iv.size, encrypted.size)
        return VERSION_PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(combined)
    }

    fun decrypt(storedValue: String): DecryptedSessionValue {
        return if (storedValue.startsWith(VERSION_PREFIX)) {
            DecryptedSessionValue(decryptV2(storedValue.removePrefix(VERSION_PREFIX)))
        } else {
            val plaintext = decryptLegacy(storedValue)
            DecryptedSessionValue(plaintext, encrypt(plaintext))
        }
    }

    private fun decryptV2(encoded: String): String {
        val combined = Base64.getUrlDecoder().decode(encoded)
        if (combined.size < IV_SIZE + GCM_TAG_BYTES) throw IllegalArgumentException("Invalid encrypted session length")
        val iv = combined.copyOfRange(0, IV_SIZE)
        val encrypted = combined.copyOfRange(IV_SIZE, combined.size)
        val cipher = Cipher.getInstance(CIPHER_ALGO)
        cipher.init(Cipher.DECRYPT_MODE, keyProvider.getOrCreateKey(), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        return String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }

    /** Reads only the legacy AES/GCM ciphertext format; there is deliberately no plaintext fallback. */
    private fun decryptLegacy(encoded: String): String {
        val combined = Base64.getDecoder().decode(encoded)
        if (combined.size < IV_SIZE + GCM_TAG_BYTES) throw IllegalArgumentException("Invalid legacy session ciphertext")
        val iv = combined.copyOfRange(0, IV_SIZE)
        val encrypted = combined.copyOfRange(IV_SIZE, combined.size)
        val cipher = Cipher.getInstance(CIPHER_ALGO)
        cipher.init(Cipher.DECRYPT_MODE, legacyKey(), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        return String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }

    private fun legacyKey(): SecretKeySpec {
        val digest = MessageDigest.getInstance("SHA-256")
        val keyBytes = digest.digest(LEGACY_KEY_MATERIAL.toByteArray(Charsets.UTF_8))
        return SecretKeySpec(keyBytes, "AES")
    }

    private companion object {
        const val VERSION_PREFIX = "QV2:"
        const val CIPHER_ALGO = "AES/GCM/NoPadding"
        const val GCM_TAG_LENGTH = 128
        const val GCM_TAG_BYTES = 16
        const val IV_SIZE = 12
        const val LEGACY_KEY_MATERIAL = "quarryvault_secure_keystore_salt"
    }
}

class SessionStorageException(message: String, cause: Throwable? = null) : IllegalStateException(message, cause)

class SharedPreferencesSessionStorage internal constructor(
    private val prefs: SharedPreferences,
    keyProvider: SessionKeyProvider
) : SessionStorage {
    constructor(context: Context) : this(
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
        AndroidKeystoreSessionKeyProvider()
    )

    private val cipher = SessionCipher(keyProvider)

    override fun saveSession(accessToken: String, refreshToken: String?, email: String?) {
        saveSession(accessToken, refreshToken, email, null)
    }

    override fun saveSession(accessToken: String, refreshToken: String?, email: String?, sessionId: String?) {
        try {
            // Encrypt every value before editing preferences; encryption failure can never persist plaintext.
            val encryptedAccess = cipher.encrypt(accessToken)
            val encryptedRefresh = refreshToken?.let(cipher::encrypt)
            val encryptedEmail = email?.let(cipher::encrypt)
            val encryptedSessionId = sessionId?.let(cipher::encrypt)
            val editor = prefs.edit().putString(KEY_ACCESS_TOKEN, encryptedAccess)
            if (encryptedRefresh == null) editor.remove(KEY_REFRESH_TOKEN) else editor.putString(KEY_REFRESH_TOKEN, encryptedRefresh)
            if (encryptedEmail == null) {
                editor.remove(KEY_EMAIL).remove(KEY_USERNAME)
            } else {
                editor.putString(KEY_EMAIL, encryptedEmail).putString(KEY_USERNAME, encryptedEmail)
            }
            if (encryptedSessionId == null) editor.remove(KEY_SESSION_ID) else editor.putString(KEY_SESSION_ID, encryptedSessionId)
            if (!editor.commit()) throw IllegalStateException("Session preferences could not be committed")
        } catch (error: Exception) {
            throw SessionStorageException("Unable to securely store the session", error)
        }
    }

    override fun getAccessToken(): String? = readEncrypted(KEY_ACCESS_TOKEN)
    override fun getRefreshToken(): String? = readEncrypted(KEY_REFRESH_TOKEN)
    override fun getEmail(): String? = readEncrypted(KEY_EMAIL)
    override fun getUsername(): String? = readEncrypted(KEY_USERNAME) ?: getEmail()
    override fun getSessionId(): String? = readEncrypted(KEY_SESSION_ID)

    override fun clearSession() {
        if (!prefs.edit().clear().commit()) {
            throw SessionStorageException("Unable to clear the persisted session")
        }
    }

    private fun readEncrypted(key: String): String? {
        val stored = prefs.getString(key, null) ?: return null
        return try {
            val decoded = cipher.decrypt(stored)
            if (decoded.migratedCiphertext != null) {
                if (!prefs.edit().putString(key, decoded.migratedCiphertext).commit()) {
                    throw IllegalStateException("Migrated session value could not be committed")
                }
            }
            decoded.plaintext
        } catch (_: Exception) {
            // Corrupt, ambiguous plaintext, missing Keystore key, or failed migration invalidates the whole session.
            clearSession()
            null
        }
    }

    private companion object {
        const val PREFS_NAME = "quarryvault_secure_session"
        const val KEY_ACCESS_TOKEN = "access_token"
        const val KEY_REFRESH_TOKEN = "refresh_token"
        const val KEY_EMAIL = "email"
        const val KEY_USERNAME = "username"
        const val KEY_SESSION_ID = "session_id"
    }
}
