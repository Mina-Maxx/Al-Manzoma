export type Role = 'platform' | 'company' | 'employee' | 'none';

export interface UserSession {
  token: string;
  refreshToken?: string;
  user: {
    id: string;
    username: string;
    email?: string;
    fullName?: string;
    role: Role;
    companyId?: string | null;
    mustChangePassword?: boolean;
    isSuperAdmin?: boolean;
  };
}

export interface PlatformOverviewData {
  totalOffices: number;
  activeOffices: number;
  suspendedOffices: number;
  totalUsers: number;
  activeUsers: number;
  totalQuarries: number;
  activeDocs: number;
  trashDocs: number;
  storageUsageBytes: number;
  storageQuotaBytes: number;
  backendHealth: string;
  databaseHealth: string;
  storageHealth: string;
  storageBackend: string;
  telemetry: {
    uploadsCount: number;
    downloadsCount: number;
    deletionsCount: number;
    restorationsCount: number;
    failuresCount: number;
  };
}

export interface Company {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  user_count?: number;
  storage_bytes?: number;
  quota_bytes?: number;
  max_users?: number;
  created_at?: string;
}

export interface UserAccount {
  id: string;
  username: string;
  email: string;
  full_name?: string;
  role: 'platform_admin' | 'company_admin' | 'employee';
  company_id?: string;
  company_name?: string;
  status: 'active' | 'disabled';
  created_at?: string;
  permissions?: {
    can_view: boolean;
    can_upload: boolean;
    can_download: boolean;
    can_delete: boolean;
  };
  hidden_quarries?: string[];
}

export interface Quarry {
  id: string;
  name: string;
  quarry_number?: string;
  quarry_type?: string;
  status: 'active' | 'disabled' | 'inactive';
  document_count?: number;
  created_at?: string;
}

export interface Folder {
  id: string;
  name: string;
  quarry_id: string;
  parent_id?: string | null;
}

export interface DocumentItem {
  id: string;
  title?: string;
  display_name?: string;
  file_name?: string;
  original_filename?: string;
  file_size?: number;
  size_bytes?: number;
  mime_type?: string;
  version: number;
  folder_id?: string | null;
  status: 'active' | 'trash' | string;
  deleted_at?: string | null;
  purge_at?: string | null;
  retention_expires_at?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface EmployeePermission {
  user_id: string;
  quarry_id: string;
  can_view: boolean;
  can_upload: boolean;
  can_download: boolean;
  can_delete: boolean;
}

export interface AppRelease {
  id?: string;
  _id?: string;
  version_code: number;
  version_name: string;
  min_supported_version?: number;
  minimum_supported_version_code?: number;
  apk_url?: string;
  download_url?: string;
  apk_filename?: string;
  file_size_bytes?: number;
  apk_size_bytes?: number;
  sha256_checksum?: string;
  sha256?: string;
  release_notes?: string | null;
  update_policy?: 'optional' | 'mandatory';
  is_mandatory?: boolean;
  update_required?: boolean;
  is_withdrawn?: boolean;
  published_by?: string;
  published_at?: string;
  created_at?: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: string;
  result: 'success' | 'denied' | 'failure' | string;
  actor_id?: string;
  actor_name?: string;
  company_id?: string;
  company_name?: string;
  target_id?: string;
  target_type?: string;
  ip_address?: string;
  metadata?: Record<string, any>;
}

export interface OperationalAlert {
  id: string;
  level: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  timestamp: string;
}

export interface OperationalAlertSnapshot {
  checked_at: string;
  items: OperationalAlert[];
}

export interface PlatformBackupItem {
  _id: string;
  backupId: string;
  type: 'full' | 'scheduled' | 'safety';
  status: 'pending' | 'in_progress' | 'completed' | 'verified' | 'failed' | 'corrupted';
  dbStatus: 'pending' | 'completed' | 'failed';
  storageStatus: 'pending' | 'completed' | 'failed';
  filename: string;
  archiveSizeBytes: number;
  sha256Checksum: string;
  isEncrypted: boolean;
  retentionTier: 'daily' | 'weekly' | 'monthly' | 'locked';
  isSafetyBackup: boolean;
  isRestoreLocked: boolean;
  createdAt: string;
  completedAt?: string;
  verifiedAt?: string;
  durationMs?: number;
  errorMessage?: string;
  manifest?: {
    manifestVersion: string;
    appVersion: string;
    backupId: string;
    type: string;
    createdAt: string;
    completedAt: string;
    database: {
      dumpType: string;
      collectionCounts: Record<string, number>;
      totalCollections: number;
      totalDocuments: number;
    };
    storage: {
      totalObjects: number;
      totalBytes: number;
    };
    checksumSha256: string;
  };
}

export interface PlatformRestoreItem {
  _id: string;
  restoreId: string;
  backupId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  dbStatus: 'pending' | 'completed' | 'failed';
  storageStatus: 'pending' | 'completed' | 'failed';
  referenceVerificationStatus: 'passed' | 'failed' | 'skipped';
  safetyBackupId?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  restoredCollections?: Record<string, number>;
  restoredStorageFilesCount?: number;
  errorMessage?: string;
}

export interface PlatformBackupOverview {
  totalBackups: number;
  verifiedBackups: number;
  lastBackupAt: string | null;
  lastSuccessfulBackup: PlatformBackupItem | null;
  activeRestores: number;
  rpoStatus: 'compliant' | 'warning' | 'critical';
  rpoHoursSinceLastBackup: number | null;
  targetRpoHours: number;
  targetRtoHours: number;
  estimatedRtoMinutes: number;
  config: {
    scheduledIntervalHours: number;
    retentionDaily: number;
    retentionWeekly: number;
    retentionMonthly: number;
    isEncryptionEnabled: boolean;
    autoVerifyOnBackup: boolean;
  };
  recentRestores: PlatformRestoreItem[];
}
