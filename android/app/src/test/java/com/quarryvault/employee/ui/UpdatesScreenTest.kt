package com.quarryvault.employee.ui

import com.quarryvault.employee.BuildConfig
import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.AppUpdateManifest
import com.quarryvault.employee.data.updates.UpdateManager
import com.quarryvault.employee.ui.screens.AppScreen
import com.quarryvault.employee.ui.screens.EmployeeAppViewModel
import com.quarryvault.employee.ui.screens.UpdateStatus
import com.quarryvault.employee.ui.util.UiFormatters
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
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest

@OptIn(ExperimentalCoroutinesApi::class)
class UpdatesScreenTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var fakeRepo: FakeEmployeeRepository
    private lateinit var viewModel: EmployeeAppViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        fakeRepo = FakeEmployeeRepository()
        viewModel = EmployeeAppViewModel(
            repository = fakeRepo,
            updateManager = UpdateManager(),
            ioDispatcher = testDispatcher,
            defaultDispatcher = testDispatcher
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun testInitialInstalledVersionState() {
        val state = viewModel.uiState.value
        assertEquals(BuildConfig.VERSION_CODE, state.installedVersionCode)
        assertEquals(BuildConfig.VERSION_NAME, state.installedVersionName)
        assertFalse(state.isUpToDate)
        assertFalse(state.isNoReleaseAvailable)
        assertNull(state.lastUpdateCheckTime)
    }

    @Test
    fun testNavigateToAndFromUpdatesScreen() {
        assertEquals(AppScreen.LOGIN, viewModel.uiState.value.currentScreen)

        viewModel.navigateToUpdates()
        assertEquals(AppScreen.UPDATES, viewModel.uiState.value.currentScreen)

        viewModel.navigateBackFromUpdates()
        assertEquals(AppScreen.HOME, viewModel.uiState.value.currentScreen)
    }

    @Test
    fun testCheckForUpdates_AlreadyUpToDate() = runTest(testDispatcher) {
        val manifestV1 = AppUpdateManifest(
            versionCode = 1,
            versionName = "1.0.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            apkUrl = "http://localhost:8000/app/updates/download/dummy",
            apkSizeBytes = 5242880,
            sha256 = "abc-up-to-date",
            publishedAt = "2026-10-27T12:00:00Z"
        )
        fakeRepo.updateManifestResult = ApiResult.Success(manifestV1)

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue("Status must be Idle when up to date", state.updateStatus is UpdateStatus.Idle)
        assertTrue("isUpToDate flag must be true", state.isUpToDate)
        assertFalse("isNoReleaseAvailable flag must be false", state.isNoReleaseAvailable)
        assertNotNull("lastUpdateCheckTime must be set", state.lastUpdateCheckTime)
        assertNotNull("latestManifest must be recorded", state.latestManifest)
        assertEquals("1.0.0", state.latestManifest?.versionName)
    }

    @Test
    fun testCheckForUpdates_NoReleaseAvailable_404() = runTest(testDispatcher) {
        fakeRepo.updateManifestResult = ApiResult.Error(
            statusCode = 404,
            message = "No app releases available",
            code = "404"
        )

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue("Status must be Idle on 404", state.updateStatus is UpdateStatus.Idle)
        assertTrue("isNoReleaseAvailable must be true", state.isNoReleaseAvailable)
        assertFalse("isUpToDate must be false", state.isUpToDate)
        assertNotNull("lastUpdateCheckTime must be set", state.lastUpdateCheckTime)
        assertNull("updateErrorMessage should be null for graceful 404", state.updateErrorMessage)
    }

    @Test
    fun testCheckForUpdates_ServerError_ShowsErrorState() = runTest(testDispatcher) {
        fakeRepo.updateManifestResult = ApiResult.Error(
            statusCode = 500,
            message = "Internal Database Error",
            code = "500"
        )

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue("Status must be Error on 500", state.updateStatus is UpdateStatus.Error)
        assertNotNull(state.updateErrorMessage)
        assertFalse(state.isUpToDate)
        assertFalse(state.isNoReleaseAvailable)
    }

    @Test
    fun testCheckForUpdates_NetworkError_ShowsErrorState() = runTest(testDispatcher) {
        fakeRepo.updateManifestResult = ApiResult.NetworkError(
            java.io.IOException("Connection refused")
        )

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue("Status must be Error on network exception", state.updateStatus is UpdateStatus.Error)
        assertNotNull(state.updateErrorMessage)
        assertTrue(state.updateErrorMessage!!.english.contains("Network connection failed"))
    }

    @Test
    fun testDownloadUpdateProgressAndCompletion() = runTest(testDispatcher) {
        val payload = "Test APK content byte stream".toByteArray(Charsets.UTF_8)
        val expectedSha = MessageDigest.getInstance("SHA-256")
            .digest(payload)
            .joinToString("") { "%02x".format(it) }

        val targetDir = tempFolder.newFolder("apk_download_test")
        val manifest = AppUpdateManifest(
            versionCode = 4,
            versionName = "1.3.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            apkUrl = "http://localhost:8000/app/updates/download/v4",
            apkSizeBytes = payload.size.toLong(),
            sha256 = expectedSha,
            publishedAt = "2026-10-27T18:00:00Z",
            releaseNotes = "Added new Quarry filter and speed improvements."
        )

        val targetApk = File(targetDir, "quarryvault-v4.apk").apply {
            writeBytes(payload)
        }
        fakeRepo.downloadApkResult = ApiResult.Success(targetApk)

        viewModel.downloadUpdate(manifest, targetDir, isRequired = false)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue("Status must transition to ReadyToInstall on success", state.updateStatus is UpdateStatus.ReadyToInstall)
        val ready = state.updateStatus as UpdateStatus.ReadyToInstall
        assertEquals(4, ready.manifest.versionCode)
        assertEquals("1.3.0", ready.manifest.versionName)
        assertEquals(targetApk.absolutePath, ready.apkFile.absolutePath)
        assertTrue(ready.apkFile.exists())
    }

    @Test
    fun testFormattersForUpdatesScreen() {
        val formattedSizeEn = UiFormatters.formatBytes(15728640L, isArabic = false)
        assertEquals("15.0 MB", formattedSizeEn)

        val formattedDate = UiFormatters.formatDate("2026-10-27T15:30:00.000Z")
        assertTrue(formattedDate.contains("2026-10-27"))
    }

    @Test
    fun testInterruptedDownload_FailsAndDoesNotTransitionToReady() = runTest(testDispatcher) {
        val targetDir = tempFolder.newFolder("interrupted_download")
        val manifest = AppUpdateManifest(
            versionCode = 5,
            versionName = "1.4.0",
            apkUrl = "http://localhost:8000/app/updates/download/v5",
            apkSizeBytes = 10000,
            sha256 = "dummy_sha",
            publishedAt = "2026-10-27T19:00:00Z"
        )

        // Simulate interrupted download network error
        fakeRepo.downloadApkResult = ApiResult.NetworkError(java.io.IOException("Connection reset by peer"))

        viewModel.downloadUpdate(manifest, targetDir, isRequired = false)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue("Interrupted download must transition to Error", state.updateStatus is UpdateStatus.Error)
        assertFalse("Must not be in ReadyToInstall state", state.updateStatus is UpdateStatus.ReadyToInstall)
        assertNotNull(state.updateErrorMessage)
    }

    @Test
    fun testMalformedManifest_TransitionsToError_NotUpToDate() = runTest(testDispatcher) {
        // Simulate malformed JSON response from server
        fakeRepo.updateManifestResult = ApiResult.Error(
            statusCode = 200,
            message = "Failed to parse response: Unexpected JSON token at offset 12",
            code = "DESERIALIZATION_ERROR"
        )

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue("Malformed manifest must result in Error state", state.updateStatus is UpdateStatus.Error)
        assertFalse("Must NOT claim the app is up to date when response is malformed", state.isUpToDate)
        assertFalse(state.isNoReleaseAvailable)
        assertNotNull(state.updateErrorMessage)
    }

    @Test
    fun testSensitiveErrorSanitization_DoesNotLeakSecrets() = runTest(testDispatcher) {
        fakeRepo.updateManifestResult = ApiResult.Error(
            statusCode = 500,
            message = "psycopg.OperationalError: select * from users where password='secret_token' exception",
            code = "500"
        )

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue(state.updateStatus is UpdateStatus.Error)
        val errorMsg = state.updateErrorMessage
        assertNotNull(errorMsg)
        assertFalse("Error message must sanitize SQL/passwords", errorMsg!!.english.contains("password"))
        assertFalse("Error message must sanitize SQL/passwords", errorMsg.english.contains("select *"))
        assertEquals("An unexpected error occurred. Please try again.", errorMsg.english)
    }
}
