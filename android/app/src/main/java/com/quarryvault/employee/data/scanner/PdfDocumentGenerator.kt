package com.quarryvault.employee.data.scanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.pdf.PdfDocument
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException

object PdfDocumentGenerator {

    // Standard A4 dimensions in typographic points (72 points per inch)
    const val A4_WIDTH_POINTS = 595
    const val A4_HEIGHT_POINTS = 842

    /**
     * Generates a single multipage PDF file from the ordered list of ScannedPage.
     * Pages are loaded one-by-one from disk and recycled immediately to avoid OOM.
     */
    suspend fun generatePdf(
        pages: List<ScannedPage>,
        outputFile: File
    ): Result<File> = withContext(Dispatchers.IO) {
        if (pages.isEmpty()) {
            return@withContext Result.failure(IllegalArgumentException("Cannot generate PDF from empty page list"))
        }

        val pdfDocument = PdfDocument()
        val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG)

        try {
            for ((index, page) in pages.withIndex()) {
                if (!page.imageFile.exists() || page.imageFile.length() == 0L) {
                    return@withContext Result.failure(
                        IOException("Page image file missing or empty: ${page.imageFile.name}")
                    )
                }

                // Decode bounds first to check aspect ratio
                val options = BitmapFactory.Options().apply {
                    inJustDecodeBounds = true
                }
                BitmapFactory.decodeFile(page.imageFile.absolutePath, options)
                val rawW = options.outWidth
                val rawH = options.outHeight

                if (rawW <= 0 || rawH <= 0) {
                    return@withContext Result.failure(IOException("Corrupted image for page ${index + 1}"))
                }

                // Subsample large bitmaps if needed to keep memory under ~15MB per page
                var inSampleSize = 1
                val maxDim = 2500
                while ((rawW / inSampleSize) > maxDim || (rawH / inSampleSize) > maxDim) {
                    inSampleSize *= 2
                }

                val decodeOptions = BitmapFactory.Options().apply {
                    this.inSampleSize = inSampleSize
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                }

                var loadedBitmap: Bitmap? = BitmapFactory.decodeFile(page.imageFile.absolutePath, decodeOptions)
                    ?: return@withContext Result.failure(IOException("Failed to decode page ${index + 1}"))

                try {
                    // If page has unapplied rotation, apply it
                    if (page.rotationDegrees % 360 != 0) {
                        val rotated = ImageProcessor.rotateBitmap(loadedBitmap!!, page.rotationDegrees)
                        if (rotated != loadedBitmap) {
                            loadedBitmap.recycle()
                            loadedBitmap = rotated
                        }
                    }

                    val bmWidth = loadedBitmap!!.width.toFloat()
                    val bmHeight = loadedBitmap.height.toFloat()

                    // Match page orientation to image orientation
                    val isLandscape = bmWidth > bmHeight
                    val pageWidth = if (isLandscape) A4_HEIGHT_POINTS else A4_WIDTH_POINTS
                    val pageHeight = if (isLandscape) A4_WIDTH_POINTS else A4_HEIGHT_POINTS

                    val pageInfo = PdfDocument.PageInfo.Builder(pageWidth, pageHeight, index + 1).create()
                    val pdfPage = pdfDocument.startPage(pageInfo)
                    val canvas = pdfPage.canvas

                    // Calculate aspect-fit destination rectangle centered on the page with 18pt margins
                    val margin = 18f
                    val availableWidth = pageWidth - (margin * 2)
                    val availableHeight = pageHeight - (margin * 2)

                    val scale = minOf(availableWidth / bmWidth, availableHeight / bmHeight)
                    val destW = bmWidth * scale
                    val destH = bmHeight * scale
                    val left = (pageWidth - destW) / 2f
                    val top = (pageHeight - destH) / 2f

                    canvas.drawBitmap(loadedBitmap, null, RectF(left, top, left + destW, top + destH), paint)
                    pdfDocument.finishPage(pdfPage)
                } finally {
                    loadedBitmap?.recycle()
                }
            }

            outputFile.parentFile?.mkdirs()
            FileOutputStream(outputFile).use { outStream ->
                pdfDocument.writeTo(outStream)
            }

            // Validate PDF header and size
            if (!outputFile.exists() || outputFile.length() == 0L) {
                return@withContext Result.failure(IOException("Generated PDF file is empty"))
            }

            val isValidPdf = isValidPdfHeader(outputFile)
            if (!isValidPdf) {
                return@withContext Result.failure(IOException("Generated PDF failed magic header verification"))
            }

            Result.success(outputFile)
        } catch (e: Exception) {
            Result.failure(e)
        } finally {
            try {
                pdfDocument.close()
            } catch (_: Exception) {}
        }
    }

    /**
     * Checks whether the first 5 bytes match the PDF magic header `%PDF-`.
     */
    fun isValidPdfHeader(file: File): Boolean {
        if (!file.exists() || file.length() < 5) return false
        try {
            FileInputStream(file).use { input ->
                val header = ByteArray(5)
                val read = input.read(header)
                if (read == 5) {
                    val signature = String(header, Charsets.US_ASCII)
                    return signature == "%PDF-"
                }
            }
        } catch (_: Exception) {
            return false
        }
        return false
    }
}
