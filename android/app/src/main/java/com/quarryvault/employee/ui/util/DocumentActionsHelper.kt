package com.quarryvault.employee.ui.util

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.core.content.FileProvider
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.util.ContentDispositionParser
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.Locale
import java.util.UUID

object DocumentActionsHelper {

    fun saveDocumentToCache(context: Context, document: Document, bytes: ByteArray): File {
        val docsDir = File(context.cacheDir, "documents").apply { mkdirs() }
        val rawName = document.originalFilename.ifBlank { document.displayName }
        val safeName = ContentDispositionParser.sanitizeFilename(rawName, fallback = "document.pdf")
        val file = File(docsDir, safeName)
        file.writeBytes(bytes)
        return file
    }

    fun safeDocumentFileName(document: Document): String {
        val rawName = document.originalFilename.ifBlank { document.displayName }
        return ContentDispositionParser.sanitizeFilename(rawName, fallback = "document.pdf")
    }

    fun documentMimeType(document: Document): String {
        val suppliedType = document.mimeType.trim()
        if (suppliedType.isNotEmpty() && suppliedType != "*/*" &&
            !suppliedType.equals("application/octet-stream", ignoreCase = true)) return suppliedType
        val extension = safeDocumentFileName(document).substringAfterLast('.', "").lowercase(Locale.ROOT)
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
            ?: suppliedType.takeIf { it.isNotEmpty() && it != "*/*" }
            ?: "application/octet-stream"
    }

    fun writeDocumentToUri(context: Context, destination: Uri, bytes: ByteArray): Boolean {
        return try {
            val output = context.contentResolver.openOutputStream(destination, "wt")
                ?: throw java.io.IOException("Destination could not be opened")
            output.use { stream ->
                stream.write(bytes)
                stream.flush()
            }
            true
        } catch (_: Exception) {
            runCatching { context.contentResolver.delete(destination, null, null) }
            false
        }
    }

    fun prepareShareDocument(context: Context, document: Document, bytes: ByteArray): Uri? {
        return try {
            cleanupStaleSharedFiles(context)
            val sharedRoot = File(context.cacheDir, "shared-documents")
            val shareDirectory = File(sharedRoot, UUID.randomUUID().toString())
            if (!shareDirectory.mkdirs()) throw java.io.IOException("Could not create private share cache")

            val safeName = safeDocumentFileName(document)
            val sharedFile = File(shareDirectory, safeName)
            sharedFile.outputStream().buffered().use { it.write(bytes) }
            getDocumentUri(context, sharedFile)
        } catch (_: Exception) {
            null
        }
    }

    fun launchShareDocument(context: Context, document: Document, uri: Uri): Boolean {
        return try {
            val safeName = safeDocumentFileName(document)
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = documentMimeType(document)
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newUri(context.contentResolver, safeName, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val chooser = Intent.createChooser(sendIntent, "مشاركة المستند").apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun cleanupStaleSharedFiles(context: Context) {
        val sharedRoot = File(context.cacheDir, "shared-documents")
        val expirationMillis = 24L * 60L * 60L * 1000L
        val now = System.currentTimeMillis()
        sharedRoot.listFiles()?.forEach { shareDirectory ->
            if (now - shareDirectory.lastModified() > expirationMillis) {
                runCatching { shareDirectory.deleteRecursively() }
            }
        }
    }

    fun getDocumentUri(context: Context, file: File): Uri {
        val authority = "${context.packageName}.fileprovider"
        return FileProvider.getUriForFile(context, authority, file)
    }

    fun openDocument(context: Context, document: Document, bytes: ByteArray) {
        try {
            val file = saveDocumentToCache(context, document, bytes)
            val uri = getDocumentUri(context, file)

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, documentMimeType(document))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            val chooser = Intent.createChooser(intent, "فتح المستند").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
        } catch (_: Exception) {
            Toast.makeText(
                context,
                "تعذر فتح المستند. قد لا يتوفر تطبيق مناسب لعرض هذا النوع من الملفات.",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    fun printDocument(context: Context, document: Document, bytes: ByteArray) {
        try {
            val file = saveDocumentToCache(context, document, bytes)
            val isPdf = document.mimeType.contains("pdf", ignoreCase = true) ||
                    document.originalFilename.endsWith(".pdf", ignoreCase = true)
            val isImage = document.mimeType.startsWith("image/", ignoreCase = true) ||
                    listOf(".png", ".jpg", ".jpeg", ".webp").any { document.originalFilename.endsWith(it, ignoreCase = true) }

            val printManager = context.getSystemService(Context.PRINT_SERVICE) as? PrintManager
            if (printManager == null) {
                Toast.makeText(context, "خدمة الطباعة غير متوفرة على هذا الجهاز", Toast.LENGTH_LONG).show()
                return
            }

            if (isPdf) {
                val printAdapter = object : PrintDocumentAdapter() {
                    override fun onLayout(
                        oldAttributes: PrintAttributes?,
                        newAttributes: PrintAttributes?,
                        cancellationSignal: CancellationSignal?,
                        callback: LayoutResultCallback?,
                        extras: Bundle?
                    ) {
                        if (cancellationSignal?.isCanceled == true) {
                            callback?.onLayoutCancelled()
                            return
                        }
                        val info = PrintDocumentInfo.Builder(document.displayName)
                            .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                            .build()
                        callback?.onLayoutFinished(info, newAttributes != oldAttributes)
                    }

                    override fun onWrite(
                        pages: Array<out PageRange>?,
                        destination: ParcelFileDescriptor?,
                        cancellationSignal: CancellationSignal?,
                        callback: WriteResultCallback?
                    ) {
                        try {
                            FileInputStream(file).use { input ->
                                FileOutputStream(destination?.fileDescriptor).use { output ->
                                    input.copyTo(output)
                                }
                            }
                            callback?.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
                        } catch (_: Exception) {
                            callback?.onWriteFailed("تعذر إتمام طباعة المستند.")
                        }
                    }
                }
                printManager.print("مستند - ${document.displayName}", printAdapter, null)
            } else if (isImage) {
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bitmap != null) {
                    val printAdapter = object : PrintDocumentAdapter() {
                        override fun onLayout(
                            oldAttributes: PrintAttributes?,
                            newAttributes: PrintAttributes?,
                            cancellationSignal: CancellationSignal?,
                            callback: LayoutResultCallback?,
                            extras: Bundle?
                        ) {
                            if (cancellationSignal?.isCanceled == true) {
                                callback?.onLayoutCancelled()
                                return
                            }
                            val info = PrintDocumentInfo.Builder(document.displayName)
                                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                                .setPageCount(1)
                                .build()
                            callback?.onLayoutFinished(info, newAttributes != oldAttributes)
                        }

                        override fun onWrite(
                            pages: Array<out PageRange>?,
                            destination: ParcelFileDescriptor?,
                            cancellationSignal: CancellationSignal?,
                            callback: WriteResultCallback?
                        ) {
                            val pdfDocument = PdfDocument()
                            try {
                                val pageInfo = PdfDocument.PageInfo.Builder(bitmap.width, bitmap.height, 1).create()
                                val page = pdfDocument.startPage(pageInfo)
                                page.canvas.drawBitmap(bitmap, 0f, 0f, null)
                                pdfDocument.finishPage(page)
                                FileOutputStream(destination?.fileDescriptor).use { output ->
                                    pdfDocument.writeTo(output)
                                }
                                callback?.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
                            } catch (_: Exception) {
                                callback?.onWriteFailed("تعذر إتمام طباعة المستند.")
                            } finally {
                                pdfDocument.close()
                            }
                        }
                    }
                    printManager.print("مستند - ${document.displayName}", printAdapter, null)
                } else {
                    Toast.makeText(context, "تعذر معالجة الصورة للطباعة", Toast.LENGTH_LONG).show()
                }
            } else {
                Toast.makeText(
                    context,
                    "لا تدعم هذه الصيغة الطباعة المباشرة. يرجى تحويل المستند إلى PDF للطباعة.",
                    Toast.LENGTH_LONG
                ).show()
            }
        } catch (_: Exception) {
            Toast.makeText(
                context,
                "تعذر بدء طباعة المستند. يرجى المحاولة مرة أخرى.",
                Toast.LENGTH_LONG
            ).show()
        }
    }
}
