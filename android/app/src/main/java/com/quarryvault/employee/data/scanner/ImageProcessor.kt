package com.quarryvault.employee.data.scanner

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import java.io.File
import java.io.FileOutputStream
import kotlin.math.hypot
import kotlin.math.max

object ImageProcessor {

    /**
     * Corrects perspective and crops the document based on the 4 corners.
     */
    fun warpPerspective(source: Bitmap, corners: DocumentCorners): Bitmap {
        val srcW = source.width.toFloat()
        val srcH = source.height.toFloat()

        val tl = corners.topLeft.toAbsolute(srcW, srcH)
        val tr = corners.topRight.toAbsolute(srcW, srcH)
        val br = corners.bottomRight.toAbsolute(srcW, srcH)
        val bl = corners.bottomLeft.toAbsolute(srcW, srcH)

        val widthTop = hypot((tr.first - tl.first).toDouble(), (tr.second - tl.second).toDouble()).toFloat()
        val widthBottom = hypot((br.first - bl.first).toDouble(), (br.second - bl.second).toDouble()).toFloat()
        val targetWidth = max(widthTop, widthBottom).toInt().coerceIn(200, 4000)

        val heightLeft = hypot((bl.first - tl.first).toDouble(), (bl.second - tl.second).toDouble()).toFloat()
        val heightRight = hypot((br.first - tr.first).toDouble(), (br.second - tr.second).toDouble()).toFloat()
        val targetHeight = max(heightLeft, heightRight).toInt().coerceIn(200, 4000)

        val srcPoints = floatArrayOf(
            tl.first, tl.second,
            tr.first, tr.second,
            br.first, br.second,
            bl.first, bl.second
        )

        val dstPoints = floatArrayOf(
            0f, 0f,
            targetWidth.toFloat(), 0f,
            targetWidth.toFloat(), targetHeight.toFloat(),
            0f, targetHeight.toFloat()
        )

        val matrix = Matrix()
        matrix.setPolyToPoly(srcPoints, 0, dstPoints, 0, 4)

        val output = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG or Paint.ANTI_ALIAS_FLAG)
        canvas.drawBitmap(source, matrix, paint)
        return output
    }

    /**
     * Applies the selected scan filter mode to the bitmap.
     */
    fun applyFilter(source: Bitmap, mode: ScanFilterMode): Bitmap {
        return when (mode) {
            ScanFilterMode.COLOR -> {
                // Slight contrast normalization to make document text pop
                val output = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(output)
                val paint = Paint(Paint.FILTER_BITMAP_FLAG)
                val cm = ColorMatrix(
                    floatArrayOf(
                        1.05f, 0f, 0f, 0f, 0f,
                        0f, 1.05f, 0f, 0f, 0f,
                        0f, 0f, 1.05f, 0f, 0f,
                        0f, 0f, 0f, 1f, 0f
                    )
                )
                paint.colorFilter = ColorMatrixColorFilter(cm)
                canvas.drawBitmap(source, 0f, 0f, paint)
                output
            }
            ScanFilterMode.GRAYSCALE -> {
                val output = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(output)
                val paint = Paint(Paint.FILTER_BITMAP_FLAG)
                val cm = ColorMatrix().apply { setSaturation(0f) }
                paint.colorFilter = ColorMatrixColorFilter(cm)
                canvas.drawBitmap(source, 0f, 0f, paint)
                output
            }
            ScanFilterMode.DOCUMENT_ENHANCED -> {
                // High contrast document enhancement: whitens paper background while preserving stamps & signatures
                val w = source.width
                val h = source.height
                val output = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                val pixels = IntArray(w * h)
                source.getPixels(pixels, 0, w, 0, 0, w, h)

                // Compute mean luminance
                var totalLum = 0L
                for (pixel in pixels) {
                    val r = (pixel shr 16) and 0xFF
                    val g = (pixel shr 8) and 0xFF
                    val b = pixel and 0xFF
                    totalLum += (299 * r + 587 * g + 114 * b) / 1000
                }
                val meanLum = (totalLum / pixels.size).toInt().coerceIn(80, 200)
                val threshold = (meanLum * 0.90f).toInt()

                for (i in pixels.indices) {
                    val p = pixels[i]
                    val r = (p shr 16) and 0xFF
                    val g = (p shr 8) and 0xFF
                    val b = p and 0xFF
                    val lum = (299 * r + 587 * g + 114 * b) / 1000

                    if (lum > threshold) {
                        // Background paper -> pure white
                        pixels[i] = Color.WHITE
                    } else {
                        // Dark text/ink/stamp -> darken proportionally to retain stamps/color hints
                        val factor = (lum.toFloat() / threshold).coerceIn(0.1f, 0.9f)
                        val nr = (r * factor).toInt().coerceIn(0, 255)
                        val ng = (g * factor).toInt().coerceIn(0, 255)
                        val nb = (b * factor).toInt().coerceIn(0, 255)
                        pixels[i] = (0xFF shl 24) or (nr shl 16) or (ng shl 8) or nb
                    }
                }
                output.setPixels(pixels, 0, w, 0, 0, w, h)
                output
            }
        }
    }

    /**
     * Rotates bitmap by given degrees (0, 90, 180, 270).
     */
    fun rotateBitmap(source: Bitmap, degrees: Int): Bitmap {
        val cleanDegrees = ((degrees % 360) + 360) % 360
        if (cleanDegrees == 0) return source

        val matrix = Matrix().apply { postRotate(cleanDegrees.toFloat()) }
        return Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
    }

    /**
     * Compresses bitmap to a temporary JPEG file.
     */
    fun saveBitmap(bitmap: Bitmap, destination: File, quality: Int = 85): Boolean {
        destination.parentFile?.mkdirs()
        FileOutputStream(destination).use { out ->
            return bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
        }
    }
}
