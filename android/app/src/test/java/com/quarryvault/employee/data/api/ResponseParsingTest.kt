package com.quarryvault.employee.data.api

import com.quarryvault.employee.data.api.models.ApiErrorResponse
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.HealthResponse
import com.quarryvault.employee.data.api.models.MeResponse
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.AuthTokenResponse
import com.quarryvault.employee.data.api.models.ChangePasswordResponse
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponseParsingTest {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    }

    @Test
    fun parseHealthResponse_success() {
        val payload = """{"status": "ok"}"""
        val response = json.decodeFromString<HealthResponse>(payload)
        assertEquals("ok", response.status)
    }

    @Test
    fun parseMeResponse_fullPayload() {
        val payload = """
            {
                "user": {
                    "id": "11111111-2222-3333-4444-555555555555",
                    "email": "employee@quarry.com",
                    "full_name": "John Doe",
                    "status": "active"
                },
                "company": {
                    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                    "name": "Granite Works Inc.",
                    "status": "active",
                    "quota_bytes": 5368709120,
                    "max_users": 10,
                    "used_bytes": 1048576
                },
                "role": "employee"
            }
        """.trimIndent()

        val response = json.decodeFromString<MeResponse>(payload)
        assertEquals("11111111-2222-3333-4444-555555555555", response.user.id)
        assertEquals("employee@quarry.com", response.user.email)
        assertEquals("John Doe", response.user.fullName)
        assertEquals("active", response.user.status)

        assertEquals("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", response.company.id)
        assertEquals("Granite Works Inc.", response.company.name)
        assertEquals("active", response.company.status)
        assertEquals(5368709120L, response.company.quotaBytes)
        assertEquals(10, response.company.maxUsers)
        assertEquals(1048576L, response.company.usedBytes)

        assertEquals("employee", response.role)
    }

    @Test
    fun parseMeResponse_nullableFields() {
        val payload = """
            {
                "user": {
                    "id": "22222222-3333-4444-5555-666666666666",
                    "email": null,
                    "full_name": null,
                    "status": "active"
                },
                "company": {
                    "id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
                    "name": "Stone Quarry Co",
                    "status": "active",
                    "quota_bytes": 1000,
                    "max_users": 5,
                    "used_bytes": 0
                },
                "role": "company_admin"
            }
        """.trimIndent()

        val response = json.decodeFromString<MeResponse>(payload)
        assertNull(response.user.email)
        assertNull(response.user.fullName)
        assertEquals("company_admin", response.role)
    }

    @Test
    fun parseQuarriesList_success() {
        val payload = """
            [
                {
                    "id": "11111111-1111-1111-1111-111111111111",
                    "name": "North Pit",
                    "status": "active",
                    "permissions": {
                        "can_view": true,
                        "can_upload": true,
                        "can_download": false
                    }
                },
                {
                    "id": "22222222-2222-2222-2222-222222222222",
                    "name": "East Granite Quarry",
                    "status": "active",
                    "permissions": {
                        "can_view": true,
                        "can_upload": false,
                        "can_download": true
                    }
                }
            ]
        """.trimIndent()

        val list = json.decodeFromString<List<Quarry>>(payload)
        assertEquals(2, list.size)
        assertEquals("North Pit", list[0].name)
        assertTrue(list[0].permissions.canView)
        assertTrue(list[0].permissions.canUpload)
        assertEquals(false, list[0].permissions.canDownload)

        assertEquals("East Granite Quarry", list[1].name)
        assertTrue(list[1].permissions.canDownload)
    }

    @Test
    fun parseFoldersList_success() {
        val payload = """
            [
                {
                    "id": "ffffffff-1111-2222-3333-444444444444",
                    "quarry_id": "11111111-1111-1111-1111-111111111111",
                    "parent_id": null,
                    "name": "Safety Plans",
                    "version": 1,
                    "created_at": "2026-10-25T10:00:00Z",
                    "updated_at": "2026-10-25T10:00:00Z"
                }
            ]
        """.trimIndent()

        val folders = json.decodeFromString<List<Folder>>(payload)
        assertEquals(1, folders.size)
        assertEquals("Safety Plans", folders[0].name)
        assertNull(folders[0].parentId)
    }

    @Test
    fun parseDocumentsList_success() {
        val payload = """
            [
                {
                    "id": "dddddddd-1111-2222-3333-444444444444",
                    "quarry_id": "11111111-1111-1111-1111-111111111111",
                    "folder_id": "ffffffff-1111-2222-3333-444444444444",
                    "display_name": "Annual Geological Report 2026",
                    "original_filename": "geo_report_2026.pdf",
                    "mime_type": "application/pdf",
                    "size_bytes": 2048576,
                    "sha256": "abcdef1234567890",
                    "status": "available",
                    "uploaded_by": "11111111-2222-3333-4444-555555555555",
                    "version": 1,
                    "created_at": "2026-10-25T11:30:00Z"
                }
            ]
        """.trimIndent()

        val docs = json.decodeFromString<List<Document>>(payload)
        assertEquals(1, docs.size)
        assertEquals("Annual Geological Report 2026", docs[0].displayName)
        assertEquals("geo_report_2026.pdf", docs[0].originalFilename)
        assertEquals("application/pdf", docs[0].mimeType)
        assertEquals(2048576L, docs[0].sizeBytes)
        assertEquals("available", docs[0].status)
    }

    @Test
    fun parseApiErrorResponse_detailAndCode() {
        val payload = """
            {
                "detail": "Invalid or expired JWT token",
                "code": "invalid_token"
            }
        """.trimIndent()

        val response = json.decodeFromString<ApiErrorResponse>(payload)
        assertEquals("Invalid or expired JWT token", response.detail)
        assertEquals("invalid_token", response.code)
    }

    @Test
    fun parseAuthTokenResponse_success() {
        val payload = """
            {
                "access_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.dummy_payload.dummy_signature",
                "token_type": "bearer",
                "expires_in": 3600,
                "refresh_token": "refresh-token-xyz-123",
                "session_id": "sess-uuid-456",
                "user": {
                    "id": "33333333-4444-5555-6666-777777777777",
                    "email": "employee@quarryvault.com",
                    "username": "e2e_emp",
                    "full_name": "E2E Employee",
                    "status": "active",
                    "must_change_password": false
                }
            }
        """.trimIndent()

        val response = json.decodeFromString<AuthTokenResponse>(payload)
        assertEquals("eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.dummy_payload.dummy_signature", response.accessToken)
        assertEquals("bearer", response.tokenType)
        assertEquals(3600L, response.expiresIn)
        assertEquals("refresh-token-xyz-123", response.refreshToken)
        assertEquals("sess-uuid-456", response.sessionId)
        assertEquals("33333333-4444-5555-6666-777777777777", response.user.id)
        assertEquals("employee@quarryvault.com", response.user.email)
        assertEquals("e2e_emp", response.user.username)
        assertEquals("active", response.user.status)
        assertEquals(false, response.user.mustChangePassword)
    }

    @Test
    fun parseCreateQuarryResponse_success() {
        val payload = """
            {
                "id": "33333333-3333-3333-3333-333333333333",
                "name": "محجر الجرانيت الأحمر",
                "status": "active",
                "permissions": {
                    "can_view": true,
                    "can_upload": false,
                    "can_download": false
                }
            }
        """.trimIndent()

        val quarry = json.decodeFromString<Quarry>(payload)
        assertEquals("33333333-3333-3333-3333-333333333333", quarry.id)
        assertEquals("محجر الجرانيت الأحمر", quarry.name)
        assertEquals("active", quarry.status)
        assertTrue(quarry.permissions.canView)
        assertEquals(false, quarry.permissions.canUpload)
        assertEquals(false, quarry.permissions.canDownload)
    }

    @Test
    fun parseChangePasswordResponse_rotatedSessionTokens() {
        val payload = """{"status":"ok","access_token":"access-rotated","refresh_token":"refresh-rotated","session_id":"session-rotated"}"""
        val response = json.decodeFromString<ChangePasswordResponse>(payload)

        assertEquals("access-rotated", response.accessToken)
        assertEquals("refresh-rotated", response.refreshToken)
        assertEquals("session-rotated", response.sessionId)
    }

    @Test
    fun serializeCreateQuarryRequest_success() {
        val req = com.quarryvault.employee.data.api.models.CreateQuarryRequest(name = "محجر سيناء للرخام")
        val jsonStr = json.encodeToString(com.quarryvault.employee.data.api.models.CreateQuarryRequest.serializer(), req)
        assertTrue(jsonStr.contains("محجر سيناء للرخام"))
    }
}
