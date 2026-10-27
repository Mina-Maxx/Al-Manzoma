package com.quarryvault.employee.ui.screens

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.ui.util.DocumentActionsHelper
import com.quarryvault.employee.ui.util.UiFormatters

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuarryDetailScreen(
    uiState: EmployeeAppUiState,
    quarry: Quarry,
    onNavigateBack: () -> Unit,
    onSelectFolder: (String?) -> Unit,
    onSearchDocumentChange: (String) -> Unit,
    onRefresh: () -> Unit,
    onUploadDocument: (ByteArray, String, String, String?) -> Unit,
    onDownloadDocument: (Document) -> Unit,
    onToggleLanguage: () -> Unit,
    onOpenUploadDialog: () -> Unit,
    onDismissUploadDialog: () -> Unit,
    onClearMessages: () -> Unit,
    onStartScanDocument: () -> Unit = {},
    onNavigateToTrash: () -> Unit = {},
    onDeleteDocument: (Document) -> Unit = {}
) {
    val context = LocalContext.current
    val isAr = uiState.isArabic
    val layoutDirection = if (isAr) LayoutDirection.Rtl else LayoutDirection.Ltr

    // State for deletion confirmation dialog
    var documentPendingDelete by remember { mutableStateOf<Document?>(null) }

    // State for picked file pending upload
    var pendingFileUri by remember { mutableStateOf<Uri?>(null) }
    var pendingFileName by remember { mutableStateOf("") }
    var pendingFileSize by remember { mutableStateOf(0L) }
    var pendingFileMimeType by remember { mutableStateOf("application/pdf") }
    var customDisplayName by remember { mutableStateOf("") }

    // Launcher for system file picker
    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) {
            pendingFileUri = uri
            var name = "document.pdf"
            var size = 0L

            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (cursor.moveToFirst()) {
                    if (nameIndex != -1) name = cursor.getString(nameIndex)
                    if (sizeIndex != -1) size = cursor.getLong(sizeIndex)
                }
            }

            val mime = context.contentResolver.getType(uri) ?: "application/pdf"
            pendingFileName = name
            pendingFileSize = size
            pendingFileMimeType = mime
            customDisplayName = name.substringBeforeLast(".")
            onOpenUploadDialog()
        }
    }

    // Effect to handle view/print when download completes
    LaunchedEffect(uiState.downloadedDocumentData) {
        val data = uiState.downloadedDocumentData
        if (data != null) {
            DocumentActionsHelper.openDocument(context, data.first, data.second)
        }
    }

    CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Column {
                            Text(
                                text = quarry.name,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            val currentFolderName = uiState.folders.firstOrNull { it.id == uiState.currentFolderId }?.name
                            Text(
                                text = currentFolderName
                                    ?: if (isAr) "المجلد الرئيسي" else "Root Folder",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.8f)
                            )
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onNavigateBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = if (isAr) "رجوع" else "Back"
                            )
                        }
                    },
                    actions = {
                        IconButton(onClick = onNavigateToTrash) {
                            Icon(
                                Icons.Default.DeleteOutline,
                                contentDescription = if (isAr) "سلة المهملات" else "Trash"
                            )
                        }
                        IconButton(onClick = onToggleLanguage) {
                            Text(
                                text = if (isAr) "EN" else "عربي",
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        IconButton(onClick = onRefresh) {
                            Icon(Icons.Default.Refresh, contentDescription = if (isAr) "تحديث" else "Refresh")
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer
                    )
                )
            },
            floatingActionButton = {
                if (quarry.permissions.canUpload) {
                    Column(
                        horizontalAlignment = Alignment.End,
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        ExtendedFloatingActionButton(
                            onClick = onStartScanDocument,
                            icon = { Icon(Icons.Default.DocumentScanner, contentDescription = null) },
                            text = { Text(if (isAr) "مسح مستند ضوئيًا" else "Scan Document") },
                            containerColor = MaterialTheme.colorScheme.primary,
                            contentColor = MaterialTheme.colorScheme.onPrimary
                        )

                        SmallFloatingActionButton(
                            onClick = {
                                filePickerLauncher.launch("*/*")
                            },
                            containerColor = MaterialTheme.colorScheme.secondaryContainer,
                            contentColor = MaterialTheme.colorScheme.onSecondaryContainer
                        ) {
                            Icon(Icons.Default.CloudUpload, contentDescription = if (isAr) "رفع ملف من الجهاز" else "Upload File from Device")
                        }
                    }
                }
            }
        ) { innerPadding ->
            val currentFolder = uiState.folders.firstOrNull { it.id == uiState.currentFolderId }

            // Filter subfolders: folders where parent_id matches currentFolderId
            val subFolders = uiState.folders.filter { folder ->
                if (uiState.currentFolderId == null) {
                    folder.parentId == null
                } else {
                    folder.parentId == uiState.currentFolderId
                }
            }

            // Filter documents
            val filteredDocuments = uiState.documents.filter { doc ->
                uiState.documentSearchQuery.isBlank() ||
                        doc.displayName.contains(uiState.documentSearchQuery, ignoreCase = true) ||
                        doc.originalFilename.contains(uiState.documentSearchQuery, ignoreCase = true)
            }

            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(top = 12.dp, bottom = 80.dp)
            ) {
                // Success / Error Banners
                if (uiState.uploadSuccessMessage != null) {
                    item {
                        BannerMessage(
                            message = if (isAr) uiState.uploadSuccessMessage.arabic else uiState.uploadSuccessMessage.english,
                            isError = false,
                            onDismiss = onClearMessages
                        )
                    }
                }

                if (uiState.uploadError != null) {
                    item {
                        BannerMessage(
                            message = if (isAr) uiState.uploadError.arabic else uiState.uploadError.english,
                            isError = true,
                            onDismiss = onClearMessages
                        )
                    }
                }

                if (uiState.downloadSuccessMessage != null) {
                    item {
                        BannerMessage(
                            message = if (isAr) uiState.downloadSuccessMessage.arabic else uiState.downloadSuccessMessage.english,
                            isError = false,
                            onDismiss = onClearMessages
                        )
                    }
                }

                if (uiState.downloadError != null) {
                    item {
                        BannerMessage(
                            message = if (isAr) uiState.downloadError.arabic else uiState.downloadError.english,
                            isError = true,
                            onDismiss = onClearMessages
                        )
                    }
                }

                if (uiState.deleteSuccessMessage != null) {
                    item {
                        BannerMessage(
                            message = if (isAr) uiState.deleteSuccessMessage.arabic else uiState.deleteSuccessMessage.english,
                            isError = false,
                            onDismiss = onClearMessages
                        )
                    }
                }

                if (uiState.deleteDocumentError != null) {
                    item {
                        BannerMessage(
                            message = if (isAr) uiState.deleteDocumentError.arabic else uiState.deleteDocumentError.english,
                            isError = true,
                            onDismiss = onClearMessages
                        )
                    }
                }

                // Breadcrumbs & Navigation Bar
                item {
                    BreadcrumbBar(
                        quarryName = quarry.name,
                        currentFolder = currentFolder,
                        isAr = isAr,
                        onGoToRoot = { onSelectFolder(null) }
                    )
                }

                // Search Bar
                item {
                    OutlinedTextField(
                        value = uiState.documentSearchQuery,
                        onValueChange = onSearchDocumentChange,
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = {
                            Text(if (isAr) "البحث في المستندات..." else "Search documents...")
                        },
                        leadingIcon = {
                            Icon(Icons.Default.Search, contentDescription = null)
                        },
                        trailingIcon = {
                            if (uiState.documentSearchQuery.isNotEmpty()) {
                                IconButton(onClick = { onSearchDocumentChange("") }) {
                                    Icon(Icons.Default.Clear, contentDescription = null)
                                }
                            }
                        },
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp)
                    )
                }

                // Subfolders Section (if any exist)
                if (subFolders.isNotEmpty()) {
                    item {
                        Text(
                            text = if (isAr) "المجلدات" else "Folders",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }

                    item {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            items(subFolders, key = { it.id }) { folder ->
                                FolderChip(
                                    folder = folder,
                                    onClick = { onSelectFolder(folder.id) }
                                )
                            }
                        }
                    }
                }

                // Documents Section Header
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = if (isAr) "المستندات" else "Documents",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "(${filteredDocuments.size})",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.secondary
                        )
                    }
                }

                // Loading State
                if (uiState.isLoadingContent) {
                    item {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(32.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }
                } else if (filteredDocuments.isEmpty()) {
                    // Empty Documents State
                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
                            ),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(32.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Icon(
                                    Icons.Default.FolderOpen,
                                    contentDescription = null,
                                    modifier = Modifier.size(48.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(
                                    text = if (isAr) "لا توجد مستندات في هذا المجلد" else "No documents in this folder",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold
                                )
                                if (quarry.permissions.canUpload) {
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Text(
                                        text = if (isAr) "اضغط على زر الرفع لإضافة مستند جديد" else "Use the upload button below to add files",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }
                } else {
                    // Documents List
                    items(filteredDocuments, key = { it.id }) { doc ->
                        DocumentCard(
                            document = doc,
                            canDownload = quarry.permissions.canDownload,
                            canUpload = quarry.permissions.canUpload,
                            isDownloading = uiState.isDownloading && uiState.downloadingDocumentId == doc.id,
                            isAr = isAr,
                            onView = { onDownloadDocument(doc) },
                            onDownload = { onDownloadDocument(doc) },
                            onPrint = {
                                if (quarry.permissions.canDownload) {
                                    onDownloadDocument(doc)
                                }
                            },
                            onDelete = { documentPendingDelete = doc }
                        )
                    }
                }
            }
        }

        // Upload Confirmation Dialog
        if (uiState.isUploadDialogVisible && pendingFileUri != null) {
            AlertDialog(
                onDismissRequest = onDismissUploadDialog,
                title = {
                    Text(if (isAr) "تأكيد رفع المستند" else "Confirm Document Upload")
                },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            text = if (isAr) "الملف المحدد:" else "Selected File:",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = pendingFileName,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "${if (isAr) "الحجم:" else "Size:"} ${UiFormatters.formatBytes(pendingFileSize, isAr)}",
                            style = MaterialTheme.typography.bodySmall
                        )

                        OutlinedTextField(
                            value = customDisplayName,
                            onValueChange = { customDisplayName = it },
                            label = { Text(if (isAr) "اسم العرض (اختياري)" else "Display Name (optional)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )

                        val folderName = uiState.folders.firstOrNull { it.id == uiState.currentFolderId }?.name
                        Text(
                            text = "${if (isAr) "وجهة الرفع:" else "Target Folder:"} ${folderName ?: if (isAr) "المجلد الرئيسي" else "Root Folder"}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary
                        )

                        if (uiState.isUploading) {
                            Spacer(modifier = Modifier.height(8.dp))
                            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                        }
                    }
                },
                confirmButton = {
                    Button(
                        onClick = {
                            try {
                                val bytes = context.contentResolver.openInputStream(pendingFileUri!!)?.use {
                                    it.readBytes()
                                } ?: ByteArray(0)

                                onUploadDocument(
                                    bytes,
                                    pendingFileName,
                                    pendingFileMimeType,
                                    customDisplayName.ifBlank { pendingFileName }
                                )
                            } catch (e: Exception) {
                                // Error handled by ViewModel
                            }
                        },
                        enabled = !uiState.isUploading
                    ) {
                        Text(if (isAr) "رفع الآن" else "Upload Now")
                    }
                },
                dismissButton = {
                    TextButton(
                        onClick = onDismissUploadDialog,
                        enabled = !uiState.isUploading
                    ) {
                        Text(if (isAr) "إلغاء" else "Cancel")
                    }
                }
            )
        }

        // Deletion Confirmation Dialog
        if (documentPendingDelete != null) {
            val doc = documentPendingDelete!!
            AlertDialog(
                onDismissRequest = { documentPendingDelete = null },
                icon = {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error
                    )
                },
                title = {
                    Text(if (isAr) "حذف المستند" else "Delete Document")
                },
                text = {
                    Text(
                        if (isAr)
                            "هل أنت متأكد من نقل المستند '${doc.displayName}' إلى سلة المهملات؟ يمكنك استعادته خلال 30 يوماً."
                        else
                            "Are you sure you want to move '${doc.displayName}' to trash? It can be restored within 30 days."
                    )
                },
                confirmButton = {
                    Button(
                        onClick = {
                            val target = doc
                            documentPendingDelete = null
                            onDeleteDocument(target)
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                    ) {
                        Text(if (isAr) "نقل إلى السلة" else "Move to Trash")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { documentPendingDelete = null }) {
                        Text(if (isAr) "إلغاء" else "Cancel")
                    }
                }
            )
        }
    }
}

@Composable
fun BreadcrumbBar(
    quarryName: String,
    currentFolder: Folder?,
    isAr: Boolean,
    onGoToRoot: () -> Unit
) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                Icons.Default.Home,
                contentDescription = null,
                modifier = Modifier
                    .size(18.dp)
                    .clickable(onClick = onGoToRoot),
                tint = MaterialTheme.colorScheme.primary
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = if (isAr) "الرئيسي" else "Root",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = if (currentFolder == null) FontWeight.Bold else FontWeight.Normal,
                modifier = Modifier.clickable(onClick = onGoToRoot)
            )

            if (currentFolder != null) {
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = "/",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.width(6.dp))
                Icon(
                    Icons.Default.Folder,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.secondary
                )
                Spacer(modifier = Modifier.width(4.dp))
                Text(
                    text = currentFolder.name,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
fun FolderChip(
    folder: Folder,
    onClick: () -> Unit
) {
    Surface(
        shape = RoundedCornerShape(10.dp),
        color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.clickable(onClick = onClick)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Icon(
                Icons.Default.Folder,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSecondaryContainer
            )
            Text(
                text = folder.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSecondaryContainer
            )
        }
    }
}

@Composable
fun DocumentCard(
    document: Document,
    canDownload: Boolean,
    canUpload: Boolean = false,
    isDownloading: Boolean,
    isAr: Boolean,
    onView: () -> Unit,
    onDownload: () -> Unit,
    onPrint: () -> Unit,
    onDelete: () -> Unit = {}
) {
    val isPdf = document.mimeType.contains("pdf", ignoreCase = true) ||
            document.originalFilename.endsWith(".pdf", ignoreCase = true)
    val isImage = document.mimeType.startsWith("image/", ignoreCase = true)

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                // File Type Icon Badge
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = when {
                        isPdf -> Color(0xFFFFEBEE)
                        isImage -> Color(0xFFE8F5E9)
                        else -> Color(0xFFE3F2FD)
                    },
                    modifier = Modifier.size(44.dp)
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            imageVector = when {
                                isPdf -> Icons.Default.PictureAsPdf
                                isImage -> Icons.Default.Image
                                else -> Icons.Default.Description
                            },
                            contentDescription = null,
                            tint = when {
                                isPdf -> Color(0xFFC62828)
                                isImage -> Color(0xFF2E7D32)
                                else -> Color(0xFF1565C0)
                            }
                        )
                    }
                }

                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = document.displayName,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = document.originalFilename,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(4.dp))

                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = UiFormatters.formatBytes(document.sizeBytes, isAr),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.secondary
                        )
                        Text(text = "•", style = MaterialTheme.typography.labelSmall)
                        Text(
                            text = "v${document.version}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.secondary
                        )
                        Text(text = "•", style = MaterialTheme.typography.labelSmall)
                        Text(
                            text = UiFormatters.formatDate(document.createdAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.outline
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(10.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.3f))
            Spacer(modifier = Modifier.height(8.dp))

            // Action Buttons
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (isDownloading) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .size(24.dp)
                            .padding(end = 8.dp),
                        strokeWidth = 2.dp
                    )
                }

                // View Button
                TextButton(
                    onClick = onView,
                    enabled = !isDownloading
                ) {
                    Icon(Icons.Default.Visibility, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(if (isAr) "عرض" else "View")
                }

                // Download Button (Enabled only if canDownload)
                TextButton(
                    onClick = onDownload,
                    enabled = canDownload && !isDownloading
                ) {
                    Icon(Icons.Default.Download, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(if (isAr) "تحميل" else "Download")
                }

                // Print Button (Enabled only if canDownload)
                if (canDownload) {
                    IconButton(
                        onClick = onPrint,
                        enabled = !isDownloading
                    ) {
                        Icon(
                            Icons.Default.Print,
                            contentDescription = if (isAr) "طباعة" else "Print",
                            modifier = Modifier.size(18.dp)
                        )
                    }
                }

                // Delete Button (Enabled only if canUpload)
                if (canUpload) {
                    IconButton(
                        onClick = onDelete,
                        enabled = !isDownloading
                    ) {
                        Icon(
                            Icons.Default.Delete,
                            contentDescription = if (isAr) "حذف" else "Delete",
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(18.dp)
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun BannerMessage(
    message: String,
    isError: Boolean,
    onDismiss: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isError) MaterialTheme.colorScheme.errorContainer else Color(0xFFE8F5E9)
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.weight(1f)
            ) {
                Icon(
                    imageVector = if (isError) Icons.Default.ErrorOutline else Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint = if (isError) MaterialTheme.colorScheme.error else Color(0xFF2E7D32)
                )
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (isError) MaterialTheme.colorScheme.onErrorContainer else Color(0xFF1B5E20)
                )
            }
            IconButton(onClick = onDismiss, modifier = Modifier.size(24.dp)) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp)
                )
            }
        }
    }
}
