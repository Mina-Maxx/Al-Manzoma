package com.quarryvault.employee.ui

import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.CompanyOut
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.HealthResponse
import com.quarryvault.employee.data.api.models.MeResponse
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.QuarryPermission
import com.quarryvault.employee.data.api.models.SupabaseTokenResponse
import com.quarryvault.employee.data.api.models.SupabaseUser
import com.quarryvault.employee.data.api.models.TrashDocument
import com.quarryvault.employee.data.api.models.UserOut
import com.quarryvault.employee.data.repository.EmployeeRepository
import com.quarryvault.employee.data.session.InMemorySessionStorage
import com.quarryvault.employee.data.session.SessionStorage
import com.quarryvault.employee.ui.screens.AppScreen
import com.quarryvault.employee.ui.screens.EmployeeAppViewModel
import com.quarryvault.employee.ui.screens.RequestState
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

class FakeEmployeeRepository(
    override val sessionStorage: SessionStorage = InMemorySessionStorage()
) : EmployeeRepository {
    override var backendBaseUrl: String = "http://10.0.2.2:8000"
    override var supabaseUrl: String = "https://tqwyzrbinkwxbiafbqbj.supabase.co"
    override var supabaseAnonKey: String = "dummy-anon-key"

    var healthResult: ApiResult<HealthResponse> = ApiResult.Success(HealthResponse("ok"))
    var loginResult: ApiResult<SupabaseTokenResponse> = ApiResult.Success(
        SupabaseTokenResponse(
            accessToken = "test-access-token-123",
            refreshToken = "test-refresh-token-456",
            user = SupabaseUser(id = "user-uuid-1", email = "worker@quarry.com")
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
                permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true)
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

    var downloadResult: ApiResult<ByteArray> = ApiResult.Success("file content".toByteArray())

    var createQuarryResult: ApiResult<Quarry> = ApiResult.Success(
        Quarry(
            id = "q-new",
            name = "New Test Quarry",
            status = "active",
            permissions = QuarryPermission(canView = true, canUpload = false, canDownload = false)
        )
    )

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

    override suspend fun login(email: String, password: String): ApiResult<SupabaseTokenResponse> {
        val result = loginResult
        if (result is ApiResult.Success) {
            sessionStorage.saveSession(
                result.data.accessToken,
                result.data.refreshToken,
                result.data.user?.email ?: email
            )
        }
        return result
    }

    override suspend fun getProfile(token: String?): ApiResult<MeResponse> {
        return profileResult
    }

    override suspend fun getQuarries(token: String?): ApiResult<List<Quarry>> {
        return quarriesResult
    }

    override suspend fun getFolders(quarryId: String, token: String?): ApiResult<List<Folder>> {
        return foldersResult
    }

    override suspend fun getDocuments(
        quarryId: String,
        folderId: String?,
        rootOnly: Boolean,
        token: String?
    ): ApiResult<List<Document>> {
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

    override suspend fun createQuarry(name: String, token: String?): ApiResult<Quarry> {
        return createQuarryResult
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
    ): ApiResult<List<TrashDocument>> = trashResult

    override suspend fun restoreDocument(
        quarryId: String,
        documentId: String,
        version: Int?,
        token: String?
    ): ApiResult<Document> = restoreResult

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
        assertEquals("https://tqwyzrbinkwxbiafbqbj.supabase.co", state.supabaseUrl)
        assertFalse(state.isAuthenticated)
        assertFalse(state.isAuthenticating)
        assertNull(state.profile)
        assertNull(state.loginError)
        assertEquals(AppScreen.LOGIN, state.currentScreen)
        assertTrue(state.healthState is RequestState.Idle)
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
            permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true)
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
            permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true)
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
            permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true)
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
    fun toggleLanguage_switchesArabic() {
        assertFalse(viewModel.uiState.value.isArabic)
        viewModel.toggleLanguage()
        assertTrue(viewModel.uiState.value.isArabic)
        viewModel.toggleLanguage()
        assertFalse(viewModel.uiState.value.isArabic)
    }

    @Test
    fun login_supabaseCredentialsError() = runTest(testDispatcher) {
        fakeRepository.loginResult = ApiResult.Error(
            statusCode = 400,
            message = "Invalid login credentials",
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
        assertTrue(state.loginError!!.english.contains("Incorrect email or password"))
        assertTrue(state.loginError!!.arabic.contains("البريد الإلكتروني أو كلمة المرور غير صحيحة"))
    }

    @Test
    fun login_backendUnprovisionedUser403() = runTest(testDispatcher) {
        fakeRepository.loginResult = ApiResult.Success(
            SupabaseTokenResponse(
                accessToken = "valid-supabase-jwt-unprovisioned",
                user = SupabaseUser(id = "unprov-uuid", email = "unprov@quarry.com")
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
        assertEquals("", viewModel.uiState.value.manualToken)
        assertEquals(AppScreen.LOGIN, viewModel.uiState.value.currentScreen)
        assertFalse(fakeRepository.sessionStorage.hasActiveSession())
    }

    @Test
    fun checkHealth_success() = runTest(testDispatcher) {
        viewModel.checkHealth()
        advanceUntilIdle()

        val state = viewModel.uiState.value.healthState
        assertTrue(state is RequestState.Success)
        assertEquals("ok", (state as RequestState.Success).data.status)
    }

    @Test
    fun toggleDiagnostics_expandsAndCollapses() {
        assertFalse(viewModel.uiState.value.isDiagnosticsExpanded)
        viewModel.toggleDiagnostics()
        assertTrue(viewModel.uiState.value.isDiagnosticsExpanded)
        viewModel.toggleDiagnostics()
        assertFalse(viewModel.uiState.value.isDiagnosticsExpanded)
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
        viewModel.createQuarry()
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isCreatingQuarry)
        val err = viewModel.uiState.value.createQuarryError
        assertNotNull(err)
        assertTrue(err!!.arabic.contains("الصلاحية") || err.arabic.contains("نشط"))
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
        val quarry = Quarry("q-1", "North Pit", "active")
        viewModel.selectQuarry(quarry)
        advanceUntilIdle()

        viewModel.deleteDocument("q-1", "d-1", 1)
        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isDeletingDocument)
        assertNotNull(viewModel.uiState.value.deleteSuccessMessage)
        assertNull(viewModel.uiState.value.deleteDocumentError)
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
}
