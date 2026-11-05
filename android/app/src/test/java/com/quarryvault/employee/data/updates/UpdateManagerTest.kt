package com.quarryvault.employee.data.updates

import com.quarryvault.employee.data.api.models.AppUpdateManifest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest

class UpdateManagerTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private val updateManager = UpdateManager()

    @Test
    fun testIsUpdateAvailable() {
        val manifestV2 = AppUpdateManifest(
            versionCode = 2,
            versionName = "1.1.0",
            apkUrl = "http://localhost:8000/app/updates/download/uuid",
            apkSizeBytes = 1024,
            sha256 = "dummy",
            publishedAt = "2026-10-27T16:00:00Z"
        )

        // Version 1 vs Version 2 -> update is available
        assertTrue(updateManager.isUpdateAvailable(manifestV2, currentVersionCode = 1))

        // Version 2 vs Version 2 -> update is NOT available
        assertFalse(updateManager.isUpdateAvailable(manifestV2, currentVersionCode = 2))

        // Version 3 vs Version 2 -> update is NOT available (running newer version)
        assertFalse(updateManager.isUpdateAvailable(manifestV2, currentVersionCode = 3))
    }

    @Test
    fun testVersionComparison_UsesVersionCodeNotStringName() {
        // Version code 10 with string name "1.0.0" vs current version code 9 with string name "2.0.0"
        val manifest = AppUpdateManifest(
            versionCode = 10,
            versionName = "1.0.0-build10",
            apkUrl = "http://localhost:8000/app/updates/download/uuid",
            apkSizeBytes = 1024,
            sha256 = "dummy",
            publishedAt = "2026-10-27T16:00:00Z"
        )

        // Must evaluate by versionCode 10 > 9, ignoring that "1.0.0" < "2.0.0"
        assertTrue(updateManager.isUpdateAvailable(manifest, currentVersionCode = 9))

        // When current version code is 10, no update is available
        assertFalse(updateManager.isUpdateAvailable(manifest, currentVersionCode = 10))

        // When current version code is 11, running newer version
        assertFalse(updateManager.isUpdateAvailable(manifest, currentVersionCode = 11))
    }

    @Test
    fun testIsUpdateRequired() {
        val optionalManifest = AppUpdateManifest(
            versionCode = 5,
            versionName = "1.5.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            apkUrl = "http://localhost:8000/app/updates/download/uuid",
            apkSizeBytes = 1024,
            sha256 = "dummy",
            publishedAt = "2026-10-27T16:00:00Z"
        )

        // Optional update when caller is at or above minimum
        assertFalse(updateManager.isUpdateRequired(optionalManifest, currentVersionCode = 1))
        assertFalse(updateManager.isUpdateRequired(optionalManifest, currentVersionCode = 3))

        // Required update when manifest explicitly flags updateRequired = true
        val explicitRequired = optionalManifest.copy(updateRequired = true)
        assertTrue(updateManager.isUpdateRequired(explicitRequired, currentVersionCode = 3))

        // Required update when caller is below minimumSupportedVersionCode
        val minVersionManifest = optionalManifest.copy(minimumSupportedVersionCode = 4, updateRequired = false)
        assertTrue(updateManager.isUpdateRequired(minVersionManifest, currentVersionCode = 2))
        assertFalse(updateManager.isUpdateRequired(minVersionManifest, currentVersionCode = 4))
    }

    @Test
    fun testIsUpdateRequired_ExplicitOptionalPolicy_NeverForcedByHigherVersionCode() {
        val higherVersionOptionalManifest = AppUpdateManifest(
            versionCode = 100,
            versionName = "10.0.0",
            minimumSupportedVersionCode = 1,
            updateRequired = false,
            updatePolicy = "optional",
            apkUrl = "http://localhost:8000/app/updates/download/uuid",
            apkSizeBytes = 1024,
            sha256 = "dummy",
            publishedAt = "2026-10-30T00:00:00Z"
        )

        // Version code 100 is higher than 50, but policy is optional -> must NOT be required
        assertFalse(updateManager.isUpdateRequired(higherVersionOptionalManifest, currentVersionCode = 50))
        assertFalse(updateManager.isUpdateRequired(higherVersionOptionalManifest, currentVersionCode = 1))
        assertTrue(updateManager.isUpdateAvailable(higherVersionOptionalManifest, currentVersionCode = 50))
    }

    @Test
    fun testIsUpdateRequired_ExplicitMandatoryPolicy_Forced() {
        val mandatoryManifest = AppUpdateManifest(
            versionCode = 10,
            versionName = "2.0.0",
            minimumSupportedVersionCode = 1,
            updateRequired = true,
            updatePolicy = "mandatory",
            apkUrl = "http://localhost:8000/app/updates/download/uuid",
            apkSizeBytes = 1024,
            sha256 = "dummy",
            publishedAt = "2026-10-30T00:00:00Z"
        )

        assertTrue(updateManager.isUpdateRequired(mandatoryManifest, currentVersionCode = 9))
    }

    @Test
    fun testIsUpdateRequired_LegacyRecord_MinSupportedEqualsVersionCode_TreatedAsOptional() {
        // In legacy records where minimumSupportedVersionCode was defaulted to versionCode on an optional update:
        val legacyOptionalManifest = AppUpdateManifest(
            versionCode = 10,
            versionName = "1.0.10",
            minimumSupportedVersionCode = 10,
            updateRequired = false,
            updatePolicy = null, // Missing in legacy
            apkUrl = "http://localhost:8000/app/updates/download/uuid",
            apkSizeBytes = 1024,
            sha256 = "dummy",
            publishedAt = "2026-10-30T00:00:00Z"
        )

        // Since updateRequired is false and updatePolicy is not mandatory, legacy minSupported == versionCode must NOT force update
        assertFalse(updateManager.isUpdateRequired(legacyOptionalManifest, currentVersionCode = 9))
    }

    @Test
    fun testSha256ChecksumCalculationAndVerification() {
        val testFile = tempFolder.newFile("sample_update.apk")
        val content = "QuarryVault Update Binary Payload 2026".toByteArray(Charsets.UTF_8)
        testFile.writeBytes(content)

        // Precompute expected hash
        val expectedSha256 = MessageDigest.getInstance("SHA-256")
            .digest(content)
            .joinToString("") { "%02x".format(it) }

        val computed = updateManager.computeSha256(testFile)
        assertEquals(expectedSha256, computed)

        // Verification matches
        val isValid = updateManager.verifyChecksum(testFile, expectedSha256)
        assertTrue(isValid)
        assertTrue("Valid file must be preserved", testFile.exists())

        // Verification fails with wrong checksum -> file must be deleted for security
        val isCorruptedValid = updateManager.verifyChecksum(testFile, "wrong_hash_0000000000000000000000000000000000000000000000000000000000")
        assertFalse(isCorruptedValid)
        assertFalse("Corrupted file must be deleted", testFile.exists())
    }

    @Test
    fun testVerifyPackage_NonExistentFile_ReturnsFalse() {
        val missingFile = File(tempFolder.root, "non_existent.apk")
        assertFalse(updateManager.verifyPackage(apkFile = missingFile))
    }

    @Test
    fun testVerifyPackage_CorruptOrInvalidArchive_DeletedAndRejected() {
        val corruptApk = tempFolder.newFile("corrupt_app.apk")
        corruptApk.writeBytes("corrupted content not a zip".toByteArray())

        // Without verifier/context, unparseable archive returns false and deletes file
        val result = updateManager.verifyPackage(apkFile = corruptApk)
        assertFalse(result)
        assertFalse("Corrupt APK must be deleted after failed package verification", corruptApk.exists())
    }

    @Test
    fun testVerifyPackage_WrongPackageName_DeletedAndRejected() {
        val foreignApk = tempFolder.newFile("foreign_app.apk")
        foreignApk.writeBytes("mock binary payload".toByteArray())

        // Manager configured with verifier simulating package name mismatch ("com.evil.malware" != "com.quarryvault.employee")
        val managerWithVerifier = UpdateManager(
            expectedPackageName = "com.quarryvault.employee",
            packageVerifier = { _, _ -> false } // Simulates package name mismatch
        )

        val result = managerWithVerifier.verifyPackage(apkFile = foreignApk)
        assertFalse("Wrong package name must be rejected", result)
        assertFalse("Foreign package name must be deleted", foreignApk.exists())
    }

    @Test
    fun testVerifyPackage_SigningCertificateMismatch_DeletedAndRejected() {
        val untrustedApk = tempFolder.newFile("untrusted_cert.apk")
        untrustedApk.writeBytes("mock binary payload".toByteArray())

        // Verifier simulates package name matches but signing certificate does NOT match publisher
        val managerWithVerifier = UpdateManager(
            expectedPackageName = "com.quarryvault.employee",
            packageVerifier = { _, _ -> false } // Publisher certificate rejected
        )

        val result = managerWithVerifier.verifyPackage(apkFile = untrustedApk)
        assertFalse("Untrusted signing certificate must be rejected", result)
        assertFalse("Untrusted APK must be deleted from storage", untrustedApk.exists())
    }

    @Test
    fun testVerifyPackage_AuthenticPackageAndSigningCertificate_Passes() {
        val authenticApk = tempFolder.newFile("authentic_quarryvault.apk")
        authenticApk.writeBytes("signed valid binary payload".toByteArray())

        // Verifier confirms both package name and signing certificate match publisher
        val managerWithVerifier = UpdateManager(
            expectedPackageName = "com.quarryvault.employee",
            packageVerifier = { _, file -> file.exists() } // Publisher certificate validated
        )

        val result = managerWithVerifier.verifyPackage(apkFile = authenticApk)
        assertTrue("Authentic package and signature must pass", result)
        assertTrue("Authentic APK file must be preserved for installation", authenticApk.exists())
    }
}
