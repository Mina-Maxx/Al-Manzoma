package com.quarryvault.employee.ui.screens.scanner

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.quarryvault.employee.ui.screens.EmployeeAppUiState
import com.quarryvault.employee.ui.screens.EmployeeAppViewModel
import com.quarryvault.employee.ui.screens.ScannerStep

@Composable
fun DocumentScannerScreen(
    uiState: EmployeeAppUiState,
    viewModel: EmployeeAppViewModel,
    onNavigateBack: () -> Unit
) {
    val context = LocalContext.current
    val isAr = uiState.isArabic

    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED
        )
    }

    var showPermissionRationale by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        hasCameraPermission = isGranted
        if (!isGranted) {
            showPermissionRationale = true
        }
    }

    LaunchedEffect(Unit) {
        if (!hasCameraPermission) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    if (!hasCameraPermission) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            contentAlignment = Alignment.Center
        ) {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    Icon(
                        Icons.Default.CameraAlt,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(56.dp)
                    )
                    Text(
                        text = if (isAr) "إذن الكاميرا مطلوب" else "Camera Permission Required",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center
                    )
                    Text(
                        text = if (isAr)
                            "يتطلب مسح المستندات ضوئيًا إذن الوصول إلى الكاميرا لالتقاط صور المستندات ومعالجتها على جهازك مباشرة."
                        else
                            "QuarryVault requires camera access to scan physical documents, detect boundaries, and generate PDFs locally on your device.",
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        OutlinedButton(
                            onClick = onNavigateBack,
                            modifier = Modifier.weight(1f)
                        ) {
                            Text(if (isAr) "إلغاء" else "Cancel")
                        }
                        Button(
                            onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                            modifier = Modifier.weight(1f)
                        ) {
                            Text(if (isAr) "منح الإذن" else "Grant Permission")
                        }
                    }
                }
            }
        }
        return
    }

    when (uiState.scannerStep) {
        ScannerStep.CAMERA -> {
            CameraScannerView(
                pageCount = uiState.scannedPages.size,
                isArabic = isAr,
                onPictureTaken = { file ->
                    viewModel.onPageCaptured(file)
                },
                onReviewClicked = {
                    viewModel.openScannerReview()
                },
                onCloseClicked = {
                    viewModel.cancelScanning()
                }
            )
        }
        ScannerStep.CROP -> {
            val rawFile = uiState.activeCapturedFile
            if (rawFile != null && rawFile.exists()) {
                CornerAdjustmentView(
                    imageFile = rawFile,
                    initialCorners = uiState.activeDetectedCorners,
                    isArabic = isAr,
                    onCornersConfirmed = { bitmap, corners ->
                        viewModel.onCornersAdjusted(bitmap, corners)
                    },
                    onRetakeClicked = {
                        viewModel.retakeActiveCapture()
                    }
                )
            } else {
                viewModel.retakeActiveCapture()
            }
        }
        ScannerStep.FILTER -> {
            val warpedBitmap = uiState.activeWarpedBitmap
            if (warpedBitmap != null) {
                FilterAdjustmentView(
                    warpedBitmap = warpedBitmap,
                    initialFilter = uiState.activeFilterMode,
                    initialRotation = uiState.activeRotationDegrees,
                    isArabic = isAr,
                    onConfirmPage = { finalBitmap, filter, rotation, addAnotherPage ->
                        viewModel.commitActivePage(finalBitmap, filter, rotation, addAnotherPage)
                    },
                    onRetakeClicked = {
                        viewModel.retakeActiveCapture()
                    }
                )
            } else {
                viewModel.retakeActiveCapture()
            }
        }
        ScannerStep.REVIEW -> {
            ScanReviewUploadView(
                pages = uiState.scannedPages,
                pdfFile = uiState.generatedPdfFile,
                documentName = uiState.scanDocumentName,
                onDocumentNameChanged = { viewModel.onScanDocumentNameChanged(it) },
                destinationQuarry = uiState.targetUploadQuarry ?: uiState.selectedQuarry,
                availableQuarries = uiState.quarries,
                onDestinationQuarryChanged = { viewModel.onTargetQuarryChanged(it) },
                selectedFolderId = uiState.selectedScanFolderId,
                availableFolders = uiState.folders,
                onFolderSelected = { viewModel.onScanFolderSelected(it) },
                isGeneratingPdf = uiState.isGeneratingPdf,
                isUploading = uiState.isUploadingScan,
                uploadError = uiState.scanUploadError,
                isArabic = isAr,
                onReorderPage = { from, to -> viewModel.reorderScannedPages(from, to) },
                onDeletePage = { id -> viewModel.deleteScannedPage(id) },
                onAddMorePages = { viewModel.resumeCameraScanning() },
                onUploadClicked = { viewModel.uploadScannedDocument() },
                onDiscardClicked = { viewModel.cancelScanning() }
            )
        }
    }
}
