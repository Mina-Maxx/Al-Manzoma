package com.quarryvault.employee.ui

import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.AuthTokenResponse
import com.quarryvault.employee.data.api.models.AppUpdateManifest
import com.quarryvault.employee.data.api.models.ServerConfig
import com.quarryvault.employee.data.api.models.CompanyOut
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.DownloadedDocumentPayload
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.HealthResponse
import com.quarryvault.employee.data.api.models.MeResponse
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.QuarryPermission
import com.quarryvault.employee.data.api.models.TrashDocument
import com.quarryvault.employee.data.api.models.CompanyEmployee
import com.quarryvault.employee.data.api.models.CompanyQuarry
import com.quarryvault.employee.data.api.models.CreateEmployeeRequest
import com.quarryvault.employee.data.api.models.QuarryInitialPermissionRequest
import com.quarryvault.employee.data.api.models.UserOut
import com.quarryvault.employee.data.repository.EmployeeRepository
import com.quarryvault.employee.data.session.InMemorySessionStorage
import com.quarryvault.employee.data.session.SessionStorage
import com.quarryvault.employee.ui.screens.AppScreen
import com.quarryvault.employee.ui.screens.EmployeeAppViewModel
import com.quarryvault.employee.ui.screens.RequestState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import com.quarryvault.employee.ui.components.NotificationType
import com.quarryvault.employee.data.util.LocalizedMessage
import kotlinx.coroutines.test.advanceTimeBy

class FakeEmployeeRepository(
    override val sessionStorage: SessionStorage = InMemorySessionStorage()
) : EmployeeRepository {
    override val backendBaseUrl: String = "http://10.0.2.2:8000"

    var healthResult: ApiResult<HealthResponse> = ApiResult.Success(HealthResponse("ok"))
    var loginResult: ApiResult<AuthTokenResponse> = ApiResult.Success(
        AuthTokenResponse(
            accessToken = "test-access-token-123",
            refreshToken = "test-refresh-token-456",
            user = UserOut(
                id = "user-uuid-1",
                username = "workerone",
                email = "worker@quarry.com",
                fullName = "Worker One",
                status = "active",
                mustChangePassword = false
            )
        )
    )
    var profileResult: ApiResult<MeResponse> = ApiResult.Success(
        MeResponse(
            user = UserOut(
                id = "u-123",
                email = "worker@quarry.com",
                fullName = "Worker One",
                status = "active"
            ),
            company = CompanyOut(
                id = "c-123",
                name = "Marble Co",
                status = "active",
                quotaBytes = 5000,
                maxUsers = 10,
                usedBytes = 200
            ),
            role = "employee"
        )
    )

    var quarriesResult: ApiResult<List<Quarry>> = ApiResult.Success(
        listOf(
            Quarry(
                id = "q-1",
                name = "North Quarry",
                status = "active",
                permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true, canDelete = true)
            )
        )
    )

    var foldersResult: ApiResult<List<Folder>> = ApiResult.Success(
        listOf(
            Folder(
                id = "f-1",
                quarryId = "q-1",
                parentId = null,
                name = "Site Photos"
            )
        )
    )

    var documentsResult: ApiResult<List<Document>> = ApiResult.Success(
        listOf(
            Document(
                id = "d-1",
                quarryId = "q-1",
                folderId = null,
                displayName = "Daily Log",
                originalFilename = "daily_log.pdf",
                mimeType = "application/pdf",
                sizeBytes = 1024,
                status = "available",
                createdAt = "2026-10-25T12:00:00Z"
            )
        )
    )

    var uploadResult: ApiResult<Document> = ApiResult.Success(
        Document(
            id = "d-2",
            quarryId = "q-1",
            folderId = null,
            displayName = "New Upload",
            originalFilename = "upload.pdf",
            mimeType = "application/pdf",
            sizeBytes = 2048,
            status = "available",
            createdAt = "2026-10-25T12:05:00Z"
        )
    )

    var renameResult: ApiResult<Document> = ApiResult.Success(
        Document(
            id = "d-1",
            quarryId = "q-1",
            folderId = null,
            displayName = "Renamed Log",
            originalFilename = "daily_log.pdf",
            mimeType = "application/pdf",
            sizeBytes = 1024,
            status = "available",
            version = 2,
            createdAt = "2026-10-25T12:00:00Z"
        )
    )
    var lastRenamedDocumentId: String? = null
    var lastRenamedNewName: String? = null

    var downloadResult: ApiResult<ByteArray> = ApiResult.Success("file content".toByteArray())
    var downloadPayloadResult: ApiResult<DownloadedDocumentPayload>? = null
    var downloadPayloadCalls = 0

    var createQuarryResult: ApiResult<Quarry> = ApiResult.Success(
        Quarry(
            id = "q-new",
            name = "New Test Quarry",
            status = "active",
            permissions = QuarryPermission(canView = true, canUpload = false, canDownload = false)
        )
    )
    var createQuarryException: Exception? = null
    var createQuarryGate: CompletableDeferred<Unit>? = null
    var createQuarryCalls = 0

    var deleteResult: ApiResult<Unit> = ApiResult.Success(Unit)
    var trashResult: ApiResult<List<TrashDocument>> = ApiResult.Success(
        listOf(
            TrashDocument(
                id = "trash-1",
                quarryId = "q-1",
                folderId = null,
                displayName = "Old Report",
                originalFilename = "old_report.pdf",
                mimeType = "application/pdf",
                sizeBytes = 4096,
                version = 1,
                createdAt = "2026-10-20T10:00:00Z",
                deletedAt = "2026-10-25T14:00:00Z",
                deletedBy = "u-123",
                canRestore = true,
                retentionExpiresAt = "2026-11-24T14:00:00Z"
            )
        )
    )
    var trashException: Exception? = null
    var restoreResult: ApiResult<Document> = ApiResult.Success(
        Document(
            id = "trash-1",
            quarryId = "q-1",
            folderId = null,
            displayName = "Old Report",
            originalFilename = "old_report.pdf",
            mimeType = "application/pdf",
            sizeBytes = 4096,
            status = "available",
            createdAt = "2026-10-20T10:00:00Z"
        )
    )

    override suspend fun checkHealth(): ApiResult<HealthResponse> = healthResult

    override suspend fun login(username: String, password: String): ApiResult<AuthTokenResponse> {
        val result = loginResult
        if (result is ApiResult.Success) {
            sessionStorage.saveSession(
                result.data.accessToken,
                result.data.refreshToken,
                result.data.user.username ?: result.data.user.email ?: username
            )
        }
        return result
    }

    override suspend fun getProfile(token: String?): ApiResult<MeResponse> {
        return profileResult
    }

    var getQuarriesException: Exception? = null

    override suspend fun getQuarries(token: String?): ApiResult<List<Quarry>> {
        getQuarriesException?.let { throw it }
        return quarriesResult
    }

    var lastGetFoldersQuarryId: String? = null
    var lastGetFoldersToken: String? = null
    var getFoldersException: Exception? = null
    var getDocumentsException: Exception? = null
    var lastRequestedFolderId: String? = null

    override suspend fun getFolders(quarryId: String, token: String?): ApiResult<List<Folder>> {
        lastGetFoldersQuarryId = quarryId
        lastGetFoldersToken = token
        getFoldersException?.let { throw it }
        return foldersResult
    }

    override suspend fun getDocuments(
        quarryId: String,
        folderId: String?,
        rootOnly: Boolean,
        token: String?
    ): ApiResult<List<Document>> {
        lastRequestedFolderId = folderId
        getDocumentsException?.let { throw it }
        return documentsResult
    }

    var lastUploadedIdempotencyKey: String? = null

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
        lastUploadedIdempotencyKey = idempotencyKey
        return uploadResult
    }

    override suspend fun downloadDocument(documentId: String, token: String?): ApiResult<ByteArray> {
        return downloadResult
    }

    override suspend fun downloadDocumentPayload(documentId: String, token: String?): ApiResult<DownloadedDocumentPayload> {
        downloadPayloadCalls++
        downloadPayloadResult?.let { return it }
        return when (val res = downloadResult) {
            is ApiResult.Success -> ApiResult.Success(DownloadedDocumentPayload(res.data, ""))
            is ApiResult.Error -> ApiResult.Error(res.statusCode, res.message, res.code, res.sessionId)
            is ApiResult.NetworkError -> ApiResult.NetworkError(res.throwable)
        }
    }

    var lastCreatedQuarryNumber: String? = null
    var lastCreatedQuarryType: String? = null
    var lastCreatedQuarryName: String? = null

    override suspend fun createQuarry(
        name: String,
        quarryNumber: String,
        quarryType: String,
        token: String?
    ): ApiResult<Quarry> {
        createQuarryCalls += 1
        lastCreatedQuarryName = name
        lastCreatedQuarryNumber = quarryNumber
        lastCreatedQuarryType = quarryType
        createQuarryGate?.await()
        createQuarryException?.let { throw it }
        return createQuarryResult
    }

    override suspend fun getCompanyTrash(token: String?): ApiResult<List<TrashDocument>> {
        trashException?.let { throw it }
        return trashResult
    }

    override suspend fun restoreCompanyTrashDocument(
        documentId: String,
        version: Int?,
        token: String?
    ): ApiResult<Document> = restoreResult

    override suspend fun renameDocument(
        quarryId: String,
        documentId: String,
        newName: String,
        token: String?
    ): ApiResult<Document> {
        lastRenamedDocumentId = documentId
        lastRenamedNewName = newName
        return renameResult
    }

var permanentlyDeleteResult: ApiResult<Unit> = ApiResult.Success(Unit)
    var lastPermanentlyDeletedQuarryId: String? = null
    var lastPermanentlyDeletedDocumentId: String? = null

    override suspend fun permanentlyDeleteDocument(
        quarryId: String,
        documentId: String,
        token: String?
    ): ApiResult<Unit> {
        lastPermanentlyDeletedQuarryId = quarryId
        lastPermanentlyDeletedDocumentId = documentId
        return permanentlyDeleteResult
    }

    override suspend fun deleteDocument(
        quarryId: String,
        documentId: String,
        version: Int?,
        token: String?
    ): ApiResult<Unit> = deleteResult

    override suspend fun getTrashDocuments(
        quarryId: String,
        token: String?
    ): ApiResult<List<TrashDocument>> {
        trashException?.let { throw it }
        return trashResult
    }

    override suspend fun restoreDocument(
        quarryId: String,
        documentId: String,
        version: Int?,
        token: String?
    ): ApiResult<Document> = restoreResult

    var changePasswordResult: ApiResult<Unit> = ApiResult.Success(Unit)
    var lastCurrentPassword: String? = null
    override suspend fun changePassword(
        newPassword: String,
        confirmPassword: String,
        currentPassword: String?,
        token: String?
    ): ApiResult<Unit> {
        lastCurrentPassword = currentPassword
        return changePasswordResult
    }

    var updateManifestResult: ApiResult<AppUpdateManifest> = ApiResult.Success(
        AppUpdateManifest(
            versionCode = 1,
            versionName = "1.0.0",
            apkUrl = "http://localhost:8000/app/updates/download/uuid",
            apkSizeBytes = 1024,
            sha256 = "dummy",
            publishedAt = "2026-10-27T16:00:00Z"
        )
    )
    override suspend fun getLatestUpdateManifest(): ApiResult<AppUpdateManifest> = updateManifestResult

    var serverConfigResult: ApiResult<ServerConfig> = ApiResult.Success(
        ServerConfig(
            configVersion = "2026.10.1",
            serverTime = "2026-10-27T16:00:00Z",
            minimumSupportedVersionCode = 1
        )
    )
    override suspend fun getServerConfig(): ApiResult<ServerConfig> = serverConfigResult

    var downloadApkResult: ApiResult<java.io.File> = ApiResult.Success(java.io.File("dummy.apk"))
    override suspend fun downloadApk(
        url: String,
        targetFile: java.io.File,
        onProgress: ((bytesRead: Long, totalBytes: Long) -> Unit)?
    ): ApiResult<java.io.File> = downloadApkResult

    var updateProfileResult: ApiResult<UserOut> = ApiResult.Success(
        UserOut(
            id = "u-123",
            username = "workerone",
            email = "worker@quarry.com",
            fullName = "Updated Worker Name",
            status = "active"
        )
    )
    override suspend fun updateProfile(fullName: String, token: String?): ApiResult<UserOut> = updateProfileResult

    var createFolderResult: ApiResult<Folder> = ApiResult.Success(
        Folder(
            id = "f-new",
            quarryId = "q-1",
            parentId = null,
            name = "New Folder",
            isStandard = false
        )
    )
    override suspend fun createFolder(quarryId: String, name: String, parentId: String?, token: String?): ApiResult<Folder> = createFolderResult

    var deleteFolderResult: ApiResult<Unit> = ApiResult.Success(Unit)
    override suspend fun deleteFolder(quarryId: String, folderId: String, token: String?): ApiResult<Unit> = deleteFolderResult

    var getCompanyEmployeesResult: ApiResult<List<CompanyEmployee>> = ApiResult.Success(emptyList())
    override suspend fun getCompanyEmployees(token: String?): ApiResult<List<CompanyEmployee>> = getCompanyEmployeesResult

    var createCompanyEmployeeResult: ApiResult<CompanyEmployee> = ApiResult.Success(
        CompanyEmployee(
            id = "emp-created-1",
            username = "new_emp",
            email = "new_emp@quarry.com",
            fullName = "New Employee",
            status = "active",
            role = "employee"
        )
    )
    var lastCreateEmployeeRequest: CreateEmployeeRequest? = null
    override suspend fun createCompanyEmployee(
        request: CreateEmployeeRequest,
        token: String?
    ): ApiResult<CompanyEmployee> {
        lastCreateEmployeeRequest = request
        return createCompanyEmployeeResult
    }

    var getCompanyQuarriesResult: ApiResult<List<CompanyQuarry>> = ApiResult.Success(emptyList())
    override suspend fun getCompanyQuarries(token: String?): ApiResult<List<CompanyQuarry>> = getCompanyQuarriesResult

    override suspend fun logout() {
        sessionStorage.clearSession()
    }

    override fun hasStoredSession(): Boolean = sessionStorage.hasActiveSession()
    override fun getStoredToken(): String? = sessionStorage.getAccessToken()
    override fun getStoredEmail(): String? = sessionStorage.getEmail()
}


@OptIn(ExperimentalCoroutinesApi::class)
class EmployeeAppViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var fakeRepository: FakeEmployeeRepository
    private lateinit var viewModel: EmployeeAppViewModel

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        fakeRepository = FakeEmployeeRepository()
        viewModel = EmployeeAppViewModel(fakeRepository)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun initialState_unauthenticatedAndIdle() {
        val state = viewModel.uiState.value
        assertEquals("http://10.0.2.2:8000", state.backendBaseUrl)
        assertFalse(state.isAuthenticated)
        assertFalse(state.isAuthenticating)
        assertNull(state.profile)
        assertNull(state.loginError)
        assertEquals(AppScreen.LOGIN, state.currentScreen)
    }

    @Test
    fun login_validationEmptyFields() = runTest(testDispatcher) {
        viewModel.onEmailChanged("")
        viewModel.onPasswordChanged("")
        viewModel.login()

        assertNotNull(viewModel.uiState.value.loginError)
        assertTrue(viewModel.uiState.value.loginError!!.english.contains("email"))

        viewModel.onEmailChanged("worker@quarry.com")
        viewModel.onPasswordChanged("")
        viewModel.login()

        assertNotNull(viewModel.uiState.value.loginError)
        assertTrue(viewModel.uiState.value.loginError!!.english.contains("password"))
    }

    @Test
    fun login_success_loadsProfileAndNavigatesToHome() = runTest(testDispatcher) {
        viewModel.onEmailChanged("worker@quarry.com")
        viewModel.onPasswordChanged("valid-password-123")
        viewModel.login()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue(state.isAuthenticated)
        assertFalse(state.isAuthenticating)
        assertNotNull(state.profile)
        assertEquals("Worker One", state.profile?.user?.fullName)
        assertEquals("Marble Co", state.profile?.company?.name)
        assertEquals("employee", state.profile?.role)
        assertEquals(AppScreen.HOME, state.currentScreen)
        assertEquals(1, state.quarries.size)
        assertEquals("North Quarry", state.quarries[0].name)
        assertNull(state.loginError)
    }

    @Test
    fun selectQuarry_navigatesToDetailAndLoadsContent() = runTest(testDispatcher) {
        val quarry = Quarry(
            id = "q-1",
            name = "North Quarry",
            status = "active",
            permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true, canDelete = true)
        )
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals(AppScreen.QUARRY_DETAIL, state.currentScreen)
        assertEquals("North Quarry", state.selectedQuarry?.name)
        assertEquals(1, state.folders.size)
        assertEquals("Site Photos", state.folders[0].name)
        assertEquals(1, state.documents.size)
        assertEquals("Daily Log", state.documents[0].displayName)
    }

    @Test
    fun navigateBackToHome_resetsQuarryDetail() = runTest(testDispatcher) {
        val quarry = Quarry(
            id = "q-1",
            name = "North Quarry",
            status = "active",
            permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true, canDelete = true)
        )
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()
        assertEquals(AppScreen.QUARRY_DETAIL, viewModel.uiState.value.currentScreen)

        viewModel.navigateBackToHome()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals(AppScreen.HOME, state.currentScreen)
        assertNull(state.selectedQuarry)
    }

    @Test
    fun uploadDocument_success_reloadsContent() = runTest(testDispatcher) {
        val quarry = Quarry(
            id = "q-1",
            name = "North Quarry",
            status = "active",
            permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true, canDelete = true)
        )
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        viewModel.uploadDocument(
            fileBytes = "test bytes".toByteArray(),
            filename = "upload.pdf",
            mimeType = "application/pdf",
            displayName = "New Upload"
        )
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isUploading)
        assertNotNull(state.uploadSuccessMessage)
        assertTrue(state.uploadSuccessMessage!!.english.contains("uploaded successfully"))
    }

    @Test
    fun downloadDocument_success_setsData() = runTest(testDispatcher) {
        viewModel.selectQuarry(Quarry("q-1", "North Quarry", permissions = QuarryPermission(canView = true, canDownload = true)))
        advanceUntilIdle()
        val doc = Document(
            id = "d-1",
            quarryId = "q-1",
            folderId = null,
            displayName = "Daily Log",
            originalFilename = "daily_log.pdf",
            mimeType = "application/pdf",
            sizeBytes = 1024,
            status = "available",
            createdAt = "2026-10-25T12:00:00Z"
        )

        viewModel.downloadDocument(doc)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isDownloading)
        assertNotNull(state.downloadedDocumentData)
        assertEquals("Daily Log", state.downloadedDocumentData?.first?.displayName)
        assertNotNull(state.downloadSuccessMessage)
    }

    @Test
    fun downloadDocument_updatesFilenameFromContentDispositionHeader() = runTest(testDispatcher) {
        viewModel.selectQuarry(Quarry("q-1", "North Quarry", permissions = QuarryPermission(canView = true, canDownload = true)))
        advanceUntilIdle()
        val doc = Document(
            id = "d-arabic-1",
            quarryId = "q-1",
            folderId = null,
            displayName = "رخصة تشغيل",
            originalFilename = "fallback.pdf",
            mimeType = "application/pdf",
            sizeBytes = 2048,
            status = "available",
            createdAt = "2026-10-25T12:00:00Z"
        )
        fakeRepository.downloadPayloadResult = ApiResult.Success(
            DownloadedDocumentPayload(
                bytes = ByteArray(20),
                filename = "رخصة المحجر (١).pdf"
            )
        )

        viewModel.downloadDocument(doc)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("رخصة المحجر (١).pdf", state.downloadedDocumentData?.first?.originalFilename)
    }

    @Test
    fun viewDocument_updatesFilenameFromContentDispositionHeader() = runTest(testDispatcher) {
        viewModel.selectQuarry(
            Quarry("q-1", "North Quarry", permissions = QuarryPermission(canView = true, canUpload = true, canDownload = false))
        )
        advanceUntilIdle()
        val doc = Document(
            id = "d-arabic-2",
            quarryId = "q-1",
            displayName = "تقرير الجودة",
            originalFilename = "old.pdf",
            mimeType = "application/pdf",
            sizeBytes = 1024,
            status = "available",
            createdAt = "2026-10-25T12:00:00Z"
        )
        fakeRepository.downloadPayloadResult = ApiResult.Success(
            DownloadedDocumentPayload(
                bytes = ByteArray(15),
                filename = "تقرير (فني) معتمد.pdf"
            )
        )

        viewModel.viewDocument(doc)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("تقرير (فني) معتمد.pdf", state.pendingOpenDocumentData?.first?.originalFilename)
    }

    @Test
    fun viewDocument_usesViewPermissionWithoutRequiringDownloadPermission() = runTest(testDispatcher) {
        viewModel.selectQuarry(
            Quarry("q-view-only", "View Only Quarry", permissions = QuarryPermission(canView = true, canUpload = false, canDownload = false))
        )
        advanceUntilIdle()
        val doc = Document(
            id = "d-view-only",
            quarryId = "q-view-only",
            displayName = "Read Only Report",
            originalFilename = "report.pdf",
            mimeType = "application/pdf",
            sizeBytes = 100,
            status = "available",
            createdAt = "2026-10-25T12:00:00Z"
        )
        fakeRepository.downloadPayloadResult = ApiResult.Success(
            DownloadedDocumentPayload(bytes = byteArrayOf(1, 2), filename = "report.pdf")
        )

        viewModel.viewDocument(doc)
        advanceUntilIdle()

        assertNotNull(viewModel.uiState.value.pendingOpenDocumentData)
        viewModel.clearPendingOpenDocument()
        viewModel.downloadDocument(doc)
        advanceTimeBy(50)
        assertNull(viewModel.uiState.value.downloadedDocumentData)
        assertEquals(NotificationType.ERROR, viewModel.uiState.value.activeNotification?.type)
    }

    @Test
    fun printDocument_updatesFilenameFromContentDispositionHeader() = runTest(testDispatcher) {
        viewModel.selectQuarry(Quarry("q-1", "North Quarry", permissions = QuarryPermission(canView = true, canDownload = true)))
        advanceUntilIdle()
        val doc = Document(
            id = "d-arabic-3",
            quarryId = "q-1",
            displayName = "أمر تشغيل",
            originalFilename = "placeholder.pdf",
            mimeType = "application/pdf",
            sizeBytes = 512,
            status = "available",
            createdAt = "2026-10-25T12:00:00Z"
        )
        fakeRepository.downloadPayloadResult = ApiResult.Success(
            DownloadedDocumentPayload(
                bytes = ByteArray(12),
                filename = "أمر تشغيل معتمد.pdf"
            )
        )

        viewModel.printDocument(doc)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("أمر تشغيل معتمد.pdf", state.pendingPrintDocumentData?.first?.originalFilename)
    }

    @Test
    fun app_isArabicOnlyByDefault() {
        assertTrue(viewModel.uiState.value.isArabic)
    }

    @Test
    fun login_credentialsError() = runTest(testDispatcher) {
        fakeRepository.loginResult = ApiResult.Error(
            statusCode = 401,
            message = "Invalid username or password",
            code = "invalid_grant"
        )

        viewModel.onEmailChanged("worker@quarry.com")
        viewModel.onPasswordChanged("wrong-password")
        viewModel.login()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isAuthenticated)
        assertFalse(state.isAuthenticating)
        assertNull(state.profile)
        assertNotNull(state.loginError)
        assertTrue(state.loginError!!.english.contains("Incorrect username or password"))
        assertTrue(state.loginError!!.arabic.contains("اسم المستخدم أو كلمة المرور غير صحيحة"))
    }

    @Test
    fun login_backendUnprovisionedUser403() = runTest(testDispatcher) {
        fakeRepository.loginResult = ApiResult.Success(
            AuthTokenResponse(
                accessToken = "valid-jwt-unprovisioned",
                refreshToken = "unprov-refresh",
                user = UserOut(
                    id = "unprov-uuid",
                    username = "unprov",
                    email = "unprov@quarry.com",
                    fullName = "Unprovisioned Worker",
                    status = "active",
                    mustChangePassword = false
                )
            )
        )
        fakeRepository.profileResult = ApiResult.Error(
            statusCode = 403,
            message = "user not provisioned"
        )

        viewModel.onEmailChanged("unprov@quarry.com")
        viewModel.onPasswordChanged("password")
        viewModel.login()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isAuthenticated)
        assertNull(state.profile)
        assertNotNull(state.loginError)
        assertTrue(state.loginError!!.english.contains("not provisioned"))
        assertTrue(state.loginError!!.arabic.contains("غير مسجل في منظومة محاجر"))
    }

    @Test
    fun logout_clearsStateAndSession() = runTest(testDispatcher) {
        viewModel.onEmailChanged("worker@quarry.com")
        viewModel.onPasswordChanged("password")
        viewModel.login()
        advanceUntilIdle()

        assertTrue(viewModel.uiState.value.isAuthenticated)
        assertTrue(fakeRepository.sessionStorage.hasActiveSession())

        viewModel.logout()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isAuthenticated)
        assertNull(viewModel.uiState.value.profile)
        assertEquals("", viewModel.uiState.value.password)
        assertEquals(AppScreen.LOGIN, viewModel.uiState.value.currentScreen)
        assertFalse(fakeRepository.sessionStorage.hasActiveSession())
    }

    // =========================================================================
    // Critical Bug Fixes Regression Suite (Form input, Refresh, Overflow Menu, Download, Print)
    // =========================================================================

    @Test
    fun createQuarry_formFieldsAcceptInputAndResetCleanly() {
        viewModel.openCreateQuarryDialog()
        assertTrue(viewModel.uiState.value.isCreateQuarryDialogVisible)
        assertEquals("", viewModel.uiState.value.newQuarryName)
        assertEquals("", viewModel.uiState.value.newQuarryNumber)
        assertEquals("", viewModel.uiState.value.newQuarryType)

        // Type into all fields (Arabic and English)
        viewModel.onNewQuarryNameChanged("محجر الرخام الشرقي")
        viewModel.onNewQuarryNumberChanged("Q-2026/A")
        viewModel.onNewQuarryTypeChanged("رخام أبيض")

        assertEquals("محجر الرخام الشرقي", viewModel.uiState.value.newQuarryName)
        assertEquals("Q-2026/A", viewModel.uiState.value.newQuarryNumber)
        assertEquals("رخام أبيض", viewModel.uiState.value.newQuarryType)

        // Edit text
        viewModel.onNewQuarryNameChanged("Eastern Marble Quarry")
        assertEquals("Eastern Marble Quarry", viewModel.uiState.value.newQuarryName)

        // Re-open resets all fields
        viewModel.openCreateQuarryDialog()
        assertEquals("", viewModel.uiState.value.newQuarryName)
        assertEquals("", viewModel.uiState.value.newQuarryNumber)
        assertEquals("", viewModel.uiState.value.newQuarryType)
    }

    @Test
    fun applicationLanguage_initializesAsArabic() = runTest(testDispatcher) {
        assertTrue(viewModel.uiState.value.isArabic)
        advanceUntilIdle()
    }

    @Test
    fun createQuarry_validationFailsIfAnyFieldEmpty() = runTest(testDispatcher) {
        viewModel.openCreateQuarryDialog()

        // Missing name
        viewModel.onNewQuarryNameChanged("")
        viewModel.onNewQuarryNumberChanged("101")
        viewModel.onNewQuarryTypeChanged("Granite")
        viewModel.createQuarry()
        assertNotNull(viewModel.uiState.value.createQuarryError)
        assertTrue(viewModel.uiState.value.createQuarryError!!.arabic.contains("يرجى إدخال جميع البيانات"))

        // Missing number
        viewModel.onNewQuarryNameChanged("Quarry")
        viewModel.onNewQuarryNumberChanged("")
        viewModel.createQuarry()
        assertNotNull(viewModel.uiState.value.createQuarryError)

        // Missing type
        viewModel.onNewQuarryNumberChanged("102")
        viewModel.onNewQuarryTypeChanged("")
        viewModel.createQuarry()
        assertNotNull(viewModel.uiState.value.createQuarryError)
    }

    @Test
    fun pullToRefresh_networkError_resetsIsRefreshingSafely() = runTest(testDispatcher) {
        fakeRepository.quarriesResult = ApiResult.NetworkError(java.io.IOException("Connection timeout"))
        viewModel.refreshQuarries()
        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.isRefreshingQuarries)

        fakeRepository.foldersResult = ApiResult.NetworkError(java.io.IOException("Connection timeout"))
        viewModel.refreshQuarryContent("q-1", null)
        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.isRefreshingContent)

        fakeRepository.trashResult = ApiResult.NetworkError(java.io.IOException("Connection timeout"))
        viewModel.refreshTrash("q-1")
        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.isRefreshingTrash)
    }

    @Test
    fun downloadDocument_duplicateTap_preventsConcurrentRequests() = runTest(testDispatcher) {
        viewModel.selectQuarry(Quarry("q-1", "North Quarry", permissions = QuarryPermission(canView = true, canDownload = true)))
        advanceUntilIdle()
        val doc = Document(
            id = "d-concurrent",
            quarryId = "q-1",
            folderId = null,
            displayName = "Contract",
            originalFilename = "contract.pdf",
            mimeType = "application/pdf",
            sizeBytes = 2048,
            status = "available",
            createdAt = "2026-10-25T12:00:00Z"
        )
        fakeRepository.downloadPayloadResult = ApiResult.Success(
            DownloadedDocumentPayload(bytes = ByteArray(10), filename = "contract.pdf")
        )

        viewModel.downloadDocument(doc)
        assertTrue(viewModel.uiState.value.isDownloading)

        // Duplicate tap while downloading should be ignored
        viewModel.downloadDocument(doc)
        assertEquals("d-concurrent", viewModel.uiState.value.downloadingDocumentId)

        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.isDownloading)
    }

    @Test
    fun download_view_print_actions_areCompletelySeparated() = runTest(testDispatcher) {
        viewModel.selectQuarry(Quarry("q-1", "North Quarry", permissions = QuarryPermission(canView = true, canDownload = true)))
        advanceUntilIdle()
        val doc = Document(
            id = "d-separate",
            quarryId = "q-1",
            folderId = null,
            displayName = "Survey",
            originalFilename = "survey.pdf",
            mimeType = "application/pdf",
            sizeBytes = 1000,
            status = "available",
            createdAt = "2026-10-25T12:00:00Z"
        )
        fakeRepository.downloadPayloadResult = ApiResult.Success(
            DownloadedDocumentPayload(bytes = ByteArray(25), filename = "survey.pdf")
        )

        // 1. Download
        viewModel.downloadDocument(doc)
        advanceUntilIdle()
        assertNotNull(viewModel.uiState.value.downloadedDocumentData)
        assertNull(viewModel.uiState.value.pendingOpenDocumentData)
        assertNull(viewModel.uiState.value.pendingPrintDocumentData)
        viewModel.clearDownloadedDocumentData()
        assertNull(viewModel.uiState.value.downloadedDocumentData)

        // 2. View
        viewModel.viewDocument(doc)
        advanceUntilIdle()
        assertNull(viewModel.uiState.value.downloadedDocumentData)
        assertNotNull(viewModel.uiState.value.pendingOpenDocumentData)
        assertNull(viewModel.uiState.value.pendingPrintDocumentData)
        viewModel.clearPendingOpenDocument()
        assertNull(viewModel.uiState.value.pendingOpenDocumentData)

        // 3. Print
        viewModel.printDocument(doc)
        advanceUntilIdle()
        assertNull(viewModel.uiState.value.downloadedDocumentData)
        assertNull(viewModel.uiState.value.pendingOpenDocumentData)
        assertNotNull(viewModel.uiState.value.pendingPrintDocumentData)
        viewModel.clearPendingPrintDocument()
        assertNull(viewModel.uiState.value.pendingPrintDocumentData)
    }

    @Test
    fun legacyDiagnosticsNotPresentInUiState() {
        val state = viewModel.uiState.value
        assertEquals("http://10.0.2.2:8000", state.backendBaseUrl)
        assertFalse(state.isAuthenticated)
        assertEquals(AppScreen.LOGIN, state.currentScreen)
    }

    @Test
    fun openAndDismissCreateQuarryDialog() {
        assertFalse(viewModel.uiState.value.isCreateQuarryDialogVisible)
        viewModel.openCreateQuarryDialog()
        assertTrue(viewModel.uiState.value.isCreateQuarryDialogVisible)
        assertEquals("", viewModel.uiState.value.newQuarryName)

        viewModel.onNewQuarryNameChanged("Alabaster Quarry")
        assertEquals("Alabaster Quarry", viewModel.uiState.value.newQuarryName)

        viewModel.dismissCreateQuarryDialog()
        assertFalse(viewModel.uiState.value.isCreateQuarryDialogVisible)
    }

    @Test
    fun createQuarry_emptyName_failsLocally() = runTest(testDispatcher) {
        viewModel.openCreateQuarryDialog()
        viewModel.onNewQuarryNameChanged("   ")
        viewModel.createQuarry()
        advanceUntilIdle()

        assertNotNull(viewModel.uiState.value.createQuarryError)
        assertTrue(viewModel.uiState.value.isCreateQuarryDialogVisible)
        assertFalse(viewModel.uiState.value.isCreatingQuarry)
    }

    @Test
    fun createQuarry_success_updatesListAndClosesDialog() = runTest(testDispatcher) {
        fakeRepository.createQuarryResult = ApiResult.Success(
            Quarry(
                id = "q-new",
                name = "محجر أسوان الجديد",
                status = "active",
                permissions = QuarryPermission(canView = true, canUpload = false, canDownload = false)
            )
        )
        fakeRepository.quarriesResult = ApiResult.Success(
            listOf(
                Quarry("q-1", "North Quarry", "active", QuarryPermission(true, true, true)),
                Quarry("q-new", "محجر أسوان الجديد", "active", QuarryPermission(true, false, false))
            )
        )

        viewModel.openCreateQuarryDialog()
        viewModel.onNewQuarryNameChanged("محجر أسوان الجديد")
        viewModel.onNewQuarryNumberChanged("101")
        viewModel.onNewQuarryTypeChanged("جرانيت")
        viewModel.createQuarry()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isCreatingQuarry)
        assertFalse(viewModel.uiState.value.isCreateQuarryDialogVisible)
        assertNotNull(viewModel.uiState.value.createQuarrySuccessMessage)
        assertTrue(viewModel.uiState.value.quarries.any { it.name == "محجر أسوان الجديد" })

        viewModel.clearCreateQuarrySuccessMessage()
        assertNull(viewModel.uiState.value.createQuarrySuccessMessage)
    }

    @Test
    fun createQuarry_duplicateError_setsAppropriateError() = runTest(testDispatcher) {
        fakeRepository.createQuarryResult = ApiResult.Error(
            statusCode = 409,
            message = "a quarry with this name already exists"
        )

        viewModel.openCreateQuarryDialog()
        viewModel.onNewQuarryNameChanged("North Quarry")
        viewModel.onNewQuarryNumberChanged("102")
        viewModel.onNewQuarryTypeChanged("رخام")
        viewModel.createQuarry()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isCreatingQuarry)
        assertTrue(viewModel.uiState.value.isCreateQuarryDialogVisible)
        val err = viewModel.uiState.value.createQuarryError
        assertNotNull(err)
        assertTrue(err!!.arabic.contains("بالفعل"))
    }

    @Test
    fun createQuarry_forbidden_setsPermissionError() = runTest(testDispatcher) {
        fakeRepository.createQuarryResult = ApiResult.Error(
            statusCode = 403,
            message = "user is not active"
        )

        viewModel.openCreateQuarryDialog()
        viewModel.onNewQuarryNameChanged("Unauthorized Pit")
        viewModel.onNewQuarryNumberChanged("103")
        viewModel.onNewQuarryTypeChanged("حجر جيري")
        viewModel.createQuarry()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isCreatingQuarry)
        val err = viewModel.uiState.value.createQuarryError
        assertNotNull(err)
        assertTrue(err!!.arabic.contains("الصلاحية") || err.arabic.contains("نشط"))
    }

    @Test
    fun createQuarry_unexpectedExceptionShowsErrorAndAlwaysClearsBusyState() = runTest(testDispatcher) {
        fakeRepository.createQuarryException = IllegalStateException("unexpected")
        viewModel.openCreateQuarryDialog()
        viewModel.onNewQuarryNameChanged("North Quarry")
        viewModel.onNewQuarryNumberChanged("101")
        viewModel.onNewQuarryTypeChanged("Granite")

        viewModel.createQuarry()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isCreatingQuarry)
        assertTrue(viewModel.uiState.value.isCreateQuarryDialogVisible)
        assertEquals("Failed to create the quarry. Please try again.", viewModel.uiState.value.createQuarryError?.english)
    }

    @Test
    fun createQuarry_cancellationClearsBusyStateWithoutShowingFailure() = runTest(testDispatcher) {
        fakeRepository.createQuarryException = java.util.concurrent.CancellationException("cancelled")
        viewModel.openCreateQuarryDialog()
        viewModel.onNewQuarryNameChanged("North Quarry")
        viewModel.onNewQuarryNumberChanged("101")
        viewModel.onNewQuarryTypeChanged("Granite")

        viewModel.createQuarry()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isCreatingQuarry)
        assertNull(viewModel.uiState.value.createQuarryError)
        viewModel.openCreateQuarryDialog()
        assertFalse(viewModel.uiState.value.isCreatingQuarry)
    }

    @Test
    fun createQuarry_duplicateSubmissionIsIgnoredUntilRequestFinishes() = runTest(testDispatcher) {
        val requestGate = CompletableDeferred<Unit>()
        fakeRepository.createQuarryGate = requestGate
        viewModel.openCreateQuarryDialog()
        viewModel.onNewQuarryNameChanged("North Quarry")
        viewModel.onNewQuarryNumberChanged("101")
        viewModel.onNewQuarryTypeChanged("Granite")

        viewModel.createQuarry()
        viewModel.createQuarry()
        viewModel.dismissCreateQuarryDialog()
        testScheduler.runCurrent()

        assertEquals(1, fakeRepository.createQuarryCalls)
        assertTrue(viewModel.uiState.value.isCreatingQuarry)
        assertTrue(viewModel.uiState.value.isCreateQuarryDialogVisible)

        requestGate.complete(Unit)
        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.isCreatingQuarry)
    }

    @Test
    fun navigateUpFolder_fromSubfolder_navigatesToParentFolder() = runTest(testDispatcher) {
        val quarry = Quarry("q-1", "North Pit", "active")
        fakeRepository.foldersResult = ApiResult.Success(
            listOf(
                Folder(id = "parent-f", quarryId = "q-1", parentId = null, name = "Parent Folder"),
                Folder(id = "child-f", quarryId = "q-1", parentId = "parent-f", name = "Child Folder")
            )
        )

        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        // Enter child folder
        viewModel.selectFolder("child-f")
        advanceUntilIdle()
        assertEquals("child-f", viewModel.uiState.value.currentFolderId)

        // Navigate up -> should be parent-f
        viewModel.navigateUpFolder()
        advanceUntilIdle()
        assertEquals("parent-f", viewModel.uiState.value.currentFolderId)

        // Navigate up again -> should be root (null)
        viewModel.navigateUpFolder()
        advanceUntilIdle()
        assertNull(viewModel.uiState.value.currentFolderId)
        assertEquals(AppScreen.QUARRY_DETAIL, viewModel.uiState.value.currentScreen)

        // Navigate up from root -> should return to HOME
        viewModel.navigateUpFolder()
        advanceUntilIdle()
        assertEquals(AppScreen.HOME, viewModel.uiState.value.currentScreen)
    }

    @Test
    fun deleteDocument_success_movesToTrashAndUpdatesMessages() = runTest(testDispatcher) {
        val quarry = Quarry("q-1", "North Pit", "active", QuarryPermission(canView = true, canUpload = false, canDelete = true))
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        viewModel.deleteDocument("q-1", "d-1", 1)
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isDeletingDocument)
        assertNotNull(viewModel.uiState.value.deleteSuccessMessage)
        assertNull(viewModel.uiState.value.deleteDocumentError)
    }

    @Test
    fun deleteDocument_permissionDenied_setsErrorWithoutCallingRepo() = runTest(testDispatcher) {
        val quarry = Quarry("q-1", "North Pit", "active", QuarryPermission(canView = true, canUpload = true, canDelete = false))
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        viewModel.deleteDocument("q-1", "d-1", 1)
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isDeletingDocument)
        assertNull(viewModel.uiState.value.deleteSuccessMessage)
        assertNotNull(viewModel.uiState.value.deleteDocumentError)
        assertEquals("You do not have permission to delete documents in this quarry.", viewModel.uiState.value.deleteDocumentError?.english)
        assertEquals("ليس لديك صلاحية حذف المستندات في هذا المحجر.", viewModel.uiState.value.deleteDocumentError?.arabic)
    }

    @Test
    fun loadTrash_and_restoreDocument_success() = runTest(testDispatcher) {
        val quarry = Quarry("q-1", "North Pit", "active")
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        viewModel.navigateToTrash("q-1")
        advanceUntilIdle()

        assertEquals(AppScreen.TRASH, viewModel.uiState.value.currentScreen)
        assertEquals(1, viewModel.uiState.value.trashDocuments.size)
        assertEquals("Old Report", viewModel.uiState.value.trashDocuments[0].displayName)

        // Restore document
        viewModel.restoreDocument("q-1", "trash-1", 1)
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isRestoringDocument)
        assertNotNull(viewModel.uiState.value.restoreSuccessMessage)
        assertNull(viewModel.uiState.value.restoreError)
    }

    // =========================================================================
    // Phase 9: App-Wide Floating Notifications Tests
    // =========================================================================

    @Test
    fun notification_showsSuccessOnSuccessfulOperation() = runTest(testDispatcher) {
        val quarry = Quarry("q-1", "North Pit", "active", QuarryPermission(canView = true, canUpload = true, canDelete = true))
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        viewModel.deleteDocument("q-1", "d-1", 1)
        testScheduler.runCurrent()

        val notif = viewModel.uiState.value.activeNotification
        assertNotNull(notif)
        assertEquals(NotificationType.SUCCESS, notif?.type)
        assertEquals("Document moved to trash.", notif?.message?.english)
        assertEquals("تم نقل المستند إلى سلة المهملات بنجاح.", notif?.message?.arabic)
    }

    @Test
    fun notification_showsErrorOnFailedOperation() = runTest(testDispatcher) {
        val quarry = Quarry("q-1", "North Pit", "active", QuarryPermission(canView = true, canUpload = true, canDelete = false))
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        viewModel.deleteDocument("q-1", "d-1", 1)
        testScheduler.runCurrent()

        val notif = viewModel.uiState.value.activeNotification
        assertNotNull(notif)
        assertEquals(NotificationType.ERROR, notif?.type)
        assertEquals("You do not have permission to delete documents in this quarry.", notif?.message?.english)
        assertEquals("ليس لديك صلاحية حذف المستندات في هذا المحجر.", notif?.message?.arabic)
    }

    @Test
    fun notification_autoDismissesAfterDuration() = runTest(testDispatcher) {
        viewModel.showNotification(
            LocalizedMessage(english = "Auto dismiss test", arabic = "اختبار الإخفاء التلقائي"),
            NotificationType.INFO,
            3000L
        )

        assertNotNull(viewModel.uiState.value.activeNotification)
        assertEquals("Auto dismiss test", viewModel.uiState.value.activeNotification?.message?.english)

        // Advance before 3 seconds
        advanceTimeBy(1500)
        assertNotNull(viewModel.uiState.value.activeNotification)

        // Advance past 3 seconds
        advanceTimeBy(1600)
        assertNull(viewModel.uiState.value.activeNotification)
    }

    @Test
    fun notification_immediateDismissalOnUserAction() = runTest(testDispatcher) {
        viewModel.showNotification(
            LocalizedMessage(english = "Swipe to dismiss", arabic = "اسحب للإغلاق"),
            NotificationType.WARNING,
            5000L
        )

        val notifId = viewModel.uiState.value.activeNotification?.id
        assertNotNull(notifId)

        // User dismisses (swipe or close button)
        viewModel.dismissNotification(notifId)
        assertNull(viewModel.uiState.value.activeNotification)
    }

    @Test
    fun notification_consecutiveNotificationsCancelStaleTimers() = runTest(testDispatcher) {
        viewModel.showNotification(
            LocalizedMessage(english = "First Notification", arabic = "الإشعار الأول"),
            NotificationType.INFO,
            3000L
        )
        val firstId = viewModel.uiState.value.activeNotification?.id

        // Advance 2 seconds
        advanceTimeBy(2000)
        assertNotNull(viewModel.uiState.value.activeNotification)

        // Second notification arrives before the first expires
        viewModel.showNotification(
            LocalizedMessage(english = "Second Notification", arabic = "الإشعار الثاني"),
            NotificationType.SUCCESS,
            3000L
        )
        val secondId = viewModel.uiState.value.activeNotification?.id
        assertFalse(firstId == secondId)
        assertEquals("Second Notification", viewModel.uiState.value.activeNotification?.message?.english)

        // Advance 1.5 seconds (at total 3.5s; the first notification's timer would have fired at 3.0s)
        advanceTimeBy(1500)
        // Second notification must STILL be active
        assertNotNull(viewModel.uiState.value.activeNotification)
        assertEquals(secondId, viewModel.uiState.value.activeNotification?.id)

        // Advance past second notification's duration
        advanceTimeBy(1600)
        assertNull(viewModel.uiState.value.activeNotification)
    }

    @Test
    fun notification_sanitizesSensitiveErrors() = runTest(testDispatcher) {
        val sensitiveSql = LocalizedMessage(
            english = "Internal error: SELECT * FROM users WHERE password = 'secret'",
            arabic = "خطأ داخلي"
        )
        viewModel.showNotification(sensitiveSql, NotificationType.ERROR)

        val notif = viewModel.uiState.value.activeNotification
        assertNotNull(notif)
        assertEquals("An unexpected error occurred. Please try again.", notif?.message?.english)
        assertEquals("حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.", notif?.message?.arabic)
    }

    // =========================================================================
    // Phase 10: Pull-to-Refresh Gesture Tests
    // =========================================================================

    @Test
    fun pullToRefresh_quarriesSuccess_updatesStateAndShowsNotification() = runTest(testDispatcher) {
        viewModel.refreshQuarries()
        advanceTimeBy(50)

        assertFalse(viewModel.uiState.value.isRefreshingQuarries)
        assertEquals(1, viewModel.uiState.value.quarries.size)
        assertEquals("North Quarry", viewModel.uiState.value.quarries[0].name)

        val notif = viewModel.uiState.value.activeNotification
        assertNotNull(notif)
        assertEquals(NotificationType.SUCCESS, notif?.type)
        assertEquals("Quarry list updated.", notif?.message?.english)
    }

    @Test
    fun pullToRefresh_quarriesFailure_preservesExistingDataAndShowsError() = runTest(testDispatcher) {
        // Pre-populate quarries
        viewModel.refreshQuarries()
        advanceUntilIdle()
        assertEquals(1, viewModel.uiState.value.quarries.size)

        // Simulate failure on next refresh
        fakeRepository.quarriesResult = ApiResult.Error(500, "Internal Server Error")
        viewModel.refreshQuarries()
        advanceTimeBy(50)

        assertFalse(viewModel.uiState.value.isRefreshingQuarries)
        // Existing usable content preserved
        assertEquals(1, viewModel.uiState.value.quarries.size)

        val notif = viewModel.uiState.value.activeNotification
        assertNotNull(notif)
        assertEquals(NotificationType.ERROR, notif?.type)
        assertTrue(notif?.message?.english?.contains("Internal Server Error") == true)
    }

    @Test
    fun pullToRefresh_quarriesUnexpectedException_showsErrorAndClearsIndicator() = runTest(testDispatcher) {
        fakeRepository.getQuarriesException = IllegalStateException("unexpected")

        viewModel.refreshQuarries()
        advanceTimeBy(50)

        assertFalse(viewModel.uiState.value.isRefreshingQuarries)
        assertEquals(NotificationType.ERROR, viewModel.uiState.value.activeNotification?.type)
        assertEquals(
            "Failed to refresh quarries. Please try again.",
            viewModel.uiState.value.activeNotification?.message?.english
        )
    }

    @Test
    fun pullToRefresh_quarriesCancellation_clearsIndicatorWithoutErrorNotification() = runTest(testDispatcher) {
        fakeRepository.getQuarriesException = java.util.concurrent.CancellationException("cancelled")

        viewModel.refreshQuarries()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isRefreshingQuarries)
        assertNull(viewModel.uiState.value.activeNotification)
    }

    @Test
    fun pullToRefresh_networkErrors_clearBothIndicatorsAndShowErrors() = runTest(testDispatcher) {
        fakeRepository.quarriesResult = ApiResult.NetworkError(java.io.IOException("offline"))
        viewModel.refreshQuarries()
        advanceTimeBy(50)

        assertFalse(viewModel.uiState.value.isRefreshingQuarries)
        assertEquals(NotificationType.ERROR, viewModel.uiState.value.activeNotification?.type)

        fakeRepository.foldersResult = ApiResult.NetworkError(java.io.IOException("offline"))
        viewModel.refreshQuarryContent("q-1", "folder-current")
        advanceTimeBy(50)

        assertFalse(viewModel.uiState.value.isRefreshingContent)
        assertEquals(NotificationType.ERROR, viewModel.uiState.value.activeNotification?.type)
    }

    @Test
    fun pullToRefresh_fastResultsKeepIndicatorsVisibleUntilNextFrameInterval() = runTest(testDispatcher) {
        viewModel.refreshQuarries()
        testScheduler.runCurrent()
        assertTrue(viewModel.uiState.value.isRefreshingQuarries)
        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.isRefreshingQuarries)

        viewModel.refreshQuarryContent("q-1", null)
        testScheduler.runCurrent()
        assertTrue(viewModel.uiState.value.isRefreshingContent)
        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.isRefreshingContent)

        viewModel.refreshTrash("q-1")
        testScheduler.runCurrent()
        assertTrue(viewModel.uiState.value.isRefreshingTrash)
        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.isRefreshingTrash)
    }

    @Test
    fun pullToRefresh_trashUnexpectedExceptionShowsErrorAndClearsIndicator() = runTest(testDispatcher) {
        fakeRepository.trashException = IllegalStateException("unexpected")
        viewModel.refreshTrash("q-1")
        advanceTimeBy(50)

        assertFalse(viewModel.uiState.value.isRefreshingTrash)
        assertEquals(NotificationType.ERROR, viewModel.uiState.value.activeNotification?.type)
        assertEquals("Failed to refresh trash. Please try again.", viewModel.uiState.value.activeNotification?.message?.english)
    }

    @Test
    fun pullToRefresh_trashCancellationClearsIndicatorWithoutError() = runTest(testDispatcher) {
        fakeRepository.trashException = java.util.concurrent.CancellationException("cancelled")
        viewModel.refreshTrash("q-1")
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isRefreshingTrash)
        assertNull(viewModel.uiState.value.activeNotification)
    }

    @Test
    fun pullToRefresh_contentSuccess_updatesFoldersAndDocuments() = runTest(testDispatcher) {
        viewModel.refreshQuarryContent("q-1", null)
        advanceTimeBy(50)

        assertFalse(viewModel.uiState.value.isRefreshingContent)
        assertEquals(1, viewModel.uiState.value.folders.size)
        assertEquals("Site Photos", viewModel.uiState.value.folders[0].name)
        assertEquals(1, viewModel.uiState.value.documents.size)
        assertEquals("Daily Log", viewModel.uiState.value.documents[0].displayName)

        val notif = viewModel.uiState.value.activeNotification
        assertNotNull(notif)
        assertEquals(NotificationType.SUCCESS, notif?.type)
        assertEquals("Content updated.", notif?.message?.english)
    }

    @Test
    fun pullToRefresh_quarryContent_neverPassesFolderIdAsAuthToken() = runTest(testDispatcher) {
        viewModel.refreshQuarryContent("q-test-1", "folder-sub-88")
        advanceUntilIdle()

        assertEquals("q-test-1", fakeRepository.lastGetFoldersQuarryId)
        assertNull("folderId must never be passed as token to getFolders!", fakeRepository.lastGetFoldersToken)
    }

    @Test
    fun pullToRefresh_quarryContent_authError_mapsToCleanArabicMessageWithoutRawCredentialsError() = runTest(testDispatcher) {
        fakeRepository.foldersResult = ApiResult.Error(401, "invalid or missing credentials")

        viewModel.refreshQuarryContent("q-1", null)
        advanceTimeBy(50)

        val notif = viewModel.uiState.value.activeNotification
        assertNotNull(notif)
        assertEquals(NotificationType.ERROR, notif?.type)
        // Ensure the raw technical backend error is not exposed to the user
        assertFalse(notif!!.message.arabic.contains("invalid or missing credentials"))
        // Ensure mapped message provides a clear Arabic explanation
        assertTrue(notif.message.arabic.isNotBlank())
    }

    @Test
    fun pullToRefresh_contentUnexpectedException_showsErrorAndClearsIndicator() = runTest(testDispatcher) {
        fakeRepository.getDocumentsException = IllegalStateException("unexpected")

        viewModel.refreshQuarryContent("q-1", "folder-current")
        advanceTimeBy(50)

        assertFalse(viewModel.uiState.value.isRefreshingContent)
        assertEquals("folder-current", fakeRepository.lastRequestedFolderId)
        assertEquals(NotificationType.ERROR, viewModel.uiState.value.activeNotification?.type)
        assertEquals(
            "Failed to refresh quarry contents. Please try again.",
            viewModel.uiState.value.activeNotification?.message?.english
        )
    }

    @Test
    fun pullToRefresh_trashSuccess_updatesTrashDocuments() = runTest(testDispatcher) {
        viewModel.refreshTrash("q-1")
        advanceTimeBy(50)

        assertFalse(viewModel.uiState.value.isRefreshingTrash)
        assertEquals(1, viewModel.uiState.value.trashDocuments.size)
        assertEquals("Old Report", viewModel.uiState.value.trashDocuments[0].displayName)

        val notif = viewModel.uiState.value.activeNotification
        assertNotNull(notif)
        assertEquals(NotificationType.SUCCESS, notif?.type)
        assertEquals("Trash updated.", notif?.message?.english)
    }

    // =========================================================================
    // Phase 11: Mandatory Password Change Workflow Tests
    // =========================================================================

    @Test
    fun passwordChange_whenMustChangePassword_navigatesToPasswordChangeScreen() = runTest(testDispatcher) {
        fakeRepository.profileResult = ApiResult.Success(
            MeResponse(
                user = UserOut(id = "u-must-change", email = "mustchange@example.com", fullName = "Must Change", status = "active", mustChangePassword = true),
                company = CompanyOut(id = "c-1", name = "Granite Co", status = "active", quotaBytes = 1000000L, maxUsers = 10, usedBytes = 5000L),
                role = "employee"
            )
        )

        viewModel.fetchProfile("test-token")
        testScheduler.runCurrent()

        assertTrue(viewModel.uiState.value.isAuthenticated)
        assertEquals(AppScreen.PASSWORD_CHANGE, viewModel.uiState.value.currentScreen)
        // Quarries should not be loaded while password change is pending
        assertTrue(viewModel.uiState.value.quarries.isEmpty())
    }

    @Test
    fun passwordChange_mismatchedPasswords_showsError() = runTest(testDispatcher) {
        viewModel.onNewPasswordChanged("SecurePass123!")
        viewModel.onConfirmPasswordChanged("DifferentPass456!")
        viewModel.changePassword()
        testScheduler.runCurrent()

        assertNotNull(viewModel.uiState.value.passwordChangeError)
        assertEquals("Passwords do not match.", viewModel.uiState.value.passwordChangeError?.english)
        assertEquals(NotificationType.ERROR, viewModel.uiState.value.activeNotification?.type)
    }

    @Test
    fun passwordChange_shortPassword_showsError() = runTest(testDispatcher) {
        viewModel.onNewPasswordChanged("short")
        viewModel.onConfirmPasswordChanged("short")
        viewModel.changePassword()
        testScheduler.runCurrent()

        assertNotNull(viewModel.uiState.value.passwordChangeError)
        assertEquals("Password must be at least 8 characters long.", viewModel.uiState.value.passwordChangeError?.english)
        assertEquals(NotificationType.ERROR, viewModel.uiState.value.activeNotification?.type)
    }

    @Test
    fun passwordChange_success_revokesSessionAndReturnsToLogin() = runTest(testDispatcher) {
        fakeRepository.sessionStorage.saveSession("test-token", "refresh-token", "worker@quarry.com")
        viewModel.onPasswordChanged("TemporaryPassword123!")
        viewModel.onNewPasswordChanged("ValidNewPassword2026!")
        viewModel.onConfirmPasswordChanged("ValidNewPassword2026!")

        viewModel.changePassword()
        testScheduler.runCurrent()

        assertEquals("TemporaryPassword123!", fakeRepository.lastCurrentPassword)
        assertEquals("", viewModel.uiState.value.newPassword)
        assertEquals("", viewModel.uiState.value.confirmPassword)
        assertEquals("", viewModel.uiState.value.password)
        assertFalse(viewModel.uiState.value.isAuthenticated)
        assertNull(viewModel.uiState.value.passwordChangeError)
        assertEquals(NotificationType.SUCCESS, viewModel.uiState.value.activeNotification?.type)
        assertEquals("Password updated successfully. Your secure session has been refreshed.", viewModel.uiState.value.activeNotification?.message?.english)
        assertEquals(AppScreen.LOGIN, viewModel.uiState.value.currentScreen)
        assertTrue(viewModel.uiState.value.quarries.isEmpty())
    }

    @Test
    fun passwordChange_logout_resetsToLoginScreen() = runTest(testDispatcher) {
        viewModel.logoutFromPasswordChange()
        testScheduler.runCurrent()

        assertFalse(viewModel.uiState.value.isAuthenticated)
        assertEquals(AppScreen.LOGIN, viewModel.uiState.value.currentScreen)
    }

    @Test
    fun login_withUsername_success() = runTest(testDispatcher) {
        viewModel.onUsernameChanged("workerone")
        viewModel.onPasswordChanged("valid-password-123")
        viewModel.login()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue(state.isAuthenticated)
        assertFalse(state.isAuthenticating)
        assertNotNull(state.profile)
        assertEquals(AppScreen.HOME, state.currentScreen)
        assertEquals("workerone", fakeRepository.sessionStorage.getUsername())
    }

    @Test
    fun login_withUsername_mandatoryPasswordChange() = runTest(testDispatcher) {
        fakeRepository.loginResult = ApiResult.Success(
            AuthTokenResponse(
                accessToken = "pwd-change-token",
                refreshToken = "pwd-change-refresh",
                user = UserOut(
                    id = "must-change-id",
                    username = "newhire",
                    email = null,
                    fullName = "New Hire",
                    status = "active",
                    mustChangePassword = true
                )
            )
        )

        viewModel.onUsernameChanged("newhire")
        viewModel.onPasswordChanged("initial-password")
        viewModel.login()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue(state.isAuthenticated)
        assertEquals(AppScreen.PASSWORD_CHANGE, state.currentScreen)
        assertEquals("initial-password", state.password)
        // A first-login account must remain at onboarding without loading any office data.
        assertTrue(state.quarries.isEmpty())
    }

    @Test
    fun login_withUsername_inactiveAccountError() = runTest(testDispatcher) {
        fakeRepository.loginResult = ApiResult.Error(
            statusCode = 401,
            message = "Account is inactive or disabled",
            code = "inactive"
        )

        viewModel.onUsernameChanged("disableduser")
        viewModel.onPasswordChanged("anypassword")
        viewModel.login()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isAuthenticated)
        assertNotNull(state.loginError)
        assertTrue(state.loginError!!.english.contains("inactive or disabled"))
        assertTrue(state.loginError!!.arabic.contains("الحساب غير مفعل"))
    }

    // =========================================================================
    // Pre-Production Overhaul Tests: Centralized Trash, 8 Standard Folders, Sessions
    // =========================================================================

    @Test
    fun createQuarry_missingFields_failsLocally() = runTest(testDispatcher) {
        viewModel.openCreateQuarryDialog()
        viewModel.onNewQuarryNameChanged("محجر جديد")
        viewModel.onNewQuarryNumberChanged("") // missing number
        viewModel.onNewQuarryTypeChanged("رخام")
        viewModel.createQuarry()
        advanceUntilIdle()

        assertNotNull(viewModel.uiState.value.createQuarryError)
        assertTrue(viewModel.uiState.value.createQuarryError!!.english.contains("all required fields"))
        assertTrue(viewModel.uiState.value.isCreateQuarryDialogVisible)
    }

    @Test
    fun createQuarry_fieldsUpdateIndependently_andSubmitTrimmedValues() = runTest(testDispatcher) {
        viewModel.openCreateQuarryDialog()
        viewModel.onNewQuarryNameChanged("  North Ridge  ")
        viewModel.onNewQuarryNumberChanged("  QR-104  ")
        viewModel.onNewQuarryTypeChanged("  Granite  ")

        val entered = viewModel.uiState.value
        assertEquals("  North Ridge  ", entered.newQuarryName)
        assertEquals("  QR-104  ", entered.newQuarryNumber)
        assertEquals("  Granite  ", entered.newQuarryType)
        assertTrue(entered.newQuarryName.isNotBlank() && entered.newQuarryNumber.isNotBlank() && entered.newQuarryType.isNotBlank())

        viewModel.createQuarry()
        advanceUntilIdle()

        assertEquals("North Ridge", fakeRepository.lastCreatedQuarryName)
        assertEquals("QR-104", fakeRepository.lastCreatedQuarryNumber)
        assertEquals("Granite", fakeRepository.lastCreatedQuarryType)
        assertFalse(viewModel.uiState.value.isCreateQuarryDialogVisible)
    }

    @Test
    fun navigateToTrash_companyWide_loadsCentralizedTrash() = runTest(testDispatcher) {
        fakeRepository.trashResult = ApiResult.Success(
            listOf(
                TrashDocument(
                    id = "trash-101",
                    quarryId = "q-1",
                    quarryName = "محجر أسوان",
                    folderId = "f-1",
                    folderName = "بطاقة شخصية",
                    displayName = "بطاقة الرقم القومي.pdf",
                    originalFilename = "id.pdf",
                    mimeType = "application/pdf",
                    sizeBytes = 2048,
                    version = 1,
                    createdAt = "2026-10-20T10:00:00Z",
                    deletedAt = "2026-10-25T14:00:00Z",
                    deletedByName = "أحمد محمود",
                    canRestore = true,
                    retentionExpiresAt = "2026-11-24T14:00:00Z"
                )
            )
        )

        // Navigate to trash without selecting a quarry (Company-wide Trash)
        viewModel.navigateToTrash()
        advanceUntilIdle()

        assertEquals(AppScreen.TRASH, viewModel.uiState.value.currentScreen)
        assertNull(viewModel.uiState.value.selectedQuarry)
        assertEquals(1, viewModel.uiState.value.trashDocuments.size)
        val doc = viewModel.uiState.value.trashDocuments[0]
        assertEquals("محجر أسوان", doc.quarryName)
        assertEquals("بطاقة شخصية", doc.folderName)
        assertEquals("أحمد محمود", doc.deletedByName)

        // Restore through centralized trash
        viewModel.restoreDocument(doc.quarryId, doc.id, doc.version)
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isRestoringDocument)
        assertNotNull(viewModel.uiState.value.restoreSuccessMessage)
    }

    @Test
    fun restoreDocument_conflict409_setsArabicConflictErrorMessage() = runTest(testDispatcher) {
        fakeRepository.restoreResult = ApiResult.Error(
            statusCode = 409,
            message = "يوجد ملف بنفس الاسم بالفعل في هذا المجلد"
        )

        val quarry = Quarry("q-1", "North Pit", "active")
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        viewModel.restoreDocument("q-1", "trash-dup", 1)
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isRestoringDocument)
        val err = viewModel.uiState.value.restoreError
        assertNotNull(err)
        assertTrue(err!!.arabic.contains("بنفس الاسم بالفعل"))
    }

    @Test
    fun sessionPersistence_autoRestoresProfileOnStartup() = runTest(testDispatcher) {
        val storage = InMemorySessionStorage()
        storage.saveSession("stored-jwt-token-789", "refresh-token-xyz", "saveduser")
        val customRepo = FakeEmployeeRepository(storage)
        val restoredViewModel = EmployeeAppViewModel(customRepo)
        advanceUntilIdle()

        assertTrue(restoredViewModel.uiState.value.isAuthenticated)
        assertEquals("Worker One", restoredViewModel.uiState.value.profile?.user?.fullName)
        assertEquals(AppScreen.HOME, restoredViewModel.uiState.value.currentScreen)
    }

    @Test
    fun navigateToProfile_setsProfileScreen() {
        viewModel.navigateToProfile()
        assertEquals(AppScreen.PROFILE, viewModel.uiState.value.currentScreen)

        viewModel.navigateBackFromProfile()
        assertEquals(AppScreen.HOME, viewModel.uiState.value.currentScreen)
    }

    @Test
    fun updateProfile_validName_updatesStateAndProfile() = runTest(testDispatcher) {
        viewModel.fetchProfile("dummy-token")
        advanceUntilIdle()

        viewModel.updateFullName("Ahmed Ali")
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isUpdatingProfile)
        assertNull(viewModel.uiState.value.profileUpdateError)
        assertNotNull(viewModel.uiState.value.profileUpdateSuccessMessage)
        assertEquals("Updated Worker Name", viewModel.uiState.value.profile?.user?.fullName)
    }

    @Test
    fun updateProfile_tooShortName_setsValidationError() = runTest(testDispatcher) {
        viewModel.updateFullName("A")
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isUpdatingProfile)
        assertNotNull(viewModel.uiState.value.profileUpdateError)
        assertTrue(viewModel.uiState.value.profileUpdateError!!.arabic.contains("بين حرفين و 100 حرف"))
    }

    @Test
    fun createFolder_validName_createsAndRefreshesList() = runTest(testDispatcher) {
        val quarry = Quarry("q-1", "Test Quarry", "active")
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        fakeRepository.foldersResult = ApiResult.Success(
            listOf(
                Folder("f-1", "q-1", null, "Site Photos"),
                Folder("f-new", "q-1", null, "Invoices 2026")
            )
        )

        viewModel.createFolder("q-1", "Invoices 2026")
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isCreatingFolder)
        assertNull(viewModel.uiState.value.createFolderError)
        assertNotNull(viewModel.uiState.value.createFolderSuccessMessage)
        assertTrue(viewModel.uiState.value.folders.any { it.name == "Invoices 2026" || it.id == "f-new" })
    }

    @Test
    fun createFolder_emptyName_setsValidationError() = runTest(testDispatcher) {
        viewModel.createFolder("q-1", "   ")
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isCreatingFolder)
        assertNotNull(viewModel.uiState.value.createFolderError)
        assertTrue(viewModel.uiState.value.createFolderError!!.arabic.contains("لا يمكن أن يكون اسم المجلد فارغاً"))
    }

    @Test
    fun deleteFolder_success_removesFromFoldersList() = runTest(testDispatcher) {
        val quarry = Quarry("q-1", "Test Quarry", "active", permissions = QuarryPermission(canDelete = true))
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        fakeRepository.foldersResult = ApiResult.Success(emptyList())

        viewModel.deleteFolder("q-1", "f-1")
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isDeletingFolder)
        assertNull(viewModel.uiState.value.deleteFolderError)
        assertNotNull(viewModel.uiState.value.deleteFolderSuccessMessage)
        assertFalse(viewModel.uiState.value.folders.any { it.id == "f-1" })
    }

    @Test
    fun singleSessionInvalidation_autoLogsOut_andShowsClearMessage() = runTest(testDispatcher) {
        viewModel.onEmailChanged("worker@quarry.com")
        viewModel.onPasswordChanged("valid-password-123")
        viewModel.login()
        advanceUntilIdle()

        assertTrue(viewModel.uiState.value.isAuthenticated)

        // Simulate session invalidation from backend
        fakeRepository.quarriesResult = ApiResult.Error(
            statusCode = 401,
            message = "session_terminated_by_new_login",
            code = "SESSION_INVALIDATED"
        )

        viewModel.loadQuarries()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isAuthenticated)
        assertEquals(AppScreen.LOGIN, viewModel.uiState.value.currentScreen)
        assertEquals("تم تسجيل الدخول من جهاز آخر", viewModel.uiState.value.loginError?.arabic)
        assertFalse(fakeRepository.hasStoredSession())
    }

    @Test
    fun companyAdmin_canNavigateToEmployeeManagement_andLoadEmployees() = runTest(testDispatcher) {
        // Set profile as company_admin
        fakeRepository.profileResult = ApiResult.Success(
            MeResponse(
                user = UserOut(id = "u-admin", email = "admin@quarry.com", status = "active"),
                company = CompanyOut(id = "c-1", name = "Test Co", status = "active", quotaBytes = 1000, maxUsers = 10, usedBytes = 100),
                role = "company_admin"
            )
        )
        fakeRepository.getCompanyEmployeesResult = ApiResult.Success(
            listOf(
                CompanyEmployee(
                    id = "e-1",
                    username = "emp1",
                    email = "emp1@quarry.com",
                    fullName = "Employee One",
                    status = "active",
                    role = "employee"
                )
            )
        )

        viewModel.onEmailChanged("worker@quarry.com")
        viewModel.onPasswordChanged("valid-password-123")
        viewModel.login()
        advanceUntilIdle()

        assertEquals("company_admin", viewModel.uiState.value.profile?.role)

        viewModel.navigateToEmployeeManagement()
        advanceUntilIdle()

        assertEquals(AppScreen.EMPLOYEE_MANAGEMENT, viewModel.uiState.value.currentScreen)
        assertEquals(1, viewModel.uiState.value.employees.size)
        assertEquals("emp1", viewModel.uiState.value.employees[0].username)
    }

    @Test
    fun regularEmployee_cannotNavigateToEmployeeManagement() = runTest(testDispatcher) {
        fakeRepository.profileResult = ApiResult.Success(
            MeResponse(
                user = UserOut(id = "u-emp", email = "emp@quarry.com", status = "active"),
                company = CompanyOut(id = "c-1", name = "Test Co", status = "active", quotaBytes = 1000, maxUsers = 10, usedBytes = 100),
                role = "employee"
            )
        )

        viewModel.onEmailChanged("worker@quarry.com")
        viewModel.onPasswordChanged("valid-password-123")
        viewModel.login()
        advanceUntilIdle()

        assertEquals("employee", viewModel.uiState.value.profile?.role)

        viewModel.navigateToEmployeeManagement()
        advanceUntilIdle()

        // Screen remains HOME, does not allow access
        assertEquals(AppScreen.HOME, viewModel.uiState.value.currentScreen)
    }

    @Test
    fun createEmployee_savesGranularPermissions_andDefaultsDeleteToFalse() = runTest(testDispatcher) {
        fakeRepository.profileResult = ApiResult.Success(
            MeResponse(
                user = UserOut(id = "u-admin", email = "admin@quarry.com", status = "active"),
                company = CompanyOut(id = "c-1", name = "Test Co", status = "active", quotaBytes = 1000, maxUsers = 10, usedBytes = 100),
                role = "company_admin"
            )
        )
        viewModel.onEmailChanged("worker@quarry.com")
        viewModel.onPasswordChanged("valid-password-123")
        viewModel.login()
        advanceUntilIdle()

        viewModel.openCreateEmployeeDialog()
        assertTrue(viewModel.uiState.value.isCreateEmployeeDialogVisible)

        viewModel.onNewEmployeeUsernameChanged("new_operator")
        viewModel.onNewEmployeePasswordChanged("SecurePass123!")
        viewModel.onNewEmployeeFullNameChanged("New Operator")
        viewModel.onNewEmployeeEmailChanged("operator@quarry.com")

        // Assign quarry q-1
        viewModel.toggleQuarryAssignment("q-1")
        val perm = viewModel.uiState.value.selectedEmployeeQuarries["q-1"]
        assertNotNull(perm)
        assertTrue(perm!!.canView)
        assertFalse(perm.canUpload)
        assertFalse(perm.canDownload)
        assertFalse(perm.canDelete) // Delete MUST default to False

        // Open review
        viewModel.openReviewDialog()
        assertTrue(viewModel.uiState.value.isReviewEmployeeDialogVisible)

        // Submit
        viewModel.submitCreateEmployee()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isCreateEmployeeDialogVisible)
        assertFalse(viewModel.uiState.value.isReviewEmployeeDialogVisible)
        assertNotNull(viewModel.uiState.value.createEmployeeSuccessMessage)

        val sentRequest = fakeRepository.lastCreateEmployeeRequest
        assertNotNull(sentRequest)
        assertEquals("new_operator", sentRequest!!.username)
        assertEquals(1, sentRequest.quarryPermissions.size)
        assertFalse(sentRequest.quarryPermissions[0].canDelete)
    }

    @Test
    fun delayedResponseFromOldSession_doesNotClearNewlyEstablishedSession() = runTest(testDispatcher) {
        viewModel.onEmailChanged("worker@quarry.com")
        viewModel.onPasswordChanged("valid-password-123")
        viewModel.login()
        advanceUntilIdle()

        assertTrue(viewModel.uiState.value.isAuthenticated)
        fakeRepository.sessionStorage.saveSession("token-new", "refresh-new", "worker@quarry.com", "session-new")

        // Obsolete delayed error returning from an older session
        fakeRepository.quarriesResult = ApiResult.Error(
            statusCode = 401,
            message = "session_terminated_by_new_login",
            code = "SESSION_INVALIDATED",
            sessionId = "session-old"
        )

        viewModel.loadQuarries()
        advanceUntilIdle()

        // Current session must remain intact and authenticated
        assertTrue(viewModel.uiState.value.isAuthenticated)
        assertEquals("session-new", fakeRepository.sessionStorage.getSessionId())
    }

    @Test
    fun renameDocument_success_updatesDocumentListAndShowsSuccessMessage() = runTest(testDispatcher) {
        val quarry = Quarry(
            id = "q-1",
            name = "North Quarry",
            status = "active",
            permissions = QuarryPermission(canView = true, canUpload = false, canDownload = false, canDelete = false)
        )
        fakeRepository.quarriesResult = ApiResult.Success(listOf(quarry))
        fakeRepository.documentsResult = ApiResult.Success(
            listOf(
                Document(
                    id = "d-1",
                    quarryId = "q-1",
                    displayName = "Old Report",
                    originalFilename = "old_report.pdf",
                    mimeType = "application/pdf",
                    sizeBytes = 1024,
                    status = "available",
                    createdAt = "2026-10-25T12:00:00Z"
                )
            )
        )
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        fakeRepository.renameResult = ApiResult.Success(
            Document(
                id = "d-1",
                quarryId = "q-1",
                displayName = "New Report",
                originalFilename = "new_report.pdf",
                mimeType = "application/pdf",
                sizeBytes = 1024,
                status = "available",
                version = 2,
                createdAt = "2026-10-25T12:00:00Z"
            )
        )

        viewModel.renameDocument("q-1", "d-1", "New Report")
        advanceUntilIdle()

        assertEquals("d-1", fakeRepository.lastRenamedDocumentId)
        assertEquals("New Report", fakeRepository.lastRenamedNewName)
        assertFalse(viewModel.uiState.value.isRenamingDocument)
        assertNull(viewModel.uiState.value.renameDocumentError)
        assertNotNull(viewModel.uiState.value.renameSuccessMessage)
        assertEquals("New Report", viewModel.uiState.value.documents.first { it.id == "d-1" }.displayName)
    }

    @Test
    fun renameDocument_emptyName_setsErrorWithoutCallingRepo() = runTest(testDispatcher) {
        fakeRepository.lastRenamedDocumentId = null
        viewModel.renameDocument("q-1", "d-1", "   ")
        advanceUntilIdle()

        assertNull(fakeRepository.lastRenamedDocumentId)
        assertNotNull(viewModel.uiState.value.renameDocumentError)
        assertEquals("Filename cannot be empty.", viewModel.uiState.value.renameDocumentError?.english)
        assertEquals("لا يمكن أن يكون اسم الملف فارغاً.", viewModel.uiState.value.renameDocumentError?.arabic)
    }

    @Test
    fun renameDocument_permissionDenied_setsError() = runTest(testDispatcher) {
        val quarry = Quarry(
            id = "q-no-view",
            name = "Forbidden Quarry",
            status = "active",
            permissions = QuarryPermission(canView = false, canUpload = false, canDownload = false, canDelete = false)
        )
        fakeRepository.quarriesResult = ApiResult.Success(listOf(quarry))
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        viewModel.renameDocument("q-no-view", "d-1", "Hacked Name")
        advanceUntilIdle()

        assertNull(fakeRepository.lastRenamedDocumentId)
        assertNotNull(viewModel.uiState.value.renameDocumentError)
    }

    @Test
    fun renameDocument_conflictDuplicate_setsConflictMessage() = runTest(testDispatcher) {
        val quarry = Quarry(
            id = "q-1",
            name = "North Quarry",
            status = "active",
            permissions = QuarryPermission(canView = true, canUpload = false, canDownload = false, canDelete = false)
        )
        fakeRepository.quarriesResult = ApiResult.Success(listOf(quarry))
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        fakeRepository.renameResult = ApiResult.Error(statusCode = 409, message = "duplicate")
        viewModel.renameDocument("q-1", "d-1", "Existing.pdf")
        advanceUntilIdle()

        assertNotNull(viewModel.uiState.value.renameDocumentError)
        assertEquals("A document with this name already exists in this folder.", viewModel.uiState.value.renameDocumentError?.english)
    }
}
