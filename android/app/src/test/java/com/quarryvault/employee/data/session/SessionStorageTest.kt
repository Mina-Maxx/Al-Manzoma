package com.quarryvault.employee.data.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionStorageTest {

    @Test
    fun inMemorySessionStorage_saveGetAndClear() {
        val storage = InMemorySessionStorage()
        assertFalse(storage.hasActiveSession())
        assertNull(storage.getAccessToken())
        assertNull(storage.getRefreshToken())
        assertNull(storage.getEmail())

        storage.saveSession("token-123", "refresh-456", "test@quarry.com")
        assertTrue(storage.hasActiveSession())
        assertEquals("token-123", storage.getAccessToken())
        assertEquals("refresh-456", storage.getRefreshToken())
        assertEquals("test@quarry.com", storage.getEmail())

        storage.clearSession()
        assertFalse(storage.hasActiveSession())
        assertNull(storage.getAccessToken())
        assertNull(storage.getRefreshToken())
        assertNull(storage.getEmail())
    }
}
