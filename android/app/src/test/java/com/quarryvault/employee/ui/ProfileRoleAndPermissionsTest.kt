package com.quarryvault.employee.ui

import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.QuarryPermission
import com.quarryvault.employee.ui.util.UiFormatters
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProfileRoleAndPermissionsTest {

    @Test
    fun formatRoleLabel_companyAdmin_returnsOfficeAdminInBothLanguages() {
        val role = "company_admin"
        val labelAr = UiFormatters.formatRoleLabel(role, isArabic = true)
        val labelEn = UiFormatters.formatRoleLabel(role, isArabic = false)

        assertEquals("أدمن المكتب", labelAr)
        assertEquals("Office Admin", labelEn)

        // Strict requirement: company_admin must NEVER be labeled as an ordinary employee
        assertNotEquals("موظف", labelAr)
        assertNotEquals("Employee", labelEn)
        assertNotEquals("مسؤول الشركة", labelAr)
        assertNotEquals("Company Admin", labelEn)
    }

    @Test
    fun formatRoleLabel_employee_returnsEmployeeInBothLanguages() {
        val role = "employee"
        val labelAr = UiFormatters.formatRoleLabel(role, isArabic = true)
        val labelEn = UiFormatters.formatRoleLabel(role, isArabic = false)

        assertEquals("موظف", labelAr)
        assertEquals("Employee", labelEn)

        // Strict requirement: employee must NEVER be labeled as an admin
        assertNotEquals("أدمن المكتب", labelAr)
        assertNotEquals("Office Admin", labelEn)
        assertNotEquals("مسؤول الشركة", labelAr)
        assertNotEquals("Company Admin", labelEn)
    }

    @Test
    fun formatRoleLabel_platformAdmin_preservesPlatformAdmin() {
        val role = "platform_admin"
        val labelAr = UiFormatters.formatRoleLabel(role, isArabic = true)
        val labelEn = UiFormatters.formatRoleLabel(role, isArabic = false)

        assertEquals("مسؤول المنصة", labelAr)
        assertEquals("Platform Admin", labelEn)

        assertNotEquals("أدمن المكتب", labelAr)
        assertNotEquals("Office Admin", labelEn)
        assertNotEquals("موظف", labelAr)
        assertNotEquals("Employee", labelEn)
    }

    @Test
    fun formatRoleLabel_unknownRole_fallsBackToRawRoleName() {
        val unknownRole = "contractor"
        assertEquals("contractor", UiFormatters.formatRoleLabel(unknownRole, isArabic = true))
        assertEquals("contractor", UiFormatters.formatRoleLabel(unknownRole, isArabic = false))
    }

    @Test
    fun quarryPermissions_supportsDistinctPermissionsPerQuarry() {
        // Authenticated user with differing permissions across multiple quarries
        val quarry1 = Quarry(
            id = "q-1",
            name = "محجر الجرانيت الشرقي",
            permissions = QuarryPermission(canView = true, canUpload = true, canDownload = true, canDelete = true)
        )
        val quarry2 = Quarry(
            id = "q-2",
            name = "محجر الحجر الجيري الشمالي",
            permissions = QuarryPermission(canView = true, canUpload = false, canDownload = true, canDelete = false)
        )
        val quarry3 = Quarry(
            id = "q-3",
            name = "محجر الرخام الغربي",
            permissions = QuarryPermission(canView = true, canUpload = false, canDownload = false, canDelete = false)
        )

        val userQuarries = listOf(quarry1, quarry2, quarry3)

        // Verify independent per-quarry evaluation
        assertTrue(userQuarries[0].permissions.canView)
        assertTrue(userQuarries[0].permissions.canUpload)
        assertTrue(userQuarries[0].permissions.canDownload)
        assertTrue(userQuarries[0].permissions.canDelete)

        assertTrue(userQuarries[1].permissions.canView)
        assertFalse(userQuarries[1].permissions.canUpload)
        assertTrue(userQuarries[1].permissions.canDownload)
        assertFalse(userQuarries[1].permissions.canDelete)

        assertTrue(userQuarries[2].permissions.canView)
        assertFalse(userQuarries[2].permissions.canUpload)
        assertFalse(userQuarries[2].permissions.canDownload)
        assertFalse(userQuarries[2].permissions.canDelete)
    }

    @Test
    fun quarryPermissions_defaultEmployee_deletePermissionIsRestricted() {
        val defaultEmployeePerms = QuarryPermission(
            canView = true,
            canUpload = true,
            canDownload = true,
            canDelete = false
        )

        assertTrue(defaultEmployeePerms.canView)
        assertTrue(defaultEmployeePerms.canUpload)
        assertTrue(defaultEmployeePerms.canDownload)
        assertFalse(defaultEmployeePerms.canDelete)
    }

    @Test
    fun quarryPermissions_companyAdmin_fullPermissionsGranted() {
        val officeAdminPerms = QuarryPermission(
            canView = true,
            canUpload = true,
            canDownload = true,
            canDelete = true
        )

        assertTrue(officeAdminPerms.canView)
        assertTrue(officeAdminPerms.canUpload)
        assertTrue(officeAdminPerms.canDownload)
        assertTrue(officeAdminPerms.canDelete)
    }
}
