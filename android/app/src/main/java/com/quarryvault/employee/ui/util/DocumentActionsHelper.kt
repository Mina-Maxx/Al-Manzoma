package com.quarryvault.employee.ui.util

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.widget.Toast
import androidx.core.content.FileProvider
import com.quarryvault.employee.data.api.models.Document
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

object DocumentActionsHelper {

    fun saveDocumentToCache(context: Context, document: Document, bytes: ByteArray): File {
        val docsDir = File(context.cacheDir, "documents").apply { mkdirs() }
        val safeName = document.originalFilename.replace("[^a-zA-Z0-9._-]".toRegex(), "_")
        val file = File(docsDir, safeName)
        file.writeBytes(bytes)
        return file
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
                setDataAndType(uri, document.mimeType.ifBlank { "*/*" })
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            val chooser = Intent.createChooser(intent, "Open ${document.displayName}").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
        } catch (e: Exception) {
            Toast.makeText(
                context,
                "Unable to open file: ${e.localizedMessage ?: "No viewer available"}",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    fun printDocument(context: Context, document: Document, bytes: ByteArray) {
        try {
            val file = saveDocumentToCache(context, document, bytes)
            val isPdf = document.mimeType.contains("pdf", ignoreCase = true) ||
                    document.originalFilename.endsWith(".pdf", ignoreCase = true)

            val printManager = context.getSystemService(Context.PRINT_SERVICE) as? PrintManager
            if (printManager != null && isPdf) {
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
                        } catch (e: Exception) {
                            callback?.onWriteFailed(e.message)
                        }
                    }
                }
                printManager.print("QuarryVault - ${document.displayName}", printAdapter, null)
            } else {
                // Fallback for non-PDF: Open system chooser / view
                openDocument(context, document, bytes)
            }
        } catch (e: Exception) {
            Toast.makeText(
                context,
                "Unable to start print: ${e.localizedMessage ?: "Unknown error"}",
                Toast.LENGTH_LONG
            ).show()
        }
    }
}
