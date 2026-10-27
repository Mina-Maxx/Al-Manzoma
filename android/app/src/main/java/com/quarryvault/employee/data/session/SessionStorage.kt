package com.quarryvault.employee.data.session

import android.content.Context
import android.content.SharedPreferences

interface SessionStorage {
    fun saveSession(accessToken: String, refreshToken: String?, email: String?)
    fun getAccessToken(): String?
    fun getRefreshToken(): String?
    fun getEmail(): String?
    fun clearSession()
    fun hasActiveSession(): Boolean = !getAccessToken().isNullOrBlank()
}

class InMemorySessionStorage : SessionStorage {
    private var accessToken: String? = null
    private var refreshToken: String? = null
    private var email: String? = null

    override fun saveSession(accessToken: String, refreshToken: String?, email: String?) {
        this.accessToken = accessToken
        this.refreshToken = refreshToken
        this.email = email
    }

    override fun getAccessToken(): String? = accessToken

    override fun getRefreshToken(): String? = refreshToken

    override fun getEmail(): String? = email

    override fun clearSession() {
        accessToken = null
        refreshToken = null
        email = null
    }
}

class SharedPreferencesSessionStorage(context: Context) : SessionStorage {
    companion object {
        private const val PREFS_NAME = "quarryvault_secure_session"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_EMAIL = "email"
    }

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun saveSession(accessToken: String, refreshToken: String?, email: String?) {
        prefs.edit()
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .putString(KEY_EMAIL, email)
            .apply()
    }

    override fun getAccessToken(): String? = prefs.getString(KEY_ACCESS_TOKEN, null)

    override fun getRefreshToken(): String? = prefs.getString(KEY_REFRESH_TOKEN, null)

    override fun getEmail(): String? = prefs.getString(KEY_EMAIL, null)

    override fun clearSession() {
        prefs.edit().clear().apply()
    }
}
