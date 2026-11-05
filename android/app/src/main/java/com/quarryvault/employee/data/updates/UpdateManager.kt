package com.quarryvault.employee.data.updates

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.quarryvault.employee.data.api.models.AppUpdateManifest
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

class UpdateManager(
    val expectedPackageName: String = "com.quarryvault.employee",
    val trustedCertificateHashes: Set<String> = emptySet(),
    private val packageVerifier: ((Context?, File) -> Boolean)? = null
) {

    fun isUpdateAvailable(manifest: AppUpdateManifest, currentVersionCode: Int): Boolean {
        return manifest.versionCode > currentVersionCode
    }

    fun isUpdateRequired(manifest: AppUpdateManifest, currentVersionCode: Int): Boolean {
        val isExplicitMandatory = manifest.updatePolicy?.equals("mandatory", ignoreCase = true) == true || manifest.updateRequired
        // Only enforce minimumSupportedVersionCode if currentVersionCode is strictly below it,
        // and minimumSupportedVersionCode is less than versionCode (or release is explicitly mandatory),
        // preventing unconfigured/legacy records from falsely forcing updates.
        val isMinSupportedViolated = manifest.minimumSupportedVersionCode > 1 &&
                currentVersionCode < manifest.minimumSupportedVersionCode &&
                (isExplicitMandatory || manifest.minimumSupportedVersionCode < manifest.versionCode)
        return isExplicitMandatory || isMinSupportedViolated
    }

    fun computeSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { fis ->
            val buffer = ByteArray(8192)
            var bytesRead: Int
            while (fis.read(buffer).also { bytesRead = it } != -1) {
                digest.update(buffer, 0, bytesRead)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun verifyChecksum(file: File, expectedSha256: String): Boolean {
        if (!file.exists() || !file.isFile) return false
        val computed = computeSha256(file)
        val matches = computed.equals(expectedSha256.trim(), ignoreCase = true)
        if (!matches) {
            file.delete()
        }
        return matches
    }

    fun verifyPackage(context: Context? = null, apkFile: File): Boolean {
        if (!apkFile.exists() || !apkFile.isFile) return false
        try {
            if (packageVerifier != null) {
                val passed = packageVerifier.invoke(context, apkFile)
                if (!passed) {
                    apkFile.delete()
                    return false
                }
                return true
            }

            if (context == null) {
                apkFile.delete()
                return false
            }

            val sigFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageManager.GET_SIGNING_CERTIFICATES
            } else {
                @Suppress("DEPRECATION")
                PackageManager.GET_SIGNATURES
            }

            val apkPkgInfo = context.packageManager.getPackageArchiveInfo(apkFile.absolutePath, sigFlags)
            if (apkPkgInfo == null || apkPkgInfo.packageName != expectedPackageName) {
                apkFile.delete()
                return false
            }

            val isCertValid = verifySigningCertificate(context, apkPkgInfo)
            if (!isCertValid) {
                apkFile.delete()
                return false
            }

            return true
        } catch (_: Exception) {
            apkFile.delete()
            return false
        }
    }

    fun verifySigningCertificate(context: Context, apkPkgInfo: PackageInfo): Boolean {
        val apkSignatures: List<ByteArray> = extractSignatures(apkPkgInfo)
        if (apkSignatures.isEmpty()) return false

        // 1. Verify against installed package signatures
        val installedSignatures: List<ByteArray> = getInstalledSignatures(context)
        if (installedSignatures.isNotEmpty()) {
            val matches = apkSignatures.any { apkSig: ByteArray ->
                installedSignatures.any { instSig: ByteArray -> apkSig.contentEquals(instSig) }
            }
            if (matches) return true
        }

        // 2. On Android P+, verify via PackageManager.hasSigningCertificate
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            for (apkSig in apkSignatures) {
                try {
                    if (context.packageManager.hasSigningCertificate(
                            context.packageName,
                            apkSig,
                            PackageManager.CERT_INPUT_RAW_X509
                        )
                    ) {
                        return true
                    }
                } catch (_: Exception) {
                    // Continue to next check
                }
            }
        }

        // 3. Verify against explicitly trusted certificate hashes (if provided)
        if (trustedCertificateHashes.isNotEmpty()) {
            val digest = MessageDigest.getInstance("SHA-256")
            for (apkSig in apkSignatures) {
                val certSha256 = digest.digest(apkSig).joinToString("") { "%02x".format(it) }
                if (trustedCertificateHashes.any { it.equals(certSha256, ignoreCase = true) }) {
                    return true
                }
            }
        }

        return false
    }

    fun extractSignatures(pkgInfo: PackageInfo?): List<ByteArray> {
        if (pkgInfo == null) return emptyList()
        val results = mutableListOf<ByteArray>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signingInfo = pkgInfo.signingInfo
            if (signingInfo != null) {
                val signers = if (signingInfo.hasMultipleSigners()) {
                    signingInfo.apkContentsSigners
                } else {
                    signingInfo.signingCertificateHistory
                }
                signers?.forEach { sig -> results.add(sig.toByteArray()) }
            }
        }
        if (results.isEmpty()) {
            @Suppress("DEPRECATION")
            pkgInfo.signatures?.forEach { sig -> results.add(sig.toByteArray()) }
        }
        return results
    }

    fun getInstalledSignatures(context: Context): List<ByteArray> {
        val sigFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }
        return try {
            val installedPkgInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(sigFlags.toLong())
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, sigFlags)
            }
            extractSignatures(installedPkgInfo)
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun canInstallPackages(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    fun getManageUnknownSourcesIntent(context: Context): Intent {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}")
            ).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        } else {
            Intent(Settings.ACTION_SECURITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
    }

    fun launchManageUnknownSources(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${context.packageName}")
                    ).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                )
                return
            } catch (_: Exception) {
                try {
                    context.startActivity(
                        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                    )
                    return
                } catch (_: Exception) {}
            }
        }
        try {
            context.startActivity(
                Intent(Settings.ACTION_SECURITY_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
        } catch (_: Exception) {
            context.startActivity(
                Intent(Settings.ACTION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
        }
    }

    fun createInstallIntent(context: Context, apkFile: File): Intent {
        val authority = "${context.packageName}.fileprovider"
        val apkUri: Uri = FileProvider.getUriForFile(context, authority, apkFile)

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
            clipData = android.content.ClipData.newRawUri("quarryvault_apk", apkUri)
        }

        try {
            val resolveInfos = context.packageManager.queryIntentActivities(
                intent,
                PackageManager.MATCH_DEFAULT_ONLY
            )
            for (resolveInfo in resolveInfos) {
                context.grantUriPermission(
                    resolveInfo.activityInfo.packageName,
                    apkUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            }
        } catch (_: Exception) {
            // Permission flags on intent serve as primary fallback
        }

        return intent
    }

    fun getUpdatesDir(context: Context): File {
        val dir = File(context.cacheDir, "updates")
        if (!dir.exists()) {
            dir.mkdirs()
        }
        return dir
    }

    fun cleanOldUpdates(context: Context) {
        try {
            val dir = File(context.cacheDir, "updates")
            if (dir.exists() && dir.isDirectory) {
                dir.listFiles()?.forEach { file ->
                    if (file.isFile && file.name.endsWith(".apk")) {
                        file.delete()
                    }
                }
            }
        } catch (_: Exception) {
            // Ignore cleanup errors
        }
    }
}
