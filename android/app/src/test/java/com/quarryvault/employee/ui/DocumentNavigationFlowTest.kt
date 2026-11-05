package com.quarryvault.employee.ui

import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.QuarryPermission
import com.quarryvault.employee.ui.screens.AppScreen
import com.quarryvault.employee.ui.screens.EmployeeAppViewModel
import com.quarryvault.employee.ui.util.DocumentActionsHelper
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
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DocumentNavigationFlowTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var fakeRepository: FakeEmployeeRepository
    private lateinit var viewModel: EmployeeAppViewModel

    private val testQuarry = Quarry(
        id = "q-test-1",
        name = "Granite Pit North",
        status = "active",
        permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true, canDelete = true)
    )

    private val testDoc = Document(
        id = "doc-test-1",
        quarryId = "q-test-1",
        folderId = null,
        displayName = "Safety Protocol.pdf",
        originalFilename = "safety_protocol.pdf",
        mimeType = "application/pdf",
        sizeBytes = 2048,
        status = "available",
        createdAt = "2026-10-25T12:00:00Z"
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        fakeRepository = FakeEmployeeRepository()
        fakeRepository.downloadResult = ApiResult.Success("PDF-CONTENT-BYTES".toByteArray())
        viewModel = EmployeeAppViewModel(fakeRepository)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // ------------------------------------------------------------------------
    // Regression Test 1: Entering a quarry with previously downloaded/opened document
    // state does NOT automatically set or retain pendingOpenDocumentData.
    // ------------------------------------------------------------------------
    @Test
    fun enteringQuarry_clearsAnyStaleDownloadedOrPendingOpenState() = runTest(testDispatcher) {
        // Simulate a previously opened document
        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()
        viewModel.viewDocument(testDoc)
        advanceUntilIdle()

        assertNotNull("Pending open should be set after explicit view", viewModel.uiState.value.pendingOpenDocumentData)

        // User enters a quarry (or switches to a quarry)
        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals(AppScreen.QUARRY_DETAIL, state.currentScreen)
        assertEquals("q-test-1", state.selectedQuarry?.id)
        assertNull(
            "Entering a quarry MUST clear pendingOpenDocumentData to prevent automatic opening",
            state.pendingOpenDocumentData
        )
        assertNull(
            "Entering a quarry MUST clear downloadedDocumentData",
            state.downloadedDocumentData
        )
    }

    // ------------------------------------------------------------------------
    // Regression Test 2: Downloading a document downloads/saves without setting
    // pendingOpenDocumentData, so returning to the quarry does NOT trigger auto-open.
    // ------------------------------------------------------------------------
    @Test
    fun downloadingDocument_doesNotSetPendingOpen_andReturningDoesNotAutoOpen() = runTest(testDispatcher) {
        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()

        // Employee clicks Download
        viewModel.downloadDocument(testDoc)
        advanceUntilIdle()

        val stateAfterDownload = viewModel.uiState.value
        assertFalse(stateAfterDownload.isDownloading)
        assertNotNull("Downloaded data is held until consumed or cleared", stateAfterDownload.downloadedDocumentData)
        assertNotNull(stateAfterDownload.downloadSuccessMessage)
        assertNull(
            "Downloading a document MUST NOT set pendingOpenDocumentData (must not auto-open)",
            stateAfterDownload.pendingOpenDocumentData
        )

        viewModel.clearDownloadedDocumentData()
        assertFalse(viewModel.uiState.value.isDownloading)
        assertNull(viewModel.uiState.value.downloadedDocumentData)

        // Employee navigates back to Home and returns to the Quarry
        viewModel.navigateBackToHome()
        advanceUntilIdle()
        assertEquals(AppScreen.HOME, viewModel.uiState.value.currentScreen)

        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()

        val stateAfterReturn = viewModel.uiState.value
        assertNull(
            "Returning to quarry after download must NOT have pendingOpenDocumentData",
            stateAfterReturn.pendingOpenDocumentData
        )
        assertNull(
            "Returning to quarry after download must have null downloadedDocumentData",
            stateAfterReturn.downloadedDocumentData
        )
    }

    @Test
    fun shareAndDownload_requireCanDownloadAndAvailableSameQuarryDocument() = runTest(testDispatcher) {
        val restrictedQuarry = testQuarry.copy(
            permissions = QuarryPermission(canView = true, canUpload = false, canDownload = false, canDelete = false)
        )
        viewModel.selectQuarry(restrictedQuarry)
        advanceUntilIdle()

        viewModel.downloadDocument(testDoc)
        viewModel.shareDocument(testDoc)
        advanceUntilIdle()
        assertEquals(0, fakeRepository.downloadPayloadCalls)
        assertNull(viewModel.uiState.value.downloadedDocumentData)
        assertNull(viewModel.uiState.value.pendingShareDocumentData)

        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()
        viewModel.shareDocument(testDoc.copy(status = "pending"))
        advanceUntilIdle()
        assertEquals(0, fakeRepository.downloadPayloadCalls)

        viewModel.shareDocument(testDoc)
        advanceUntilIdle()
        assertEquals(1, fakeRepository.downloadPayloadCalls)
        val shareData = viewModel.uiState.value.pendingShareDocumentData
        assertNotNull(shareData)
        val preparedShare = requireNotNull(shareData)
        assertEquals("safety_protocol.pdf", preparedShare.first.originalFilename)
        assertEquals("PDF-CONTENT-BYTES", preparedShare.second.decodeToString())
        assertEquals("safety_protocol.pdf", DocumentActionsHelper.safeDocumentFileName(preparedShare.first))
        assertEquals("application/pdf", DocumentActionsHelper.documentMimeType(preparedShare.first))
        assertEquals(true, viewModel.uiState.value.isDownloading)

        viewModel.clearPendingShareDocument()
        assertNull(viewModel.uiState.value.pendingShareDocumentData)
        assertFalse(viewModel.uiState.value.isDownloading)
    }

    // ------------------------------------------------------------------------
    // Regression Test 3: Explicitly selecting Open / Preview (View) works as intended.
    // ------------------------------------------------------------------------
    @Test
    fun explicitViewDocument_setsPendingOpenDocumentData_andAllowsConsumption() = runTest(testDispatcher) {
        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()

        // Employee explicitly taps View
        viewModel.viewDocument(testDoc)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isDownloading)
        assertNotNull("Explicit view MUST set pendingOpenDocumentData", state.pendingOpenDocumentData)
        assertEquals(testDoc.id, state.pendingOpenDocumentData?.first?.id)
        assertEquals(testDoc.displayName, state.pendingOpenDocumentData?.first?.displayName)
        assertEquals("PDF-CONTENT-BYTES", state.pendingOpenDocumentData?.second?.decodeToString())

        // UI consumes the event (e.g. LaunchedEffect triggers DocumentActionsHelper.openDocument)
        viewModel.clearPendingOpenDocument()
        assertNull(
            "After consumption, pendingOpenDocumentData must be reset to null",
            viewModel.uiState.value.pendingOpenDocumentData
        )
    }

    // ------------------------------------------------------------------------
    // Regression Test 4: Navigating away from and back to a quarry does not replay stale open action.
    // ------------------------------------------------------------------------
    @Test
    fun navigatingAwayFromAndBackToQuarry_doesNotReplayStaleOpenAction() = runTest(testDispatcher) {
        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()

        viewModel.viewDocument(testDoc)
        advanceUntilIdle()
        assertNotNull(viewModel.uiState.value.pendingOpenDocumentData)

        // Employee navigates away (e.g. Back button or Trash or Home)
        viewModel.navigateBackToHome()
        advanceUntilIdle()

        assertNull("Pending open must be cleared on navigate back to home", viewModel.uiState.value.pendingOpenDocumentData)

        // Employee re-enters quarry
        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()

        assertNull(
            "Re-entering quarry must NOT replay stale open action",
            viewModel.uiState.value.pendingOpenDocumentData
        )
    }

    // ------------------------------------------------------------------------
    // Regression Test 5: Recomposition / screen recreation does not trigger duplicate open actions.
    // ------------------------------------------------------------------------
    @Test
    fun recompositionOrScreenRecreation_doesNotTriggerDuplicateOpen() = runTest(testDispatcher) {
        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()

        // View triggered
        viewModel.viewDocument(testDoc)
        advanceUntilIdle()

        val initialData = viewModel.uiState.value.pendingOpenDocumentData
        assertNotNull(initialData)

        // Simulated LaunchedEffect handling: opens once and immediately clears
        viewModel.clearPendingOpenDocument()
        assertNull("Consumed immediately", viewModel.uiState.value.pendingOpenDocumentData)

        // Screen recomposes / recreates: state is observed again
        val recomposedState = viewModel.uiState.value
        assertNull(
            "Recomposed state has null pendingOpenDocumentData, so LaunchedEffect will NOT re-trigger",
            recomposedState.pendingOpenDocumentData
        )
    }

    // ------------------------------------------------------------------------
    // Additional Test: Folder navigation and Trash navigation also clear pending document actions.
    // ------------------------------------------------------------------------
    @Test
    fun folderAndTrashNavigation_clearsPendingActions() = runTest(testDispatcher) {
        viewModel.selectQuarry(testQuarry)
        advanceUntilIdle()

        viewModel.viewDocument(testDoc)
        advanceUntilIdle()
        assertNotNull(viewModel.uiState.value.pendingOpenDocumentData)

        // Navigate to Trash
        viewModel.navigateToTrash(testQuarry.id)
        advanceUntilIdle()
        assertNull("Navigating to trash must clear pending open", viewModel.uiState.value.pendingOpenDocumentData)

        // Navigate back from Trash
        viewModel.navigateBackFromTrash()
        advanceUntilIdle()
        assertNull("Navigating back from trash must not have pending open", viewModel.uiState.value.pendingOpenDocumentData)
    }
}
