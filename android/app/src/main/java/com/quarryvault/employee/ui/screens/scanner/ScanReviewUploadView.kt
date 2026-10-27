package com.quarryvault.employee.ui.screens.scanner

import android.graphics.BitmapFactory
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.scanner.ScannedPage
import com.quarryvault.employee.data.util.LocalizedMessage
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScanReviewUploadView(
    pages: List<ScannedPage>,
    pdfFile: File?,
    documentName: String,
    onDocumentNameChanged: (String) -> Unit,
    destinationQuarry: Quarry?,
    availableQuarries: List<Quarry>,
    onDestinationQuarryChanged: (Quarry) -> Unit,
    selectedFolderId: String?,
    availableFolders: List<Folder>,
    onFolderSelected: (String?) -> Unit,
    isGeneratingPdf: Boolean,
    isUploading: Boolean,
    uploadError: LocalizedMessage?,
    isArabic: Boolean,
    onReorderPage: (Int, Int) -> Unit,
    onDeletePage: (String) -> Unit,
    onAddMorePages: () -> Unit,
    onUploadClicked: () -> Unit,
    onDiscardClicked: () -> Unit
) {
    var showDiscardConfirmation by remember { mutableStateOf(false) }
    var quarryDropdownExpanded by remember { mutableStateOf(false) }
    var folderDropdownExpanded by remember { mutableStateOf(false) }

    // Upload permission quarries only
    val uploadPermittedQuarries = remember(availableQuarries) {
        availableQuarries.filter { it.permissions.canUpload }
    }

    if (showDiscardConfirmation) {
        AlertDialog(
            onDismissRequest = { showDiscardConfirmation = false },
            title = {
                Text(if (isArabic) "إلغاء المسح الضوئي؟" else "Discard Scanned Document?")
            },
            text = {
                Text(
                    if (isArabic)
                        "سيتم حذف جميع الصفحات الممسوحة ضوئيًا (${pages.size} صفحات). هل تريد المتابعة؟"
                    else
                        "All scanned pages (${pages.size} pages) will be discarded. Do you want to continue?"
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDiscardConfirmation = false
                        onDiscardClicked()
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                ) {
                    Text(if (isArabic) "نعم، إلغاء" else "Yes, Discard")
                }
            },
            dismissButton = {
                TextButton(onClick = { showDiscardConfirmation = false }) {
                    Text(if (isArabic) "تراجع" else "Keep")
                }
            }
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = if (isArabic) "مراجعة ورفع المستند" else "Review & Upload Document",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                },
                navigationIcon = {
                    IconButton(onClick = { showDiscardConfirmation = true }) {
                        Icon(Icons.Default.Close, contentDescription = "Discard")
                    }
                },
                actions = {
                    TextButton(onClick = onAddMorePages) {
                        Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(if (isArabic) "إضافة صفحة" else "Add Page")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                )
            )
        },
        bottomBar = {
            Surface(
                tonalElevation = 6.dp,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Button(
                        onClick = onUploadClicked,
                        enabled = !isUploading && !isGeneratingPdf && documentName.isNotBlank() && destinationQuarry != null && pages.isNotEmpty(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(52.dp),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        if (isUploading || isGeneratingPdf) {
                            CircularProgressIndicator(
                                color = MaterialTheme.colorScheme.onPrimary,
                                modifier = Modifier.size(24.dp),
                                strokeWidth = 2.dp
                            )
                            Spacer(Modifier.width(12.dp))
                            Text(
                                if (isGeneratingPdf) {
                                    if (isArabic) "جاري إنشاء ملف PDF..." else "Generating PDF..."
                                } else {
                                    if (isArabic) "جاري رفع المستند..." else "Uploading Document..."
                                }
                            )
                        } else {
                            Icon(Icons.Default.CloudUpload, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = if (isArabic) "رفع إلى المحجر الآن" else "Upload to Quarry Now",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }
                }
            }
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Error banner if upload failed
            if (uploadError != null) {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            Icons.Default.ErrorOutline,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error
                        )
                        Spacer(Modifier.width(12.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = if (isArabic) uploadError.arabic else uploadError.english,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onErrorContainer
                            )
                        }
                    }
                }
            }

            // Summary Card: Pages count, Estimated size
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceAround,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = if (isArabic) "عدد الصفحات" else "Pages",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
                        )
                        Text(
                            text = "${pages.size}",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    VerticalDivider(modifier = Modifier.height(36.dp))

                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = if (isArabic) "حجم الملف المتوقع" else "Estimated Size",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
                        )
                        val sizeBytes = pdfFile?.length() ?: pages.sumOf { it.imageFile.length() }
                        val sizeFormatted = formatFileSize(sizeBytes)
                        Text(
                            text = sizeFormatted,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    VerticalDivider(modifier = Modifier.height(36.dp))

                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = if (isArabic) "النوع" else "Format",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
                        )
                        Text(
                            text = "PDF",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
            }

            // Pages Carousel / Thumbnails with reorder & delete controls
            Text(
                text = if (isArabic) "صفحات المستند (${pages.size})" else "Scanned Pages (${pages.size})",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )

            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                itemsIndexed(pages) { index, page ->
                    Card(
                        modifier = Modifier
                            .width(150.dp)
                            .wrapContentHeight(),
                        shape = RoundedCornerShape(10.dp),
                        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
                    ) {
                        Column {
                            // Thumbnail Image
                            val bitmap = remember(page.imageFile) {
                                val opts = BitmapFactory.Options().apply { inSampleSize = 2 }
                                BitmapFactory.decodeFile(page.imageFile.absolutePath, opts)
                            }

                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(180.dp)
                                    .background(Color.DarkGray)
                            ) {
                                if (bitmap != null) {
                                    Image(
                                        bitmap = bitmap.asImageBitmap(),
                                        contentDescription = "Page ${index + 1}",
                                        contentScale = ContentScale.Fit,
                                        modifier = Modifier.fillMaxSize()
                                    )
                                }

                                Surface(
                                    color = Color(0xAA000000),
                                    shape = RoundedCornerShape(4.dp),
                                    modifier = Modifier
                                        .align(Alignment.TopStart)
                                        .padding(6.dp)
                                ) {
                                    Text(
                                        text = "${index + 1}",
                                        color = Color.White,
                                        style = MaterialTheme.typography.labelSmall,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                    )
                                }
                            }

                            // Reorder and Delete Toolbar
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                IconButton(
                                    onClick = { onReorderPage(index, index - 1) },
                                    enabled = index > 0,
                                    modifier = Modifier.size(32.dp)
                                ) {
                                    Icon(
                                        if (isArabic) Icons.AutoMirrored.Filled.ArrowForward else Icons.AutoMirrored.Filled.ArrowBack,
                                        contentDescription = "Move earlier",
                                        modifier = Modifier.size(16.dp)
                                    )
                                }

                                IconButton(
                                    onClick = { onDeletePage(page.id) },
                                    enabled = pages.size > 1,
                                    modifier = Modifier.size(32.dp)
                                ) {
                                    Icon(
                                        Icons.Default.Delete,
                                        contentDescription = "Delete Page",
                                        tint = if (pages.size > 1) MaterialTheme.colorScheme.error else Color.Gray,
                                        modifier = Modifier.size(16.dp)
                                    )
                                }

                                IconButton(
                                    onClick = { onReorderPage(index, index + 1) },
                                    enabled = index < pages.size - 1,
                                    modifier = Modifier.size(32.dp)
                                ) {
                                    Icon(
                                        if (isArabic) Icons.AutoMirrored.Filled.ArrowBack else Icons.AutoMirrored.Filled.ArrowForward,
                                        contentDescription = "Move later",
                                        modifier = Modifier.size(16.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Document Name Input
            OutlinedTextField(
                value = documentName,
                onValueChange = onDocumentNameChanged,
                label = { Text(if (isArabic) "اسم المستند *" else "Document Name *") },
                supportingText = {
                    Text(if (isArabic) "سيتم حفظه بصيغة PDF" else "Will be saved as PDF")
                },
                trailingIcon = {
                    Text(
                        text = ".pdf",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(end = 12.dp)
                    )
                },
                singleLine = true,
                isError = documentName.isBlank(),
                modifier = Modifier.fillMaxWidth()
            )

            // Destination Quarry Selector
            ExposedDropdownMenuBox(
                expanded = quarryDropdownExpanded,
                onExpandedChange = { quarryDropdownExpanded = !quarryDropdownExpanded },
                modifier = Modifier.fillMaxWidth()
            ) {
                OutlinedTextField(
                    value = destinationQuarry?.name ?: (if (isArabic) "اختر المحجر" else "Select Quarry"),
                    onValueChange = {},
                    readOnly = true,
                    label = { Text(if (isArabic) "المحجر الهدف *" else "Destination Quarry *") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = quarryDropdownExpanded) },
                    modifier = Modifier
                        .menuAnchor()
                        .fillMaxWidth()
                )

                ExposedDropdownMenu(
                    expanded = quarryDropdownExpanded,
                    onDismissRequest = { quarryDropdownExpanded = false }
                ) {
                    uploadPermittedQuarries.forEach { q ->
                        DropdownMenuItem(
                            text = { Text(q.name) },
                            onClick = {
                                onDestinationQuarryChanged(q)
                                quarryDropdownExpanded = false
                            }
                        )
                    }
                }
            }

            // Destination Folder Selector (if available in quarry)
            if (availableFolders.isNotEmpty()) {
                val currentFolder = availableFolders.firstOrNull { it.id == selectedFolderId }
                ExposedDropdownMenuBox(
                    expanded = folderDropdownExpanded,
                    onExpandedChange = { folderDropdownExpanded = !folderDropdownExpanded },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    OutlinedTextField(
                        value = currentFolder?.name ?: (if (isArabic) "المجلد الرئيسي (بدون مجلد)" else "Root (No Folder)"),
                        onValueChange = {},
                        readOnly = true,
                        label = { Text(if (isArabic) "المجلد (اختياري)" else "Folder (Optional)") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = folderDropdownExpanded) },
                        modifier = Modifier
                            .menuAnchor()
                            .fillMaxWidth()
                    )

                    ExposedDropdownMenu(
                        expanded = folderDropdownExpanded,
                        onDismissRequest = { folderDropdownExpanded = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text(if (isArabic) "المجلد الرئيسي (بدون مجلد)" else "Root (No Folder)") },
                            onClick = {
                                onFolderSelected(null)
                                folderDropdownExpanded = false
                            }
                        )
                        availableFolders.forEach { f ->
                            DropdownMenuItem(
                                text = { Text(f.name) },
                                onClick = {
                                    onFolderSelected(f.id)
                                    folderDropdownExpanded = false
                                }
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun formatFileSize(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val kb = bytes / 1024.0
    val mb = kb / 1024.0
    return if (mb >= 1.0) {
        String.format(java.util.Locale.US, "%.1f MB", mb)
    } else {
        String.format(java.util.Locale.US, "%.0f KB", kb)
    }
}
