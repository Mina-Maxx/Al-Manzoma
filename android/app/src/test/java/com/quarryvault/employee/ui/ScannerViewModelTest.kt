package com.quarryvault.employee.ui

import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.QuarryPermission
import com.quarryvault.employee.data.scanner.ScanFilterMode
import com.quarryvault.employee.data.scanner.ScannedPage
import com.quarryvault.employee.ui.screens.AppScreen
import com.quarryvault.employee.ui.screens.EmployeeAppViewModel
import com.quarryvault.employee.ui.screens.ScannerStep
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
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class ScannerViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var fakeRepository: FakeEmployeeRepository
    private lateinit var viewModel: EmployeeAppViewModel
    private lateinit var tempTestDir: File

    private val sampleQuarry = Quarry(
        id = "q-alpha",
        name = "Alpha Quarry",
        status = "active",
        permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true)
    )

    private val readOnlyQuarry = Quarry(
        id = "q-beta",
        name = "Beta Quarry (Read Only)",
        status = "active",
        permissions = QuarryPermission(canView = true, canUpload = false, canDownload = true)
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        fakeRepository = FakeEmployeeRepository()
        viewModel = EmployeeAppViewModel(fakeRepository, testDispatcher, testDispatcher)
        tempTestDir = File(System.getProperty("java.io.tmpdir"), "scanner_test_${System.currentTimeMillis()}").apply {
            mkdirs()
        }
        viewModel.customCacheDir = tempTestDir
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        tempTestDir.deleteRecursively()
    }

    @Test
    fun testStartScanning_initializesDefaultScannerState() {
        viewModel.startScanning(quarry = sampleQuarry, folderId = "folder-123")

        val state = viewModel.uiState.value
        assertEquals(AppScreen.DOCUMENT_SCANNER, state.currentScreen)
        assertEquals(ScannerStep.CAMERA, state.scannerStep)
        assertEquals(sampleQuarry, state.targetUploadQuarry)
        assertEquals("folder-123", state.selectedScanFolderId)
        assertTrue(state.scannedPages.isEmpty())
        assertNull(state.activeCapturedFile)
        assertNull(state.generatedPdfFile)
        assertFalse(state.isUploadingScan)
        assertTrue(state.scanDocumentName.startsWith("Scan_"))
    }

    @Test
    fun testReorderScannedPages_updatesOrderAccurately() {
        viewModel.startScanning(quarry = sampleQuarry)

        val page1 = ScannedPage(
            id = "p-1",
            imageFile = File(tempTestDir, "p1.jpg"),
            rotationDegrees = 0,
            filterMode = ScanFilterMode.COLOR,
            width = 800,
            height = 1200
        )
        val page2 = ScannedPage(
            id = "p-2",
            imageFile = File(tempTestDir, "p2.jpg"),
            rotationDegrees = 0,
            filterMode = ScanFilterMode.GRAYSCALE,
            width = 800,
            height = 1200
        )
        val page3 = ScannedPage(
            id = "p-3",
            imageFile = File(tempTestDir, "p3.jpg"),
            rotationDegrees = 0,
            filterMode = ScanFilterMode.DOCUMENT_ENHANCED,
            width = 800,
            height = 1200
        )

        // Inject pages into state
        viewModel.reorderScannedPages(0, 0) // No effect
        // Set state with pages manually by testing reorder on populated pages
        // We simulate state update via internal reflection or direct reorder when list has elements
        // Let's populate via reflection or state flow:
        val field = EmployeeAppViewModel::class.java.getDeclaredField("_uiState")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(viewModel) as kotlinx.coroutines.flow.MutableStateFlow<com.quarryvault.employee.ui.screens.EmployeeAppUiState>
        flow.value = flow.value.copy(
            scannedPages = listOf(page1, page2, page3),
            scannerStep = ScannerStep.REVIEW
        )

        // Move page 0 (p-1) to index 2: [p-2, p-3, p-1]
        viewModel.reorderScannedPages(0, 2)
        assertEquals(listOf("p-2", "p-3", "p-1"), viewModel.uiState.value.scannedPages.map { it.id })

        // Move page 1 (p-3) to index 0: [p-3, p-2, p-1]
        viewModel.reorderScannedPages(1, 0)
        assertEquals(listOf("p-3", "p-2", "p-1"), viewModel.uiState.value.scannedPages.map { it.id })

        // Out of bounds reorders are safely ignored
        viewModel.reorderScannedPages(-1, 2)
        viewModel.reorderScannedPages(0, 99)
        assertEquals(listOf("p-3", "p-2", "p-1"), viewModel.uiState.value.scannedPages.map { it.id })
    }

    @Test
    fun testDeleteScannedPage_removesPageAndAdjustsStep() {
        val file1 = File(tempTestDir, "p1.jpg").apply { writeText("dummy1") }
        val file2 = File(tempTestDir, "p2.jpg").apply { writeText("dummy2") }

        val page1 = ScannedPage("p-1", file1, 0, ScanFilterMode.COLOR, 100, 100)
        val page2 = ScannedPage("p-2", file2, 0, ScanFilterMode.COLOR, 100, 100)

        val field = EmployeeAppViewModel::class.java.getDeclaredField("_uiState")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(viewModel) as kotlinx.coroutines.flow.MutableStateFlow<com.quarryvault.employee.ui.screens.EmployeeAppUiState>
        flow.value = flow.value.copy(
            scannedPages = listOf(page1, page2),
            scannerStep = ScannerStep.REVIEW
        )

        // Delete page 1
        viewModel.deleteScannedPage("p-1")
        assertEquals(1, viewModel.uiState.value.scannedPages.size)
        assertEquals("p-2", viewModel.uiState.value.scannedPages.first().id)
        assertFalse("File 1 should be deleted from disk", file1.exists())
        assertEquals(ScannerStep.REVIEW, viewModel.uiState.value.scannerStep)

        // Delete last page -> returns to CAMERA step
        viewModel.deleteScannedPage("p-2")
        assertTrue(viewModel.uiState.value.scannedPages.isEmpty())
        assertFalse("File 2 should be deleted from disk", file2.exists())
        assertEquals(ScannerStep.CAMERA, viewModel.uiState.value.scannerStep)
        assertNull(viewModel.uiState.value.generatedPdfFile)
    }

    @Test
    fun testTargetQuarryAndNameModification() {
        viewModel.startScanning(quarry = sampleQuarry)

        viewModel.onScanDocumentNameChanged("Invoice_October_2026")
        assertEquals("Invoice_October_2026", viewModel.uiState.value.scanDocumentName)

        viewModel.onTargetQuarryChanged(readOnlyQuarry)
        assertEquals(readOnlyQuarry, viewModel.uiState.value.targetUploadQuarry)

        viewModel.onScanFolderSelected("folder-contracts")
        assertEquals("folder-contracts", viewModel.uiState.value.selectedScanFolderId)
    }

    @Test
    fun testUploadScannedDocument_failureRetainsPagesForRetry() = runTest {
        val dummyPdf = File(tempTestDir, "test_doc.pdf").apply { writeBytes(byteArrayOf(1, 2, 3, 4, 5)) }
        val page1 = ScannedPage("p-1", File(tempTestDir, "p1.jpg"), 0, ScanFilterMode.COLOR, 100, 100)

        val field = EmployeeAppViewModel::class.java.getDeclaredField("_uiState")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(viewModel) as kotlinx.coroutines.flow.MutableStateFlow<com.quarryvault.employee.ui.screens.EmployeeAppUiState>
        flow.value = flow.value.copy(
            targetUploadQuarry = sampleQuarry,
            scannedPages = listOf(page1),
            generatedPdfFile = dummyPdf,
            scanDocumentName = "Inspection_Report"
        )

        // Configure repository failure (e.g., storage quota exceeded)
        fakeRepository.uploadResult = ApiResult.Error(
            statusCode = 413,
            message = "Company storage quota exceeded (5 GiB limit)",
            code = "QUOTA_EXCEEDED"
        )

        viewModel.uploadScannedDocument()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isUploadingScan)
        assertNotNull(state.scanUploadError)
        // CRITICAL REQUIREMENT: Pages must NOT be discarded on upload failure so user can retry!
        assertEquals(1, state.scannedPages.size)
        assertEquals("p-1", state.scannedPages.first().id)
        assertTrue(dummyPdf.exists())
    }

    @Test
    fun testUploadScannedDocument_networkErrorRetainsPagesForRetry() = runTest {
        val dummyPdf = File(tempTestDir, "test_doc.pdf").apply { writeBytes(byteArrayOf(1, 2, 3, 4, 5)) }
        val page1 = ScannedPage("p-1", File(tempTestDir, "p1.jpg"), 0, ScanFilterMode.COLOR, 100, 100)

        val field = EmployeeAppViewModel::class.java.getDeclaredField("_uiState")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(viewModel) as kotlinx.coroutines.flow.MutableStateFlow<com.quarryvault.employee.ui.screens.EmployeeAppUiState>
        flow.value = flow.value.copy(
            targetUploadQuarry = sampleQuarry,
            scannedPages = listOf(page1),
            generatedPdfFile = dummyPdf,
            scanDocumentName = "Field_Report"
        )

        // Configure network connection failure
        fakeRepository.uploadResult = ApiResult.NetworkError(
            throwable = java.io.IOException("Socket timeout to backend")
        )

        viewModel.uploadScannedDocument()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isUploadingScan)
        assertNotNull(state.scanUploadError)
        assertTrue(state.scanUploadError?.english?.contains("Socket timeout") == true)
        // Pages must still be intact
        assertEquals(1, state.scannedPages.size)
        assertTrue(dummyPdf.exists())
    }

    @Test
    fun testUploadScannedDocument_retryPreservesSameIdempotencyKey() = runTest {
        val dummyPdf = File(tempTestDir, "test_doc.pdf").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val page1 = ScannedPage("p-1", File(tempTestDir, "p1.jpg"), 0, ScanFilterMode.COLOR, 100, 100)

        val field = EmployeeAppViewModel::class.java.getDeclaredField("_uiState")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(viewModel) as kotlinx.coroutines.flow.MutableStateFlow<com.quarryvault.employee.ui.screens.EmployeeAppUiState>
        flow.value = flow.value.copy(
            targetUploadQuarry = sampleQuarry,
            scannedPages = listOf(page1),
            generatedPdfFile = dummyPdf,
            scanDocumentName = "Field_Report_V1"
        )

        val initialKey = viewModel.uiState.value.scanIdempotencyKey
        assertNotNull(initialKey)

        // First attempt fails
        fakeRepository.uploadResult = ApiResult.NetworkError(java.io.IOException("504 Gateway Timeout"))
        viewModel.uploadScannedDocument()
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(initialKey, fakeRepository.lastUploadedIdempotencyKey)
        assertEquals(initialKey, viewModel.uiState.value.scanIdempotencyKey)

        // Retry succeeds
        fakeRepository.uploadResult = ApiResult.Success(
            Document(
                id = "doc-scan-idem",
                quarryId = sampleQuarry.id,
                folderId = null,
                displayName = "Field_Report_V1",
                originalFilename = "Field_Report_V1.pdf",
                mimeType = "application/pdf",
                sizeBytes = 3,
                status = "available",
                createdAt = "2026-10-27T10:00:00Z"
            )
        )
        viewModel.uploadScannedDocument()
        testDispatcher.scheduler.advanceUntilIdle()

        // Same idempotency key used across retry
        assertEquals(initialKey, fakeRepository.lastUploadedIdempotencyKey)
        assertEquals(AppScreen.QUARRY_DETAIL, viewModel.uiState.value.currentScreen)
    }

    @Test
    fun testUploadScannedDocument_successCleansUpAndNavigatesToQuarry() = runTest {
        val dummyPdf = File(tempTestDir, "test_doc.pdf").apply { writeBytes(byteArrayOf(1, 2, 3, 4, 5)) }
        val dummyImg = File(tempTestDir, "p1.jpg").apply { writeBytes(byteArrayOf(10, 20, 30)) }
        val page1 = ScannedPage("p-1", dummyImg, 0, ScanFilterMode.COLOR, 100, 100)

        val field = EmployeeAppViewModel::class.java.getDeclaredField("_uiState")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(viewModel) as kotlinx.coroutines.flow.MutableStateFlow<com.quarryvault.employee.ui.screens.EmployeeAppUiState>
        flow.value = flow.value.copy(
            targetUploadQuarry = sampleQuarry,
            scannedPages = listOf(page1),
            generatedPdfFile = dummyPdf,
            scanDocumentName = "Final_Signed_Contract"
        )

        fakeRepository.uploadResult = ApiResult.Success(
            Document(
                id = "doc-scan-99",
                quarryId = sampleQuarry.id,
                folderId = null,
                displayName = "Final_Signed_Contract",
                originalFilename = "Final_Signed_Contract.pdf",
                mimeType = "application/pdf",
                sizeBytes = 5,
                status = "available",
                createdAt = "2026-10-27T10:00:00Z"
            )
        )

        viewModel.uploadScannedDocument()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isUploadingScan)
        assertNull(state.scanUploadError)
        assertEquals(AppScreen.QUARRY_DETAIL, state.currentScreen)
        assertEquals(sampleQuarry, state.selectedQuarry)
        assertTrue("Scanned pages list should be reset after successful upload", state.scannedPages.isEmpty())
        assertNull("Generated PDF reference should be cleared", state.generatedPdfFile)
        assertNotNull(state.uploadSuccessMessage)

        // Temporary files must be cleaned up from disk
        assertFalse("Uploaded PDF file should be deleted after upload", dummyPdf.exists())
        assertFalse("Page image files should be deleted after upload", dummyImg.exists())
    }

    @Test
    fun testCancelScanning_cleansUpFilesAndRestoresPreviousScreen() = runTest {
        val dummyPdf = File(tempTestDir, "cancel_doc.pdf").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val dummyImg = File(tempTestDir, "cancel_page.jpg").apply { writeBytes(byteArrayOf(4, 5, 6)) }
        val page1 = ScannedPage("p-cancel", dummyImg, 0, ScanFilterMode.COLOR, 100, 100)

        val field = EmployeeAppViewModel::class.java.getDeclaredField("_uiState")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(viewModel) as kotlinx.coroutines.flow.MutableStateFlow<com.quarryvault.employee.ui.screens.EmployeeAppUiState>
        flow.value = flow.value.copy(
            currentScreen = AppScreen.DOCUMENT_SCANNER,
            selectedQuarry = sampleQuarry,
            scannedPages = listOf(page1),
            generatedPdfFile = dummyPdf
        )

        viewModel.cancelScanning()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals(AppScreen.QUARRY_DETAIL, state.currentScreen)
        assertTrue(state.scannedPages.isEmpty())
        assertNull(state.generatedPdfFile)

        assertFalse("Cancelled PDF file should be deleted", dummyPdf.exists())
        assertFalse("Cancelled page image should be deleted", dummyImg.exists())
    }
}
