package com.quarryvault.employee.data.scanner

import java.io.File
import java.io.Serializable
import java.util.UUID

enum class ScanFilterMode {
    /**
     * Preserves original camera colors with balanced exposure.
     */
    COLOR,

    /**
     * Grayscale luminance conversion.
     */
    GRAYSCALE,

    /**
     * High-contrast document enhancement optimizing text, stamps, and signatures.
     */
    DOCUMENT_ENHANCED
}

data class ScannedPage(
    val id: String = UUID.randomUUID().toString(),
    val imageFile: File,
    val rotationDegrees: Int = 0,
    val filterMode: ScanFilterMode = ScanFilterMode.COLOR,
    val width: Int = 0,
    val height: Int = 0
) : Serializable
