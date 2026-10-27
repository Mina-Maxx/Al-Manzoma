package com.quarryvault.employee.data.util

import org.junit.Assert.assertTrue
import org.junit.Test

class AuthErrorMapperTest {

    @Test
    fun mapSupabaseError_invalidCredentials() {
        val result = AuthErrorMapper.mapSupabaseError(400, "Invalid login credentials", "invalid_grant")
        assertTrue(result.english.contains("Incorrect email or password"))
        assertTrue(result.arabic.contains("البريد الإلكتروني أو كلمة المرور غير صحيحة"))
    }

    @Test
    fun mapSupabaseError_rateLimited() {
        val result = AuthErrorMapper.mapSupabaseError(429, "Too many requests", "over_request_rate_limit")
        assertTrue(result.english.contains("Too many attempts"))
        assertTrue(result.arabic.contains("تم تجاوز عدد المحاولات"))
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
    }
}
