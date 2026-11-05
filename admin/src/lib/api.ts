import {
  PlatformOverviewData,
  Company,
  UserAccount,
  Quarry,
  Folder,
  DocumentItem,
  EmployeePermission,
  AppRelease,
  AuditEvent,
  OperationalAlertSnapshot,
  PlatformBackupItem,
  PlatformRestoreItem,
  PlatformBackupOverview,
} from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private static token: string | null = null;
  private static activeCompanyId: string | null = null;

  public static setToken(token: string | null | undefined) {
    if (token && typeof token === 'string' && token.trim()) {
      this.token = token.trim();
      if (typeof window !== 'undefined') {
        localStorage.setItem('qv_token', this.token);
      }
    } else {
      this.token = null;
      if (typeof window !== 'undefined') {
        localStorage.removeItem('qv_token');
      }
    }
  }

  public static getToken(): string | null {
    if (!this.token && typeof window !== 'undefined') {
      this.token = localStorage.getItem('qv_token');
    }
    return this.token;
  }

  public static setActiveCompanyId(id: string | null) {
    this.activeCompanyId = id;
  }

  public static getActiveCompanyId(): string | null {
    return this.activeCompanyId;
  }

  private static async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Client-Application': 'platform_admin_dashboard',
      ...((options.headers as Record<string, string>) || {}),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (this.activeCompanyId) {
      headers['X-Company-Id'] = this.activeCompanyId;
    }

    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      let errorMessage = `HTTP ${res.status}: ${res.statusText}`;
      let errorCode: string | undefined;
      try {
        const errJson = await res.json();
        errorMessage = errJson.message || errJson.error || errorMessage;
        errorCode = typeof errJson.code === 'string' ? errJson.code : undefined;
      } catch {
        // ignore parse error
      }
      throw new ApiError(res.status, errorMessage, errorCode);
    }

    if (res.status === 204) {
      return {} as T;
    }

    return res.json();
  }

  // Auth
  public static async logout(): Promise<void> {
    await this.request('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  public static async login(credentials: { username?: string; email?: string; password: string }): Promise<{
    token: string;
    accessToken: string;
    refreshToken?: string;
    user: {
      id: string;
      username: string;
      email?: string;
      role: string;
      companyId?: string | null;
      mustChangePassword: boolean;
      isSuperAdmin: boolean;
    };
  }> {
    interface RawLoginResponse {
      access_token?: string;
      token?: string;
      refresh_token?: string;
      refreshToken?: string;
      token_type?: string;
      expires_in?: number;
      user: {
        id: string;
        username?: string | null;
        email?: string | null;
        full_name?: string | null;
        role?: string;
        companyId?: string | null;
        company_id?: string | null;
        must_change_password?: boolean;
        mustChangePassword?: boolean;
        is_superadmin?: boolean;
        isSuperAdmin?: boolean;
      };
    }

    const raw = await this.request<RawLoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ...credentials, client_application: 'platform_admin_dashboard' }),
    });

    const token = (raw.access_token || raw.token || '').trim();
    if (!token) {
      throw new Error('Authentication failed: missing access token in response');
    }

    const isSuperAdmin = Boolean(
      raw.user.is_superadmin ?? raw.user.isSuperAdmin ?? (raw.user.role === 'platform_admin')
    );
    const mustChangePassword = Boolean(
      raw.user.must_change_password ?? raw.user.mustChangePassword
    );

    return {
      token,
      accessToken: token,
      refreshToken: raw.refresh_token || raw.refreshToken,
      user: {
        id: raw.user.id,
        username: raw.user.username || '',
        email: raw.user.email || undefined,
        role: isSuperAdmin ? 'platform_admin' : (raw.user.role || 'user'),
        companyId: raw.user.companyId ?? raw.user.company_id ?? null,
        mustChangePassword,
        isSuperAdmin,
      },
    };
  }

  public static async changePassword(payload: { oldPassword?: string; currentPassword?: string; newPassword: string }) {
    return this.request<{ success: boolean; status?: string; detail?: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        new_password: payload.newPassword,
        confirm_password: payload.newPassword,
        current_password: payload.currentPassword || payload.oldPassword,
      }),
    });
  }

  public static async recoverPassword(identifier: string): Promise<{ status: string; detail: string; reset_token?: string }> {
    return this.request<{ status: string; detail: string; reset_token?: string }>('/auth/recover', {
      method: 'POST',
      body: JSON.stringify({ identifier }),
    });
  }

  public static async resetPasswordWithToken(token: string, newPassword: string): Promise<{ status: string; detail: string }> {
    return this.request<{ status: string; detail: string }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        token,
        new_password: newPassword,
        confirm_password: newPassword,
      }),
    });
  }

  public static async getMe(): Promise<{
    id: string;
    username: string;
    email?: string;
    fullName?: string;
    role: string;
    companyId?: string | null;
    companyName?: string | null;
    isSuperAdmin: boolean;
    mustChangePassword: boolean;
  }> {
    interface RawMeResponse {
      id?: string;
      username?: string;
      email?: string;
      fullName?: string;
      role?: string;
      companyId?: string | null;
      companyName?: string | null;
      isSuperAdmin?: boolean;
      mustChangePassword?: boolean;
      user?: {
        id: string;
        username?: string | null;
        email?: string | null;
        full_name?: string | null;
        fullName?: string | null;
        status?: string;
        must_change_password?: boolean;
        mustChangePassword?: boolean;
        role?: string;
        is_superadmin?: boolean;
        isSuperAdmin?: boolean;
      };
      company?: {
        id: string;
        name: string;
        status?: string;
      } | null;
    }

    const raw = await this.request<RawMeResponse>('/me');

    if (raw.user) {
      const isSuperAdmin = Boolean(
        raw.user.is_superadmin ||
        raw.user.isSuperAdmin ||
        raw.role === 'platform_admin' ||
        raw.user.role === 'platform_admin'
      );
      const role = isSuperAdmin ? 'platform_admin' : (raw.role || raw.user.role || 'employee');
      return {
        id: raw.user.id,
        username: raw.user.username || '',
        email: raw.user.email || undefined,
        fullName: raw.user.full_name || raw.user.fullName || undefined,
        role,
        companyId: raw.company ? raw.company.id : null,
        companyName: raw.company ? raw.company.name : null,
        isSuperAdmin,
        mustChangePassword: Boolean(raw.user.must_change_password ?? raw.user.mustChangePassword),
      };
    }

    return {
      id: raw.id || '',
      username: raw.username || '',
      email: raw.email,
      fullName: raw.fullName,
      role: raw.role || 'employee',
      companyId: raw.companyId || null,
      companyName: raw.companyName || null,
      isSuperAdmin: Boolean(raw.isSuperAdmin || raw.role === 'platform_admin'),
      mustChangePassword: Boolean(raw.mustChangePassword),
    };
  }

  // Platform API
  public static async getPlatformOverview(): Promise<PlatformOverviewData> {
    const raw = await this.request<any>('/platform/overview');
    return {
      totalOffices: Number(raw.totalOffices ?? raw.total_offices ?? 0),
      activeOffices: Number(raw.activeOffices ?? raw.active_offices ?? 0),
      suspendedOffices: Number(raw.suspendedOffices ?? raw.suspended_offices ?? 0),
      totalUsers: Number(raw.totalUsers ?? raw.total_users ?? 0),
      activeUsers: Number(raw.activeUsers ?? raw.active_users ?? 0),
      totalQuarries: Number(raw.totalQuarries ?? raw.total_quarries ?? 0),
      activeDocs: Number(raw.activeDocs ?? raw.active_documents ?? 0),
      trashDocs: Number(raw.trashDocs ?? raw.trash_documents ?? 0),
      storageUsageBytes: Number(raw.storageUsageBytes ?? raw.total_used_bytes ?? 0),
      storageQuotaBytes: Number(raw.storageQuotaBytes ?? raw.total_quota_bytes ?? (5 * 1024 * 1024 * 1024)),
      backendHealth: String(raw.backendHealth ?? raw.backend_health ?? 'healthy'),
      databaseHealth: String(raw.databaseHealth ?? raw.database_health ?? 'healthy'),
      storageHealth: String(raw.storageHealth ?? raw.storage_health ?? 'healthy'),
      storageBackend: String(raw.storageBackend ?? raw.storage_backend ?? 'Cloudflare R2 (S3-compatible)'),
      telemetry: {
        uploadsCount: Number(raw.telemetry?.uploadsCount ?? raw.uploads_count ?? 0),
        downloadsCount: Number(raw.telemetry?.downloadsCount ?? raw.downloads_count ?? 0),
        deletionsCount: Number(raw.telemetry?.deletionsCount ?? raw.deletions_count ?? 0),
        restorationsCount: Number(raw.telemetry?.restorationsCount ?? raw.restorations_count ?? 0),
        failuresCount: Number(raw.telemetry?.failuresCount ?? raw.failed_operations_count ?? 0),
      },
    };
  }

  public static async getPlatformCompanies(): Promise<Company[]> {
    return this.request<Company[]>('/platform/companies');
  }

  public static async createCompany(data: { name: string; quota_bytes?: number; max_users?: number }): Promise<Company> {
    return this.request<Company>('/platform/companies', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  public static async updateCompanyStatus(id: string, status: 'active' | 'suspended'): Promise<Company> {
    return this.request<Company>(`/platform/companies/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  public static async deleteCompany(id: string, confirmation: string): Promise<{ id: string; status: string }> {
    return this.request<{ id: string; status: string }>(`/platform/companies/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmation }),
    });
  }

  public static async getPlatformUsers(): Promise<UserAccount[]> {
    return this.request<UserAccount[]>('/platform/users');
  }

  public static async createPlatformUser(data: {
    username: string;
    email: string;
    password: string;
    role: string;
    company_id?: string;
    full_name?: string;
  }): Promise<UserAccount> {
    return this.request<UserAccount>('/platform/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  public static async updatePlatformUser(id: string, data: {
    username?: string;
    email?: string;
    full_name?: string;
    role?: string;
    company_id?: string;
    status?: string;
  }): Promise<UserAccount> {
    return this.request<UserAccount>(`/platform/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  public static async deletePlatformUser(id: string): Promise<{ id: string; status: string; detail?: string }> {
    return this.request<{ id: string; status: string; detail?: string }>(`/platform/users/${id}?permanent=true`, {
      method: 'DELETE',
    });
  }

  public static async resetPlatformUserPassword(id: string, temporaryPassword: string): Promise<{ status: string; detail: string }> {
    return this.request<{ status: string; detail: string }>(`/platform/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ temporary_password: temporaryPassword, confirm_password: temporaryPassword }),
    });
  }

  public static async updateUserRole(id: string, role: string): Promise<UserAccount> {
    return this.request<UserAccount>(`/platform/users/${id}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
  }

  public static async updateUserStatus(id: string, status: 'active' | 'disabled'): Promise<UserAccount> {
    return this.request<UserAccount>(`/platform/users/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  public static async revokeUserSessions(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/platform/users/${id}/revoke-sessions`, {
      method: 'POST',
    });
  }

  public static async getReleases(): Promise<AppRelease[]> {
    return this.request<AppRelease[]>('/platform/releases');
  }

  public static async uploadRelease(formData: FormData): Promise<AppRelease> {
    const token = this.getToken();
    const headers: Record<string, string> = { 'X-Client-Application': 'platform_admin_dashboard' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/platform/releases`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ApiError(res.status, err.message || `Upload failed with status ${res.status}`, err.code);
    }
    return res.json();
  }

  public static async withdrawRelease(releaseId: string): Promise<AppRelease> {
    return this.request<AppRelease>(`/platform/releases/${releaseId}/withdraw`, {
      method: 'POST',
    });
  }

  public static async deleteRelease(releaseId: string): Promise<{ id: string; status: string; detail?: string }> {
    return this.request<{ id: string; status: string; detail?: string }>(`/platform/releases/${releaseId}`, {
      method: 'DELETE',
    });
  }

  public static async updateReleasePolicy(
    releaseId: string,
    policy: 'optional' | 'mandatory',
    minSupportedVersionCode?: number
  ): Promise<AppRelease> {
    return this.request<AppRelease>(`/platform/releases/${releaseId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_policy: policy,
        update_required: policy === 'mandatory',
        is_mandatory: policy === 'mandatory',
        ...(minSupportedVersionCode ? { minimum_supported_version_code: minSupportedVersionCode } : {}),
      }),
    });
  }

  public static async publishRelease(data: Partial<AppRelease>): Promise<AppRelease> {
    return this.request<AppRelease>('/platform/releases', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  public static async getAuditLogs(params?: {
    search?: string;
    result?: string;
    actionGroup?: string;
    companyId?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    items: AuditEvent[];
    total: number;
    page: number;
    pages: number;
    limit: number;
  }> {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
    if (params?.result) query.set('result', params.result);
    if (params?.actionGroup) query.set('action_group', params.actionGroup);
    if (params?.companyId) query.set('company_id', params.companyId);
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    return this.request(`/platform/audit?${query.toString()}`);
  }

  public static async getAlerts(): Promise<OperationalAlertSnapshot> {
    return this.request<OperationalAlertSnapshot>('/platform/alerts');
  }

  // Company API
  public static async getCompanyEmployees(): Promise<UserAccount[]> {
    return this.request<UserAccount[]>('/company/employees');
  }

  public static async createCompanyEmployee(data: {
    username: string;
    email: string;
    password: string;
    fullName?: string;
    permissions?: {
      can_view?: boolean;
      can_upload?: boolean;
      can_download?: boolean;
      can_delete?: boolean;
    };
    hidden_quarries?: string[];
    quarry_permissions?: Array<{
      quarry_id: string;
      can_view: boolean;
      can_upload: boolean;
      can_download: boolean;
      can_delete: boolean;
    }>;
  }): Promise<UserAccount> {
    return this.request<UserAccount>('/company/employees', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  public static async updateCompanyEmployee(id: string, data: {
    username?: string;
    email?: string;
    fullName?: string;
    full_name?: string;
  }): Promise<UserAccount> {
    return this.request<UserAccount>(`/company/employees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  public static async deleteCompanyEmployee(id: string): Promise<{ id: string; status: string; detail?: string }> {
    return this.request<{ id: string; status: string; detail?: string }>(`/company/employees/${id}?permanent=true`, {
      method: 'DELETE',
    });
  }

  public static async getCompanyQuarries(): Promise<Quarry[]> {
    return this.request<Quarry[]>('/company/quarries');
  }

  public static async createCompanyQuarry(data: string | { name: string; quarry_number?: string; quarry_type?: string }): Promise<Quarry> {
    const payload = typeof data === 'string' ? { name: data } : data;
    return this.request<Quarry>('/company/quarries', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public static async updateCompanyQuarry(
    quarryId: string,
    data: { name?: string; quarry_number?: string; quarry_type?: string }
  ): Promise<Quarry> {
    return this.request<Quarry>(`/quarries/${quarryId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  public static async deleteCompanyQuarry(quarryId: string): Promise<void> {
    await this.request<void>(`/quarries/${quarryId}`, {
      method: 'DELETE',
    });
  }

  public static async reactivateCompanyQuarry(quarryId: string): Promise<Quarry> {
    return this.request<Quarry>(`/company/quarries/${quarryId}/reactivate`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  public static async permanentlyDeleteCompanyQuarry(quarryId: string, confirmation: string): Promise<void> {
    await this.request<void>(`/company/quarries/${quarryId}/permanent`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmation }),
    });
  }

  public static async getCompanyPermissions(): Promise<EmployeePermission[]> {
    const res = await this.request<any>('/company/permissions');
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.permissions)) return res.permissions;
    throw new Error('Unexpected permissions response from the server');
  }

  public static async updatePermission(perm: EmployeePermission): Promise<EmployeePermission> {
    return this.request<EmployeePermission>('/company/permissions', {
      method: 'POST',
      body: JSON.stringify(perm),
    });
  }

  public static async getCompanyUsage(): Promise<{ used_bytes: number; quota_bytes: number; percent: number }> {
    return this.request('/company/usage');
  }

  // Quarry Documents & Folders API
  public static async getQuarryFolders(quarryId: string): Promise<Folder[]> {
    return this.request<Folder[]>(`/quarries/${quarryId}/folders`);
  }

  public static async getQuarryDocuments(quarryId: string, folderId?: string | null): Promise<DocumentItem[]> {
    const query = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : '';
    const docs = await this.request<any[]>(`/quarries/${quarryId}/documents${query}`);
    return (docs || []).map((d) => ({
      ...d,
      title: d.title || d.display_name || d.file_name || d.original_filename,
      display_name: d.display_name || d.title,
      file_name: d.file_name || d.original_filename,
      original_filename: d.original_filename || d.file_name,
      file_size: d.file_size !== undefined ? d.file_size : d.size_bytes,
      size_bytes: d.size_bytes !== undefined ? d.size_bytes : d.file_size,
    }));
  }

  public static async uploadDocument(
    quarryId: string,
    file: File,
    folderId?: string | null,
    displayName?: string | null
  ): Promise<DocumentItem> {
    const formData = new FormData();
    formData.append('file', file);
    if (folderId) {
      formData.append('folder_id', folderId);
    }
    if (displayName) {
      formData.append('display_name', displayName);
    }

    const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `ik-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    return this.request<DocumentItem>(`/quarries/${quarryId}/documents`, {
      method: 'POST',
      body: formData,
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
    });
  }

  public static async deleteDocument(quarryId: string, documentId: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/quarries/${quarryId}/documents/${documentId}`, {
      method: 'DELETE',
    });
  }

  public static async renameDocument(
    quarryId: string,
    documentId: string,
    newFilename: string
  ): Promise<DocumentItem> {
    const raw = await this.request<any>(`/quarries/${quarryId}/documents/${documentId}/rename`, {
      method: 'PATCH',
      body: JSON.stringify({ name: newFilename, display_name: newFilename }),
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return {
      ...raw,
      title: raw.title || raw.display_name || raw.file_name || raw.original_filename,
      display_name: raw.display_name || raw.title,
      file_name: raw.file_name || raw.original_filename,
      original_filename: raw.original_filename || raw.file_name,
      file_size: raw.file_size !== undefined ? raw.file_size : raw.size_bytes,
      size_bytes: raw.size_bytes !== undefined ? raw.size_bytes : raw.file_size,
    };
  }

  public static async getQuarryTrash(quarryId: string): Promise<DocumentItem[]> {
    const items = await this.request<any[]>(`/quarries/${quarryId}/trash`);
    return (items || []).map((d) => ({
      ...d,
      title: d.title || d.display_name || d.file_name || d.original_filename,
      display_name: d.display_name || d.title,
      file_name: d.file_name || d.original_filename,
      original_filename: d.original_filename || d.file_name,
      file_size: d.file_size !== undefined ? d.file_size : d.size_bytes,
      size_bytes: d.size_bytes !== undefined ? d.size_bytes : d.file_size,
      purge_at: d.purge_at || d.retention_expires_at,
    }));
  }

  public static async restoreDocument(quarryId: string, documentId: string): Promise<DocumentItem> {
    return this.request<DocumentItem>(`/quarries/${quarryId}/documents/${documentId}/restore`, {
      method: 'POST',
    });
  }

  public static async permanentlyDeleteDocument(quarryId: string, documentId: string): Promise<void> {
    await this.request<void>(`/quarries/${quarryId}/documents/${documentId}/permanent`, {
      method: 'DELETE',
    });
  }

  public static async permanentlyDeleteCompanyTrash(documentId: string): Promise<void> {
    await this.request<void>(`/company/trash/${documentId}/permanent`, {
      method: 'DELETE',
    });
  }

  public static async updateEmployeePermissions(
    employeeId: string,
    permissions: { can_view: boolean; can_upload: boolean; can_download: boolean; can_delete: boolean },
    hidden_quarries?: string[],
    quarry_permissions?: Array<{
      quarry_id: string;
      can_view: boolean;
      can_upload: boolean;
      can_download: boolean;
      can_delete: boolean;
    }>
  ): Promise<any> {
    return this.request<any>('/company/permissions', {
      method: 'POST',
      body: JSON.stringify({
        user_id: employeeId,
        permissions,
        hidden_quarries,
        quarry_permissions,
      }),
    });
  }

  public static async downloadDocument(documentId: string, fallbackFilename?: string): Promise<void> {
    const token = this.getToken();
    const companyId = this.getActiveCompanyId();
    const headers: Record<string, string> = { 'X-Client-Application': 'platform_admin_dashboard' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (companyId) headers['X-Company-Id'] = companyId;

    const response = await fetch(`${API_BASE}/documents/${documentId}/download`, {
      headers,
    });
    if (!response.ok) {
      throw new ApiError(response.status, `Failed to download document: HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fallbackFilename || 'document';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  public static getDownloadUrl(documentId: string): string {
    const token = this.getToken();
    const companyId = this.getActiveCompanyId();
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (companyId) params.set('company_id', companyId);
    const qs = params.toString();
    return `${API_BASE}/documents/${documentId}/download${qs ? `?${qs}` : ''}`;
  }

  // --- Platform Backup & Disaster Recovery ---

  public static async getPlatformBackupOverview(): Promise<PlatformBackupOverview> {
    return this.request<PlatformBackupOverview>('/platform/backups/overview');
  }

  public static async getPlatformBackups(): Promise<PlatformBackupItem[]> {
    return this.request<PlatformBackupItem[]>('/platform/backups');
  }

  public static async createPlatformBackup(options: { isSafetyBackup?: boolean; description?: string } = {}): Promise<PlatformBackupItem> {
    return this.request<PlatformBackupItem>('/platform/backups', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  public static async getPlatformBackupDetails(id: string): Promise<PlatformBackupItem> {
    return this.request<PlatformBackupItem>(`/platform/backups/${id}`);
  }

  public static async verifyPlatformBackup(id: string): Promise<{ status: string; verification: any }> {
    return this.request<{ status: string; verification: any }>(`/platform/backups/${id}/verify`, {
      method: 'POST',
    });
  }

  public static async restorePlatformBackup(
    id: string,
    options: { confirmationPhrase: string; createSafetyBackup?: boolean }
  ): Promise<PlatformRestoreItem> {
    return this.request<PlatformRestoreItem>(`/platform/backups/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  public static async deletePlatformBackup(id: string): Promise<{ status: string; message: string }> {
    return this.request<{ status: string; message: string }>(`/platform/backups/${id}`, {
      method: 'DELETE',
    });
  }

  public static async getBackupScheduleConfig(): Promise<any> {
    return this.request<any>('/platform/backups/config/schedule');
  }

  public static async updateBackupScheduleConfig(cfg: {
    scheduledIntervalHours?: number;
    retentionDaily?: number;
    retentionWeekly?: number;
    retentionMonthly?: number;
    isEncryptionEnabled?: boolean;
    autoVerifyOnBackup?: boolean;
  }): Promise<any> {
    return this.request<any>('/platform/backups/config/schedule', {
      method: 'PUT',
      body: JSON.stringify(cfg),
    });
  }

  public static async runRetentionPolicy(): Promise<any> {
    return this.request<any>('/platform/backups/retention/run', {
      method: 'POST',
    });
  }

  public static async getPlatformRestoreHistory(): Promise<PlatformRestoreItem[]> {
    return this.request<PlatformRestoreItem[]>('/platform/backups/restores/history');
  }

  public static getBackupDownloadUrl(backupId: string): string {
    const token = this.getToken();
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    const qs = params.toString();
    return `${API_BASE}/platform/backups/${backupId}/download${qs ? `?${qs}` : ''}`;
  }

  public static async downloadBackupArchive(backupId: string, filename: string): Promise<void> {
    const token = this.getToken();
    const response = await fetch(`${API_BASE}/platform/backups/${backupId}/download`, {
      headers: {
        'X-Client-Application': 'platform_admin_dashboard',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      throw new ApiError(response.status, `Failed to download backup archive: HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `quarryvault-backup-${backupId}.tar.gz`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }
}
