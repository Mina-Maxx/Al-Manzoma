package com.quarryvault.employee.data.repository

import com.quarryvault.employee.data.api.QuarryVaultApiClient
import com.quarryvault.employee.data.api.SupabaseAuthClient
import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.HealthResponse
import com.quarryvault.employee.data.api.models.MeResponse
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.SupabaseTokenResponse
import com.quarryvault.employee.data.api.models.TrashDocument
import com.quarryvault.employee.data.session.InMemorySessionStorage
import com.quarryvault.employee.data.session.SessionStorage

interface EmployeeRepository {
    var backendBaseUrl: String
    var supabaseUrl: String
    var supabaseAnonKey: String
    val sessionStorage: SessionStorage

    suspend fun checkHealth(): ApiResult<HealthResponse>
    suspend fun login(email: String, password: String): ApiResult<SupabaseTokenResponse>
    suspend fun getProfile(token: String? = null): ApiResult<MeResponse>
    suspend fun logout()

    suspend fun getQuarries(token: String? = null): ApiResult<List<Quarry>>
    suspend fun createQuarry(name: String, token: String? = null): ApiResult<Quarry>
    suspend fun getFolders(quarryId: String, token: String? = null): ApiResult<List<Folder>>
    suspend fun getDocuments(
        quarryId: String,
        folderId: String? = null,
        rootOnly: Boolean = false,
        token: String? = null
    ): ApiResult<List<Document>>

    suspend fun uploadDocument(
        quarryId: String,
        fileBytes: ByteArray,
        filename: String,
        mimeType: String,
        displayName: String? = null,
        folderId: String? = null,
        token: String? = null,
        idempotencyKey: String? = null
    ): ApiResult<Document>

    suspend fun downloadDocument(documentId: String, token: String? = null): ApiResult<ByteArray>
    suspend fun deleteDocument(quarryId: String, documentId: String, version: Int? = null, token: String? = null): ApiResult<Unit>
    suspend fun getTrashDocuments(quarryId: String, token: String? = null): ApiResult<List<TrashDocument>>
    suspend fun restoreDocument(quarryId: String, documentId: String, version: Int? = null, token: String? = null): ApiResult<Document>

    fun hasStoredSession(): Boolean
    fun getStoredToken(): String?
    fun getStoredEmail(): String?
}

class DefaultEmployeeRepository(
    private val apiClient: QuarryVaultApiClient = QuarryVaultApiClient(),
    private val authClient: SupabaseAuthClient = SupabaseAuthClient(),
    override val sessionStorage: SessionStorage = InMemorySessionStorage()
) : EmployeeRepository {

    override var backendBaseUrl: String
        get() = apiClient.baseUrl
        set(value) {
            apiClient.baseUrl = value
        }

    override var supabaseUrl: String
        get() = authClient.supabaseUrl
        set(value) {
            authClient.supabaseUrl = value
        }

    override var supabaseAnonKey: String
        get() = authClient.anonKey
        set(value) {
            authClient.anonKey = value
        }

    override suspend fun checkHealth(): ApiResult<HealthResponse> {
        return apiClient.getHealth()
    }

    override suspend fun login(email: String, password: String): ApiResult<SupabaseTokenResponse> {
        val result = authClient.signInWithPassword(email, password)
        if (result is ApiResult.Success) {
            sessionStorage.saveSession(
                accessToken = result.data.accessToken,
                refreshToken = result.data.refreshToken,
                email = result.data.user?.email ?: email
            )
        }
        return result
    }

    private fun resolveToken(token: String?): String? {
        return token?.trim()?.takeIf { it.isNotEmpty() } ?: sessionStorage.getAccessToken()
    }

    override suspend fun getProfile(token: String?): ApiResult<MeResponse> {
        val effectiveToken = resolveToken(token)
        if (effectiveToken.isNullOrBlank()) {
            return ApiResult.Error(401, "No authentication token available")
        }

        val result = apiClient.getMe(effectiveToken)
        if (result is ApiResult.Error && result.statusCode == 401) {
            sessionStorage.clearSession()
        }
        return result
    }

    override suspend fun getQuarries(token: String?): ApiResult<List<Quarry>> {
        val effectiveToken = resolveToken(token)
            ?: return ApiResult.Error(401, "No authentication token available")
        return apiClient.getQuarries(effectiveToken)
    }

    override suspend fun createQuarry(name: String, token: String?): ApiResult<Quarry> {
        val effectiveToken = resolveToken(token)
            ?: return ApiResult.Error(401, "No authentication token available")
        return apiClient.createQuarry(effectiveToken, name)
    }

    override suspend fun getFolders(quarryId: String, token: String?): ApiResult<List<Folder>> {
        val effectiveToken = resolveToken(token)
            ?: return ApiResult.Error(401, "No authentication token available")
        return apiClient.getQuarryFolders(effectiveToken, quarryId)
    }

    override suspend fun getDocuments(
        quarryId: String,
        folderId: String?,
        rootOnly: Boolean,
        token: String?
    ): ApiResult<List<Document>> {
        val effectiveToken = resolveToken(token)
            ?: return ApiResult.Error(401, "No authentication token available")
        return apiClient.getQuarryDocuments(
            token = effectiveToken,
            quarryId = quarryId,
            folderId = folderId,
            rootOnly = rootOnly
        )
    }

    override suspend fun uploadDocument(
        quarryId: String,
        fileBytes: ByteArray,
        filename: String,
        mimeType: String,
        displayName: String?,
        folderId: String?,
        token: String?,
        idempotencyKey: String?
    ): ApiResult<Document> {
        val effectiveToken = resolveToken(token)
            ?: return ApiResult.Error(401, "No authentication token available")
        return apiClient.uploadDocument(
            token = effectiveToken,
            quarryId = quarryId,
            fileBytes = fileBytes,
            filename = filename,
            mimeType = mimeType,
            displayName = displayName,
            folderId = folderId,
            idempotencyKey = idempotencyKey ?: java.util.UUID.randomUUID().toString()
        )
    }

    override suspend fun downloadDocument(documentId: String, token: String?): ApiResult<ByteArray> {
        val effectiveToken = resolveToken(token)
            ?: return ApiResult.Error(401, "No authentication token available")
        return apiClient.downloadDocument(effectiveToken, documentId)
    }

    override suspend fun deleteDocument(
        quarryId: String,
        documentId: String,
        version: Int?,
        token: String?
    ): ApiResult<Unit> {
        val effectiveToken = resolveToken(token)
            ?: return ApiResult.Error(401, "No authentication token available")
        return apiClient.deleteDocument(effectiveToken, quarryId, documentId, version)
    }

    override suspend fun getTrashDocuments(
        quarryId: String,
        token: String?
    ): ApiResult<List<TrashDocument>> {
        val effectiveToken = resolveToken(token)
            ?: return ApiResult.Error(401, "No authentication token available")
        return apiClient.getTrashDocuments(effectiveToken, quarryId)
    }

    override suspend fun restoreDocument(
        quarryId: String,
        documentId: String,
        version: Int?,
        token: String?
    ): ApiResult<Document> {
        val effectiveToken = resolveToken(token)
            ?: return ApiResult.Error(401, "No authentication token available")
        return apiClient.restoreDocument(effectiveToken, quarryId, documentId, version)
    }

    override suspend fun logout() {
        sessionStorage.clearSession()
    }

    override fun hasStoredSession(): Boolean = sessionStorage.hasActiveSession()

    override fun getStoredToken(): String? = sessionStorage.getAccessToken()

    override fun getStoredEmail(): String? = sessionStorage.getEmail()
}
