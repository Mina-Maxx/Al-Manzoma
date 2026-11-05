package com.quarryvault.employee.data.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthErrorMapperTest {

    @Test
    fun mapLoginError_invalidCredentials() {
        val result = AuthErrorMapper.mapLoginError(401, "Invalid credentials")
        assertTrue(result.english.contains("Incorrect username or password"))
        assertTrue(result.arabic.contains("اسم المستخدم أو كلمة المرور غير صحيحة"))
    }

    @Test
    fun mapLoginError_inactiveAccount() {
        val result = AuthErrorMapper.mapLoginError(401, "Account inactive")
        assertTrue(result.english.contains("Account is inactive or disabled"))
        assertTrue(result.arabic.contains("الحساب غير مفعل أو معطل"))
    }

    @Test
    fun mapBackendError_userNotProvisioned() {
        val result = AuthErrorMapper.mapBackendError(403, "user not provisioned")
        assertTrue(result.english.contains("not provisioned"))
        assertTrue(result.arabic.contains("غير مسجل"))
    }

    @Test
    fun mapBackendError_userNotActive() {
        val result = AuthErrorMapper.mapBackendError(403, "user is not active")
        assertTrue(result.english.contains("deactivated"))
        assertTrue(result.arabic.contains("تم إيقاف حسابك"))
    }

    @Test
    fun mapBackendError_companyNotActive() {
        val result = AuthErrorMapper.mapBackendError(403, "company is not active")
        assertTrue(result.english.contains("Company subscription is inactive or suspended"))
        assertTrue(result.arabic.contains("حساب الشركة غير مفعل"))
    }

    @Test
    fun mapBackendError_tokenExpired401() {
        val result = AuthErrorMapper.mapBackendError(401, "invalid or missing credentials")
        assertTrue(result.english.contains("Session expired or invalid token"))
        assertTrue(result.arabic.contains("انتهت صلاحية الجلسة"))
    }

    @Test
    fun mapNetworkError_connectionFailure() {
        val result = AuthErrorMapper.mapNetworkError(java.net.ConnectException("Connection refused"))
        assertTrue(result.english.contains("Network connection failed"))
        assertTrue(result.arabic.contains("تعذر الاتصال بالخادم"))
        assertFalse(result.arabic.contains("Connection refused"))
    }

    @Test
    fun unknownErrors_doNotExposeRawBackendOrExceptionDetails() {
        val backend = AuthErrorMapper.mapBackendError(400, "SQLException: SELECT * FROM users")
        val login = AuthErrorMapper.mapLoginError(400, "internal stack trace: secret")

        assertFalse(backend.arabic.contains("SQLException"))
        assertFalse(backend.arabic.contains("SELECT"))
        assertFalse(login.arabic.contains("stack trace"))
        assertFalse(login.arabic.contains("secret"))
        assertEquals(login.arabic, login.display)
    }
}
