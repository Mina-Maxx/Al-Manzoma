package com.quarryvault.employee.ui

import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.AppUpdateManifest
import com.quarryvault.employee.data.api.models.ServerConfig
import com.quarryvault.employee.data.updates.UpdateManager
import com.quarryvault.employee.ui.screens.EmployeeAppViewModel
import com.quarryvault.employee.ui.screens.UpdateStatus
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.MessageDigest

@OptIn(ExperimentalCoroutinesApi::class)
class UpdateWorkflowTest {

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
    fun testCheckForUpdates_OptionalAvailable() = runTest(testDispatcher) {
        val manifestV2 = AppUpdateManifest(
            versionCode = 2,
            versionName = "1.1.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            apkUrl = "http://localhost:8000/app/updates/download/dummy",
            apkSizeBytes = 2048,
            sha256 = "abc123sha",
            publishedAt = "2026-10-27T16:00:00Z"
        )
        fakeRepo.updateManifestResult = ApiResult.Success(manifestV2)

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val status = viewModel.uiState.value.updateStatus
        assertTrue(status is UpdateStatus.Available)
        val available = status as UpdateStatus.Available
        assertEquals(2, available.manifest.versionCode)
        assertFalse(available.isRequired)
    }

    @Test
    fun testCheckForUpdates_RequiredAvailable_ByMinVersion() = runTest(testDispatcher) {
        val manifestV3 = AppUpdateManifest(
            versionCode = 3,
            versionName = "1.2.0",
            minimumSupportedVersionCode = 2,
            updateRequired = false,
            apkUrl = "http://localhost:8000/app/updates/download/dummy",
            apkSizeBytes = 4096,
            sha256 = "def456sha",
            publishedAt = "2026-10-27T16:00:00Z"
        )
        fakeRepo.updateManifestResult = ApiResult.Success(manifestV3)

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val status = viewModel.uiState.value.updateStatus
        assertTrue(status is UpdateStatus.Available)
        val available = status as UpdateStatus.Available
        assertEquals(3, available.manifest.versionCode)
        assertTrue("Must be marked required because current version < minSupported", available.isRequired)
    }

    @Test
    fun testCheckForUpdates_HigherVersionCode_OptionalUpdate_IsNotRequired() = runTest(testDispatcher) {
        val manifestV10 = AppUpdateManifest(
            versionCode = 10,
            versionName = "2.0.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            updatePolicy = "optional",
            apkUrl = "http://localhost:8000/app/updates/download/dummy",
            apkSizeBytes = 4096,
            sha256 = "sha10",
            publishedAt = "2026-10-30T00:00:00Z"
        )
        fakeRepo.updateManifestResult = ApiResult.Success(manifestV10)

        viewModel.checkForUpdates(currentVersionCode = 2)
        advanceUntilIdle()

        val status = viewModel.uiState.value.updateStatus
        assertTrue(status is UpdateStatus.Available)
        val available = status as UpdateStatus.Available
        assertEquals(10, available.manifest.versionCode)
        assertFalse("Newer version must NOT become mandatory merely because version code is higher", available.isRequired)
    }

    @Test
    fun testCheckForUpdates_DismissedOptionalUpdate_SuppressesModalOnSubsequentAutoCheck() = runTest(testDispatcher) {
        val manifestV4 = AppUpdateManifest(
            versionCode = 4,
            versionName = "1.4.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            updatePolicy = "optional",
            apkUrl = "http://localhost:8000/app/updates/download/dummy",
            apkSizeBytes = 2048,
            sha256 = "sha4",
            publishedAt = "2026-10-30T00:00:00Z"
        )
        fakeRepo.updateManifestResult = ApiResult.Success(manifestV4)

        // 1. Initial automatic check -> Available
        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.updateStatus is UpdateStatus.Available)

        // 2. User dismisses optional update
        viewModel.dismissOptionalUpdate()
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.updateStatus is UpdateStatus.Idle)

        // 3. Background/Automatic re-check for same version -> Modal stays suppressed (Idle)
        viewModel.checkForUpdates(currentVersionCode = 1, isManualCheck = false)
        advanceUntilIdle()
        assertTrue("Auto-check must not re-interrupt user after dismissal", viewModel.uiState.value.updateStatus is UpdateStatus.Idle)
        assertEquals(4, viewModel.uiState.value.latestManifest?.versionCode)

        // 4. User explicitly clicks check for updates on Updates screen -> Card is displayed
        viewModel.checkForUpdates(currentVersionCode = 1, isManualCheck = true)
        advanceUntilIdle()
        assertTrue("Manual check must surface available update", viewModel.uiState.value.updateStatus is UpdateStatus.Available)
    }

    @Test
    fun testCheckForUpdates_NoUpdateWhenSameVersion() = runTest(testDispatcher) {
        val manifestV1 = AppUpdateManifest(
            versionCode = 1,
            versionName = "1.0.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            apkUrl = "http://localhost:8000/app/updates/download/dummy",
            apkSizeBytes = 1024,
            sha256 = "same",
            publishedAt = "2026-10-27T16:00:00Z"
        )
        fakeRepo.updateManifestResult = ApiResult.Success(manifestV1)

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val status = viewModel.uiState.value.updateStatus
        assertTrue("When already on latest version, status should be Idle", status is UpdateStatus.Idle)
    }

    @Test
    fun testDismissOptionalUpdate_ResetsToIdle() = runTest(testDispatcher) {
        val manifestV2 = AppUpdateManifest(
            versionCode = 2,
            versionName = "1.1.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            apkUrl = "http://localhost:8000/app/updates/download/dummy",
            apkSizeBytes = 2048,
            sha256 = "abc123sha",
            publishedAt = "2026-10-27T16:00:00Z"
        )
        fakeRepo.updateManifestResult = ApiResult.Success(manifestV2)

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        assertTrue(viewModel.uiState.value.updateStatus is UpdateStatus.Available)

        viewModel.dismissOptionalUpdate()
        advanceUntilIdle()

        assertTrue(viewModel.uiState.value.updateStatus is UpdateStatus.Idle)
    }

    @Test
    fun testDismissOptionalUpdate_CannotDismissRequiredUpdate() = runTest(testDispatcher) {
        val manifestRequired = AppUpdateManifest(
            versionCode = 5,
            versionName = "2.0.0",
            minimumSupportedVersionCode = 5,
            updateRequired = true,
            apkUrl = "http://localhost:8000/app/updates/download/dummy",
            apkSizeBytes = 2048,
            sha256 = "req",
            publishedAt = "2026-10-27T16:00:00Z"
        )
        fakeRepo.updateManifestResult = ApiResult.Success(manifestRequired)

        viewModel.checkForUpdates(currentVersionCode = 1)
        advanceUntilIdle()

        val statusBefore = viewModel.uiState.value.updateStatus
        assertTrue(statusBefore is UpdateStatus.Available)
        assertTrue((statusBefore as UpdateStatus.Available).isRequired)

        // Attempt to dismiss
        viewModel.dismissOptionalUpdate()
        advanceUntilIdle()

        val statusAfter = viewModel.uiState.value.updateStatus
        assertTrue("Required update must NOT be dismissed", statusAfter is UpdateStatus.Available)
        assertTrue((statusAfter as UpdateStatus.Available).isRequired)
    }

    @Test
    fun testFetchServerConfig_UpdatesState() = runTest(testDispatcher) {
        val config = ServerConfig(
            configVersion = "2026.10.1",
            serverTime = "2026-10-27T16:00:00Z",
            minimumSupportedVersionCode = 1,
            latestVersionCode = 2,
            features = mapOf("offline_sync" to true, "document_deletion" to true),
            limits = mapOf("max_file_size_bytes" to 10485760L)
        )
        fakeRepo.serverConfigResult = ApiResult.Success(config)

        viewModel.fetchServerConfig()
        advanceUntilIdle()

        val serverConfig = viewModel.uiState.value.serverConfig
        assertNotNull(serverConfig)
        assertEquals("2026.10.1", serverConfig?.configVersion)
        assertEquals(true, serverConfig?.features?.get("offline_sync"))
    }

    @Test
    fun testDownloadUpdate_ChecksumVerificationSuccess() = runTest(testDispatcher) {
        val payload = "QuarryVault Signed APK 2026".toByteArray(Charsets.UTF_8)
        val expectedSha = MessageDigest.getInstance("SHA-256")
            .digest(payload)
            .joinToString("") { "%02x".format(it) }

        val targetDir = tempFolder.newFolder("updates")
        val manifest = AppUpdateManifest(
            versionCode = 10,
            versionName = "2.5.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            apkUrl = "http://localhost:8000/app/updates/download/uuid-10",
            apkSizeBytes = payload.size.toLong(),
            sha256 = expectedSha,
            publishedAt = "2026-10-27T16:00:00Z"
        )

        // Simulate repository writing valid file
        fakeRepo.downloadApkResult = ApiResult.Success(java.io.File(targetDir, "quarryvault-v10.apk").apply {
            writeBytes(payload)
        })

        viewModel.downloadUpdate(manifest, targetDir, isRequired = false)
        advanceUntilIdle()

        val status = viewModel.uiState.value.updateStatus
        assertTrue("Successful checksum check transitions to ReadyToInstall", status is UpdateStatus.ReadyToInstall)
        val ready = status as UpdateStatus.ReadyToInstall
        assertEquals(10, ready.manifest.versionCode)
        assertTrue(ready.apkFile.exists())
    }

    @Test
    fun testDownloadUpdate_ChecksumMismatchFails() = runTest(testDispatcher) {
        val corruptedPayload = "Corrupted APK Payload".toByteArray(Charsets.UTF_8)
        val targetDir = tempFolder.newFolder("corrupted_updates")
        val manifest = AppUpdateManifest(
            versionCode = 12,
            versionName = "2.6.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            apkUrl = "http://localhost:8000/app/updates/download/uuid-12",
            apkSizeBytes = 1000,
            sha256 = "expected_hash_that_does_not_match",
            publishedAt = "2026-10-27T16:00:00Z"
        )

        fakeRepo.downloadApkResult = ApiResult.Success(java.io.File(targetDir, "quarryvault-v12.apk").apply {
            writeBytes(corruptedPayload)
        })

        viewModel.downloadUpdate(manifest, targetDir, isRequired = false)
        advanceUntilIdle()

        val status = viewModel.uiState.value.updateStatus
        assertTrue("Mismatched checksum must transition to Error", status is UpdateStatus.Error)
        val error = status as UpdateStatus.Error
        assertTrue(error.message.english.contains("SHA-256"))
    }
}
