package com.quarryvault.employee.ui.screens

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.widget.Toast
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
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
    onShareDocument: (Document) -> Unit,
    onViewDocument: (Document) -> Unit,
    onPrintDocument: (Document) -> Unit,
    onClearPendingOpenDocument: () -> Unit,
    onClearPendingPrintDocument: () -> Unit,
    onClearDownloadedDocumentData: () -> Unit,
    onClearPendingShareDocument: () -> Unit,
    onOpenUploadDialog: () -> Unit,
    onDismissUploadDialog: () -> Unit,
    onClearMessages: () -> Unit,
    onStartScanDocument: () -> Unit = {},
    onNavigateToTrash: () -> Unit = {},
    onDeleteDocument: (Document) -> Unit = {},
    onRenameDocument: (Document, String) -> Unit = { _, _ -> },
    onOpenCreateFolderDialog: () -> Unit = {},
    onDismissCreateFolderDialog: () -> Unit = {},
    onNewFolderNameChanged: (String) -> Unit = {},
    onConfirmCreateFolder: (String) -> Unit = {},
    onDeleteFolder: (Folder) -> Unit = {}
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    var pendingSaveData by remember { mutableStateOf<Pair<Document, ByteArray>?>(null) }
    var savingDocumentId by remember { mutableStateOf<String?>(null) }
    val saveDocumentLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val pending = pendingSaveData
        pendingSaveData = null
        val destination = result.data?.data
        if (result.resultCode == Activity.RESULT_OK && destination != null && pending != null) {
            savingDocumentId = pending.first.id
            Toast.makeText(context, "جارٍ حفظ الملف...", Toast.LENGTH_SHORT).show()
            coroutineScope.launch {
                try {
                    val saved = withContext(Dispatchers.IO) {
                        DocumentActionsHelper.writeDocumentToUri(context, destination, pending.second)
                    }
                    val message = if (saved) {
                        "اكتمل التنزيل: ${DocumentActionsHelper.safeDocumentFileName(pending.first)}"
                    } else {
                        "تعذر حفظ الملف في المكان المحدد. اختر مكاناً آخر وحاول مجدداً."
                    }
                    Toast.makeText(context, message, Toast.LENGTH_LONG).show()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    Toast.makeText(
                        context,
                        "تعذر حفظ الملف في المكان المحدد. اختر مكاناً آخر وحاول مجدداً.",
                        Toast.LENGTH_LONG
                    ).show()
                } finally {
                    savingDocumentId = null
                    onClearDownloadedDocumentData()
                }
            }
        } else if (result.resultCode == Activity.RESULT_CANCELED) {
            Toast.makeText(context, "تم إلغاء التنزيل.", Toast.LENGTH_SHORT).show()
            onClearDownloadedDocumentData()
        } else {
            Toast.makeText(context, "تعذر حفظ الملف في المكان المحدد.", Toast.LENGTH_LONG).show()
            onClearDownloadedDocumentData()
        }
    }
    val isAr = uiState.isArabic
    val layoutDirection = if (isAr) LayoutDirection.Rtl else LayoutDirection.Ltr
    val isCompanyAdmin = uiState.profile?.role == "company_admin"

    // State for deletion confirmation dialog
    var documentPendingDelete by remember { mutableStateOf<Document?>(null) }
    var documentPendingRename by remember { mutableStateOf<Document?>(null) }

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

    // Ask the employee to choose the destination for each individual download.
    LaunchedEffect(uiState.downloadedDocumentData) {
        val data = uiState.downloadedDocumentData
        if (data != null && pendingSaveData == null) {
            pendingSaveData = data
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = DocumentActionsHelper.documentMimeType(data.first)
                putExtra(Intent.EXTRA_TITLE, DocumentActionsHelper.safeDocumentFileName(data.first))
            }
            try {
                saveDocumentLauncher.launch(intent)
            } catch (_: Exception) {
                pendingSaveData = null
                Toast.makeText(context, "تعذر فتح نافذة اختيار مكان الحفظ.", Toast.LENGTH_LONG).show()
                onClearDownloadedDocumentData()
            }
        }
    }

    LaunchedEffect(uiState.pendingShareDocumentData) {
        val data = uiState.pendingShareDocumentData
        if (data != null) {
            try {
                val uri = withContext(Dispatchers.IO) {
                    DocumentActionsHelper.prepareShareDocument(context, data.first, data.second)
                }
                if (uri == null || !DocumentActionsHelper.launchShareDocument(context, data.first, uri)) {
                    Toast.makeText(
                        context,
                        "تعذر تجهيز الملف للمشاركة. يرجى المحاولة مرة أخرى.",
                        Toast.LENGTH_LONG
                    ).show()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                Toast.makeText(
                    context,
                    "تعذر تجهيز الملف للمشاركة. يرجى المحاولة مرة أخرى.",
                    Toast.LENGTH_LONG
                ).show()
            } finally {
                onClearPendingShareDocument()
            }
        }
    }

    // Effect to handle View (open in external viewer)
    LaunchedEffect(uiState.pendingOpenDocumentData) {
        val data = uiState.pendingOpenDocumentData
        if (data != null) {
            DocumentActionsHelper.openDocument(context, data.first, data.second)
            onClearPendingOpenDocument()
        }
    }

    // Effect to handle Print (send to PrintManager)
    LaunchedEffect(uiState.pendingPrintDocumentData) {
        val data = uiState.pendingPrintDocumentData
        if (data != null) {
            DocumentActionsHelper.printDocument(context, data.first, data.second)
            onClearPendingPrintDocument()
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
                                contentDescription = "سلة المهملات"
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer
                    )
                )
            },
            floatingActionButton = {
                if (isCompanyAdmin || quarry.permissions.canUpload) {
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

            val sortedSubFolders = remember(subFolders) {
                com.quarryvault.employee.ui.util.UiFormatters.sortAlphabetically(subFolders) { it.name }
            }
            val sortedDocuments = remember(filteredDocuments) {
                com.quarryvault.employee.ui.util.UiFormatters.sortAlphabetically(filteredDocuments) { it.displayName }
            }

            PullToRefreshBox(
                isRefreshing = uiState.isRefreshingContent,
                onRefresh = onRefresh,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
            ) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    contentPadding = PaddingValues(top = 12.dp, bottom = 80.dp)
                ) {
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
                            onSearchDocumentChange,
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

                    // Subfolders Section (Vertical List of Folders)
                    if (sortedSubFolders.isNotEmpty()) {
                        item {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = if (isAr) "المجلدات" else "Folders",
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.primary
                                )
                                Text(
                                    text = "(${sortedSubFolders.size})",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.secondary
                                )
                            }
                        }

                        items(sortedSubFolders, key = { it.id }) { folder ->
                            FolderCard(
                                folder = folder,
                                isAr = isAr,
                                onClick = { onSelectFolder(folder.id) },
                                onDelete = if ((isCompanyAdmin || quarry.permissions.canDelete) && !folder.isStandard) {
                                    { onDeleteFolder(folder) }
                                } else null
                            )
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
                    } else if (sortedDocuments.isEmpty()) {
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
                                    if (isCompanyAdmin || quarry.permissions.canUpload) {
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
                        items(sortedDocuments, key = { it.id }) { doc ->
                            DocumentCard(
                                document = doc,
                                canDownload = isCompanyAdmin || quarry.permissions.canDownload,
                                canDelete = isCompanyAdmin || quarry.permissions.canDelete,
                                isDownloading = (uiState.isDownloading && uiState.downloadingDocumentId == doc.id) ||
                                        savingDocumentId == doc.id,
                                isAr = isAr,
                                onView = { onViewDocument(doc) },
                                onDownload = { onDownloadDocument(doc) },
                                onShare = { onShareDocument(doc) },
                                onPrint = { onPrintDocument(doc) },
                                onDelete = { documentPendingDelete = doc },
                                onRename = { documentPendingRename = doc }
                            )
                        }
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

        // Rename Confirmation Dialog
        if (documentPendingRename != null) {
            val doc = documentPendingRename!!
            RenameDocumentDialog(
                currentName = doc.displayName,
                isAr = isAr,
                onDismiss = { documentPendingRename = null },
                onConfirm = { newName ->
                    documentPendingRename = null
                    onRenameDocument(doc, newName)
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
fun FolderCard(
    folder: Folder,
    isAr: Boolean = true,
    onClick: () -> Unit,
    onDelete: (() -> Unit)? = null
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.weight(1f)
            ) {
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    modifier = Modifier.size(40.dp)
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            imageVector = Icons.Default.Folder,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.size(22.dp)
                        )
                    }
                }
                Column {
                    Text(
                        text = folder.name,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Text(
                        text = if (folder.isStandard) {
                            if (isAr) "مجلد قياسي" else "Standard Folder"
                        } else {
                            if (isAr) "مجلد مخصص" else "Custom Folder"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                if (onDelete != null) {
                    IconButton(
                        onClick = onDelete,
                        modifier = Modifier.size(36.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.DeleteOutline,
                            contentDescription = if (isAr) "حذف المجلد" else "Delete Folder",
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(20.dp)
                        )
                    }
                }
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowForward,
                    contentDescription = if (isAr) "فتح" else "Open",
                    tint = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.size(18.dp)
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
    canDelete: Boolean = false,
    isDownloading: Boolean,
    isAr: Boolean,
    onView: () -> Unit,
    onDownload: () -> Unit,
    onShare: () -> Unit,
    onPrint: () -> Unit,
    onDelete: () -> Unit = {},
    onRename: () -> Unit = {}
) {
    val isPdf = document.mimeType.contains("pdf", ignoreCase = true) ||
            document.originalFilename.endsWith(".pdf", ignoreCase = true)
    val isImage = document.mimeType.startsWith("image/", ignoreCase = true)
    var menuExpanded by remember { mutableStateOf(false) }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onView),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
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

            // File Information (Name, filename, metadata)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = document.displayName,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
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
                        text = "الإصدار ${document.version}",
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

            // Three-dot overflow menu anchor
            Box {
                if (isDownloading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        strokeWidth = 2.dp
                    )
                } else {
                    IconButton(
                        onClick = { menuExpanded = true }
                    ) {
                        Icon(
                            imageVector = Icons.Default.MoreVert,
                            contentDescription = if (isAr) "خيارات الملف" else "File Options"
                        )
                    }
                }

                DropdownMenu(
                    expanded = menuExpanded,
                    onDismissRequest = { menuExpanded = false }
                ) {
                    // View / Open
                    DropdownMenuItem(
                        text = { Text(if (isAr) "عرض" else "View") },
                        leadingIcon = {
                            Icon(Icons.Default.Visibility, contentDescription = null)
                        },
                        onClick = {
                            menuExpanded = false
                            onView()
                        }
                    )

                    // Download (if authorized)
                    if (canDownload) {
                        DropdownMenuItem(
                            text = { Text(if (isAr) "تنزيل" else "Download") },
                            leadingIcon = {
                                Icon(Icons.Default.Download, contentDescription = null)
                            },
                            onClick = {
                                menuExpanded = false
                                onDownload()
                            }
                        )

                        DropdownMenuItem(
                            text = { Text("مشاركة") },
                            leadingIcon = {
                                Icon(Icons.Default.Share, contentDescription = null)
                            },
                            onClick = {
                                menuExpanded = false
                                onShare()
                            }
                        )

                        // Print (if authorized)
                        DropdownMenuItem(
                            text = { Text(if (isAr) "طباعة" else "Print") },
                            leadingIcon = {
                                Icon(Icons.Default.Print, contentDescription = null)
                            },
                            onClick = {
                                menuExpanded = false
                                onPrint()
                            }
                        )
                    }

                    // Rename (available to all users with can_view)
                    DropdownMenuItem(
                        text = { Text(if (isAr) "إعادة تسمية" else "Rename") },
                        leadingIcon = {
                            Icon(Icons.Default.Edit, contentDescription = null)
                        },
                        onClick = {
                            menuExpanded = false
                            onRename()
                        }
                    )

                    // Delete (if authorized)
                    if (canDelete) {
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = {
                                Text(
                                    if (isAr) "حذف" else "Delete",
                                    color = MaterialTheme.colorScheme.error
                                )
                            },
                            leadingIcon = {
                                Icon(
                                    Icons.Default.Delete,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.error
                                )
                            },
                            onClick = {
                                menuExpanded = false
                                onDelete()
                            }
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

@Composable
fun RenameDocumentDialog(
    currentName: String,
    isAr: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit
) {
    var newName by remember { mutableStateOf(currentName) }
    var errorText by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(Icons.Default.Edit, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        },
        title = {
            Text(
                text = if (isAr) "إعادة تسمية المستند" else "Rename Document",
                style = MaterialTheme.typography.titleMedium
            )
        },
        text = {
            Column {
                Text(
                    text = if (isAr)
                        "أدخل اسم الملف الجديد. سيبقى محتوى الملف ومساحة التخزين وسجل الإصدارات دون تغيير."
                    else
                        "Enter the new filename. File content, storage, and history will remain unchanged.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedTextField(
                    value = newName,
                    onValueChange = {
                        newName = it
                        if (it.isNotBlank()) errorText = null
                    },
                    label = { Text(if (isAr) "اسم المستند الجديد" else "New Filename") },
                    singleLine = true,
                    isError = errorText != null,
                    supportingText = errorText?.let { { Text(it, color = MaterialTheme.colorScheme.error) } },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val trimmed = newName.trim()
                    if (trimmed.isBlank()) {
                        errorText = if (isAr) "لا يمكن أن يكون اسم الملف فارغاً" else "Filename cannot be empty"
                    } else if (trimmed.contains("/") || trimmed.contains("\\")) {
                        errorText = if (isAr) "الاسم لا يمكن أن يحتوي على رموز مسارات" else "Filename cannot contain directory separators"
                    } else {
                        onConfirm(trimmed)
                    }
                }
            ) {
                Text(if (isAr) "حفظ" else "Save")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(if (isAr) "إلغاء" else "Cancel")
            }
        }
    )
}
