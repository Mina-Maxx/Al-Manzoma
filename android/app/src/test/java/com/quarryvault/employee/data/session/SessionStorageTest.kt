package com.quarryvault.employee.data.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class SessionStorageTest {

    @Test
    fun inMemorySessionStorage_saveGetAndClear() {
        val storage = InMemorySessionStorage()
        assertFalse(storage.hasActiveSession())
        assertNull(storage.getAccessToken())
        assertNull(storage.getRefreshToken())
        assertNull(storage.getEmail())
        assertNull(storage.getSessionId())

        storage.saveSession("token-123", "refresh-456", "test@quarry.com", "session-789")
        assertTrue(storage.hasActiveSession())
        assertEquals("token-123", storage.getAccessToken())
        assertEquals("refresh-456", storage.getRefreshToken())
        assertEquals("test@quarry.com", storage.getEmail())
        assertEquals("session-789", storage.getSessionId())

        storage.clearSession()
        assertFalse(storage.hasActiveSession())
        assertNull(storage.getAccessToken())
        assertNull(storage.getRefreshToken())
        assertNull(storage.getEmail())
        assertNull(storage.getSessionId())
    }

    @Test
    fun keystoreCipherRoundTripsAndMarksVersionedCiphertext() {
        val cipher = SessionCipher(FakeKeyProvider())
        val stored = cipher.encrypt("access-token-secret")
        assertTrue(stored.startsWith("QV2:"))
        assertFalse(stored.contains("access-token-secret"))
        val decrypted = cipher.decrypt(stored)
        assertEquals("access-token-secret", decrypted.plaintext)
        assertNull(decrypted.migratedCiphertext)
    }

    @Test
    fun validLegacyCiphertextIsMigratedToVersionedKeystoreCiphertext() {
        val cipher = SessionCipher(FakeKeyProvider())
        val legacy = encryptLegacy("legacy-refresh-secret")
        val decrypted = cipher.decrypt(legacy)
        assertEquals("legacy-refresh-secret", decrypted.plaintext)
        assertTrue(decrypted.migratedCiphertext!!.startsWith("QV2:"))
        assertEquals("legacy-refresh-secret", cipher.decrypt(decrypted.migratedCiphertext).plaintext)
    }

    @Test
    fun plaintextAndCorruptCiphertextAreRejectedInsteadOfReturnedAsCredentials() {
        val cipher = SessionCipher(FakeKeyProvider())
        assertThrows<Exception> { cipher.decrypt("eyJhbGciOiJIUzI1NiJ9.plaintext-token") }
        assertThrows<Exception> { cipher.decrypt("QV2:AA") }
    }

    @Test
    fun keystoreFailureDoesNotFallBackToPlaintext() {
        val cipher = SessionCipher(SessionKeyProvider { throw IllegalStateException("keystore unavailable") })
        assertThrows<Exception> { cipher.encrypt("must-never-be-stored-in-plaintext") }

        val stored = SessionCipher(FakeKeyProvider()).encrypt("must-require-existing-key")
        val missingKeyCipher = SessionCipher(SessionKeyProvider { throw IllegalStateException("key missing") })
        assertThrows<Exception> { missingKeyCipher.decrypt(stored) }
    }

    private fun encryptLegacy(plaintext: String): String {
        val keyBytes = MessageDigest.getInstance("SHA-256")
            .digest("quarryvault_secure_keystore_salt".toByteArray(Charsets.UTF_8))
        val key: SecretKey = SecretKeySpec(keyBytes, "AES")
        val iv = ByteArray(12).apply { SecureRandom().nextBytes(this) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return java.util.Base64.getEncoder().encodeToString(iv + encrypted)
    }

    private inline fun <reified T : Throwable> assertThrows(block: () -> Unit) {
        try {
            block()
            throw AssertionError("Expected ${T::class.java.simpleName}")
        } catch (error: Throwable) {
            if (error !is T) throw error
        }
    }

    private class FakeKeyProvider : SessionKeyProvider {
        private val key = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
        override fun getOrCreateKey(): SecretKey = key
    }
}
