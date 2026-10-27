package com.quarryvault.employee.data.scanner

import android.graphics.Bitmap
import android.graphics.Color
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

object EdgeDetector {

    private const val SAMPLE_MAX_DIMENSION = 360

    /**
     * Detects the document corners from a source Bitmap.
     * Returns null if detection is ambiguous or fails sanity checks,
     * allowing the caller to safely fall back to manual corner adjustment.
     */
    fun detectCorners(bitmap: Bitmap): DocumentCorners? {
        val originalWidth = bitmap.width
        val originalHeight = bitmap.height
        if (originalWidth < 30 || originalHeight < 30) return null

        val scale = min(
            1.0f,
            SAMPLE_MAX_DIMENSION.toFloat() / max(originalWidth, originalHeight).toFloat()
        )
        val sampleW = (originalWidth * scale).toInt().coerceAtLeast(10)
        val sampleH = (originalHeight * scale).toInt().coerceAtLeast(10)

        val scaled = Bitmap.createScaledBitmap(bitmap, sampleW, sampleH, true)

        try {
            val pixels = IntArray(sampleW * sampleH)
            scaled.getPixels(pixels, 0, sampleW, 0, 0, sampleW, sampleH)

            // Convert to grayscale luminance array
            val luminance = FloatArray(sampleW * sampleH)
            var totalLum = 0.0
            for (i in pixels.indices) {
                val p = pixels[i]
                val r = Color.red(p)
                val g = Color.green(p)
                val b = Color.blue(p)
                val lum = 0.299f * r + 0.587f * g + 0.114f * b
                luminance[i] = lum
                totalLum += lum
            }
            val avgLum = (totalLum / pixels.size).toFloat()

            // Calculate gradient / edge map
            val edges = FloatArray(sampleW * sampleH)
            for (y in 1 until sampleH - 1) {
                for (x in 1 until sampleW - 1) {
                    val idx = y * sampleW + x
                    val dx = abs(luminance[idx + 1] - luminance[idx - 1])
                    val dy = abs(luminance[idx + sampleW] - luminance[idx - sampleW])
                    edges[idx] = dx + dy
                }
            }

            // Collect strong edge points away from the sensor margin (3% margin)
            val marginX = (sampleW * 0.03f).toInt().coerceAtLeast(2)
            val marginY = (sampleH * 0.03f).toInt().coerceAtLeast(2)
            val edgeThreshold = 35.0f

            data class EdgePixel(val x: Int, val y: Int, val sum: Int, val diff: Int)

            val edgeList = ArrayList<EdgePixel>(sampleW * sampleH / 8)
            for (y in marginY until sampleH - marginY) {
                for (x in marginX until sampleW - marginX) {
                    val idx = y * sampleW + x
                    if (edges[idx] > edgeThreshold) {
                        edgeList.add(EdgePixel(x, y, x + y, x - y))
                    }
                }
            }

            // Not enough distinct edge points to form a reliable document contour
            if (edgeList.size < 30) {
                return null
            }

            // Find extreme diagonal projections:
            // Top-Left: minimizes (x + y)
            // Top-Right: maximizes (x - y)
            // Bottom-Right: maximizes (x + y)
            // Bottom-Left: minimizes (x - y)
            var bestTl: EdgePixel = edgeList[0]
            var bestTr: EdgePixel = edgeList[0]
            var bestBr: EdgePixel = edgeList[0]
            var bestBl: EdgePixel = edgeList[0]

            for (i in 1 until edgeList.size) {
                val p = edgeList[i]
                if (p.sum < bestTl.sum) bestTl = p
                if (p.diff > bestTr.diff) bestTr = p
                if (p.sum > bestBr.sum) bestBr = p
                if (p.diff < bestBl.diff) bestBl = p
            }

            val detected = DocumentCorners(
                topLeft = ScanPoint(bestTl.x.toFloat() / sampleW, bestTl.y.toFloat() / sampleH),
                topRight = ScanPoint(bestTr.x.toFloat() / sampleW, bestTr.y.toFloat() / sampleH),
                bottomRight = ScanPoint(bestBr.x.toFloat() / sampleW, bestBr.y.toFloat() / sampleH),
                bottomLeft = ScanPoint(bestBl.x.toFloat() / sampleW, bestBl.y.toFloat() / sampleH)
            )

            return if (detected.isAcceptableQuad(minAreaThreshold = 0.12f)) {
                detected
            } else {
                null
            }
        } finally {
            if (scaled != bitmap) {
                scaled.recycle()
            }
        }
    }
}
