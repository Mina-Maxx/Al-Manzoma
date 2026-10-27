package com.quarryvault.employee.data.scanner

import java.io.Serializable
import kotlin.math.abs

/**
 * Normalized 2D point with coordinates in the range [0.0, 1.0].
 */
data class ScanPoint(
    val x: Float,
    val y: Float
) : Serializable {
    fun toAbsolute(width: Float, height: Float): Pair<Float, Float> =
        Pair(x * width, y * height)

    fun distanceTo(other: ScanPoint): Float {
        val dx = x - other.x
        val dy = y - other.y
        return kotlin.math.sqrt(dx * dx + dy * dy)
    }
}

/**
 * The four normalized corner points of a detected or manually adjusted document.
 * Coordinates are clockwise: Top-Left, Top-Right, Bottom-Right, Bottom-Left.
 */
data class DocumentCorners(
    val topLeft: ScanPoint,
    val topRight: ScanPoint,
    val bottomRight: ScanPoint,
    val bottomLeft: ScanPoint
) : Serializable {

    companion object {
        /**
         * Safe default quadrilateral inset from the image borders.
         */
        fun defaultCorners(insetPercent: Float = 0.05f): DocumentCorners {
            val p = insetPercent.coerceIn(0.01f, 0.25f)
            return DocumentCorners(
                topLeft = ScanPoint(p, p),
                topRight = ScanPoint(1f - p, p),
                bottomRight = ScanPoint(1f - p, 1f - p),
                bottomLeft = ScanPoint(p, 1f - p)
            )
        }
    }

    /**
     * Converts normalized corners to an 8-element float array of pixel points:
     * [x0, y0, x1, y1, x2, y2, x3, y3]
     */
    fun toFloatArray(width: Float, height: Float): FloatArray {
        return floatArrayOf(
            topLeft.x * width, topLeft.y * height,
            topRight.x * width, topRight.y * height,
            bottomRight.x * width, bottomRight.y * height,
            bottomLeft.x * width, bottomLeft.y * height
        )
    }

    /**
     * Validates whether the 4 points form a strictly convex quadrilateral.
     * Uses 2D cross-product signs on successive edge vectors.
     */
    fun isConvex(): Boolean {
        val pts = listOf(topLeft, topRight, bottomRight, bottomLeft)
        var positive = false
        var negative = false

        for (i in 0 until 4) {
            val p1 = pts[i]
            val p2 = pts[(i + 1) % 4]
            val p3 = pts[(i + 2) % 4]

            val cross = (p2.x - p1.x) * (p3.y - p2.y) - (p2.y - p1.y) * (p3.x - p2.x)
            if (cross > 1e-5f) positive = true
            if (cross < -1e-5f) negative = true

            if (positive && negative) return false
        }
        return positive || negative
    }

    /**
     * Calculates the normalized polygon area using the Shoelace formula.
     * Value ranges from 0.0 to 1.0.
     */
    fun normalizedArea(): Float {
        val pts = listOf(topLeft, topRight, bottomRight, bottomLeft)
        var sum = 0f
        for (i in 0 until 4) {
            val current = pts[i]
            val next = pts[(i + 1) % 4]
            sum += (current.x * next.y) - (next.x * current.y)
        }
        return abs(sum) * 0.5f
    }

    /**
     * Checks if the corners are geometrically reasonable for a scanned document.
     */
    fun isAcceptableQuad(minAreaThreshold: Float = 0.08f): Boolean {
        if (!isConvex()) return false
        val area = normalizedArea()
        if (area < minAreaThreshold || area > 0.99f) return false

        // Check reasonable edge lengths
        val topWidth = topLeft.distanceTo(topRight)
        val bottomWidth = bottomLeft.distanceTo(bottomRight)
        val leftHeight = topLeft.distanceTo(bottomLeft)
        val rightHeight = topRight.distanceTo(bottomRight)

        val minDimension = 0.15f
        return topWidth >= minDimension && bottomWidth >= minDimension &&
                leftHeight >= minDimension && rightHeight >= minDimension
    }
}
