package com.quarryvault.employee.scanner

import com.quarryvault.employee.data.scanner.DocumentCorners
import com.quarryvault.employee.data.scanner.ScanPoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DocumentCornersTest {

    @Test
    fun testDefaultCorners_hasExpectedInsets() {
        val corners = DocumentCorners.defaultCorners(0.05f)
        assertEquals(0.05f, corners.topLeft.x, 0.001f)
        assertEquals(0.05f, corners.topLeft.y, 0.001f)
        assertEquals(0.95f, corners.topRight.x, 0.001f)
        assertEquals(0.05f, corners.topRight.y, 0.001f)
        assertEquals(0.95f, corners.bottomRight.x, 0.001f)
        assertEquals(0.95f, corners.bottomRight.y, 0.001f)
        assertEquals(0.05f, corners.bottomLeft.x, 0.001f)
        assertEquals(0.95f, corners.bottomLeft.y, 0.001f)
    }

    @Test
    fun testToFloatArray_scalesPixelCoordinatesAccurately() {
        val corners = DocumentCorners(
            topLeft = ScanPoint(0.1f, 0.2f),
            topRight = ScanPoint(0.9f, 0.2f),
            bottomRight = ScanPoint(0.85f, 0.8f),
            bottomLeft = ScanPoint(0.15f, 0.8f)
        )
        val arr = corners.toFloatArray(1000f, 2000f)
        assertEquals(8, arr.size)
        // topLeft
        assertEquals(100f, arr[0], 0.01f)
        assertEquals(400f, arr[1], 0.01f)
        // topRight
        assertEquals(900f, arr[2], 0.01f)
        assertEquals(400f, arr[3], 0.01f)
        // bottomRight
        assertEquals(850f, arr[4], 0.01f)
        assertEquals(1600f, arr[5], 0.01f)
        // bottomLeft
        assertEquals(150f, arr[6], 0.01f)
        assertEquals(1600f, arr[7], 0.01f)
    }

    @Test
    fun testNormalizedArea_calculatesAccurateShoelaceArea() {
        // Rectangle from 0.1 to 0.9 in X (width = 0.8), 0.1 to 0.9 in Y (height = 0.8)
        // Expected area = 0.8 * 0.8 = 0.64
        val corners = DocumentCorners(
            topLeft = ScanPoint(0.1f, 0.1f),
            topRight = ScanPoint(0.9f, 0.1f),
            bottomRight = ScanPoint(0.9f, 0.9f),
            bottomLeft = ScanPoint(0.1f, 0.9f)
        )
        assertEquals(0.64f, corners.normalizedArea(), 0.001f)
    }

    @Test
    fun testIsConvex_convexAndNonConvexPolygons() {
        // Regular convex rectangle
        val convexRect = DocumentCorners(
            topLeft = ScanPoint(0.1f, 0.1f),
            topRight = ScanPoint(0.9f, 0.1f),
            bottomRight = ScanPoint(0.9f, 0.9f),
            bottomLeft = ScanPoint(0.1f, 0.9f)
        )
        assertTrue(convexRect.isConvex())

        // Perspective-distorted trapezoid (still strictly convex)
        val trapezoid = DocumentCorners(
            topLeft = ScanPoint(0.2f, 0.2f),
            topRight = ScanPoint(0.8f, 0.25f),
            bottomRight = ScanPoint(0.85f, 0.85f),
            bottomLeft = ScanPoint(0.15f, 0.8f)
        )
        assertTrue(trapezoid.isConvex())

        // Concave quad (dart shape: bottom-right corner pushed inwards toward center)
        val concaveQuad = DocumentCorners(
            topLeft = ScanPoint(0.1f, 0.1f),
            topRight = ScanPoint(0.9f, 0.1f),
            bottomRight = ScanPoint(0.5f, 0.4f), // folded inwards
            bottomLeft = ScanPoint(0.1f, 0.9f)
        )
        assertFalse(concaveQuad.isConvex())

        // Self-intersecting / bow-tie quad (topRight and bottomRight swapped)
        val bowTie = DocumentCorners(
            topLeft = ScanPoint(0.1f, 0.1f),
            topRight = ScanPoint(0.9f, 0.9f), // crossed
            bottomRight = ScanPoint(0.9f, 0.1f),
            bottomLeft = ScanPoint(0.1f, 0.9f)
        )
        assertFalse(bowTie.isConvex())
    }

    @Test
    fun testIsAcceptableQuad_validatesReasonableDimensionsAndArea() {
        val validDoc = DocumentCorners.defaultCorners(0.05f)
        assertTrue(validDoc.isAcceptableQuad())

        // Extremely small quad (collapsed)
        val tinyQuad = DocumentCorners(
            topLeft = ScanPoint(0.1f, 0.1f),
            topRight = ScanPoint(0.12f, 0.1f),
            bottomRight = ScanPoint(0.12f, 0.12f),
            bottomLeft = ScanPoint(0.1f, 0.12f)
        )
        assertFalse(tinyQuad.isAcceptableQuad(minAreaThreshold = 0.08f))

        // Degenerate width (collapsed horizontally)
        val thinQuad = DocumentCorners(
            topLeft = ScanPoint(0.5f, 0.1f),
            topRight = ScanPoint(0.51f, 0.1f),
            bottomRight = ScanPoint(0.51f, 0.9f),
            bottomLeft = ScanPoint(0.5f, 0.9f)
        )
        assertFalse(thinQuad.isAcceptableQuad())
    }

    @Test
    fun testScanPoint_distanceAndAbsoluteCoordinates() {
        val p1 = ScanPoint(0f, 0f)
        val p2 = ScanPoint(0.3f, 0.4f)
        // 3-4-5 triangle -> distance = 0.5
        assertEquals(0.5f, p1.distanceTo(p2), 0.001f)

        val abs = p2.toAbsolute(1920f, 1080f)
        assertEquals(576f, abs.first, 0.01f)
        assertEquals(432f, abs.second, 0.01f)
    }
}
