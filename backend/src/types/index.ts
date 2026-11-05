export enum CompanyStatus {
  active = 'active',
  suspended = 'suspended',
}

export enum UserStatus {
  active = 'active',
  inactive = 'inactive',
}

export enum MembershipRole {
  company_admin = 'company_admin',
  employee = 'employee',
}

export enum QuarryStatus {
  active = 'active',
  inactive = 'inactive',
}

export enum DocumentStatus {
  pending = 'pending',
  available = 'available',
  failed = 'failed',
}

export enum IdempotencyStatus {
  in_progress = 'in_progress',
  completed = 'completed',
}

export enum AuditResult {
  success = 'success',
  denied = 'denied',
  failure = 'failure',
}

export enum ChangeEntityType {
  folder = 'folder',
  document = 'document',
}

export enum ChangeType {
  created = 'created',
  updated = 'updated',
  deleted = 'deleted',
}

export interface AuthClaims {
  sub: string;
  email?: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
  role?: string;
  client_application?: 'android' | 'platform_admin_dashboard';
  [key: string]: any;
}

export interface UserDocument {
  _id: string; // UUID string
  auth_user_id: string;
  username?: string | null;
  normalized_username?: string | null;
  email?: string | null;
  password_hash?: string | null;
  full_name?: string | null;
  status: UserStatus;
  must_change_password: boolean;
  tokens_revoked_at?: Date | null;
  active_session_id?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyDocument {
  _id: string; // UUID string
  name: string;
  status: CompanyStatus;
  quota_bytes: number;
  max_users: number;
  used_bytes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipDocument {
  _id: string; // UUID string
  user_id: string;
  company_id: string;
  role: MembershipRole;
  can_view?: boolean;
  can_upload?: boolean;
  can_download?: boolean;
  can_delete?: boolean;
  hidden_quarries?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformAdminDocument {
  _id: string; // UUID string
  auth_user_id: string;
  email?: string | null;
  full_name?: string | null;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

export enum SupportGrantScope {
  document_metadata_read = 'document_metadata_read',
  document_download = 'document_download',
}

export enum SupportGrantStatus {
  pending = 'pending',
  active = 'active',
  revoked = 'revoked',
}

export interface SupportGrantDocument {
  _id: string;
  company_id: string;
  requested_by_platform_admin_id: string;
  approved_by_platform_admin_id?: string | null;
  scopes: SupportGrantScope[];
  requested_duration_seconds: number;
  reason: string;
  status: SupportGrantStatus;
  requested_at: Date;
  approved_at?: Date | null;
  expires_at?: Date | null;
  revoked_at?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuarryDocument {
  _id: string; // UUID string
  company_id: string;
  name: string;
  quarry_number?: string | null;
  quarry_type?: string | null;
  status: QuarryStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuarryPermissionDocument {
  _id: string; // UUID string
  user_id: string;
  quarry_id: string;
  can_view: boolean;
  can_upload: boolean;
  can_download: boolean;
  can_delete: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderDocument {
  _id: string; // UUID string
  company_id: string;
  quarry_id: string;
  parent_id?: string | null;
  name: string;
  version: number;
  is_standard?: boolean;
  standard_order?: number | null;
  standard_key?: string | null;
  deleted_at?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StandardFolderDef {
  key: string;
  name: string;
  order: number;
}

export const STANDARD_FOLDERS: readonly StandardFolderDef[] = [
  { key: 'national_id', name: 'بطاقة شخصية', order: 1 },
  { key: 'monthly_records', name: 'شهريات', order: 2 },
  { key: 'operation_card', name: 'كارت تشغيل', order: 3 },
  { key: 'tax_card', name: 'بطاقة ضريبة', order: 4 },
  { key: 'fines_and_monitoring', name: 'غرامات و رصدات', order: 5 },
  { key: 'additional_papers', name: 'أوراق إضافية', order: 6 },
  { key: 'military_security_card', name: 'كارت أمن حربي', order: 7 },
  { key: 'power_of_attorney', name: 'التوكيل', order: 8 },
] as const;

export interface DocumentItem {
  _id: string; // UUID string
  company_id: string;
  quarry_id: string;
  folder_id?: string | null;
  display_name: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256?: string | null;
  storage_ref?: string | null;
  status: DocumentStatus;
  uploaded_by?: string | null;
  version: number;
  deleted_at?: Date | null;
  deleted_by?: string | null;
  purge_attempt: number;
  purge_token?: string | null;
  purge_claimed_at?: Date | null;
  purge_failed_at?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentVersionDocument {
  _id: string;
  document_id: string;
  company_id: string;
  quarry_id: string;
  version: number;
  size_bytes: number;
  sha256: string;
  storage_ref: string;
  mime_type: string;
  uploaded_by?: string | null;
  createdAt: Date;
}

export interface IdempotencyKeyDocument {
  _id: string; // UUID string
  company_id: string;
  user_id: string;
  quarry_id: string;
  key: string;
  content_sha256: string;
  status: IdempotencyStatus;
  document_id?: string | null;
  owner_token?: string | null;
  lease_expires_at?: Date | null;
  failed_at?: Date | null;
  storage_ref?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UploadReconciliationDocument {
  _id: string;
  document_id: string;
  company_id: string;
  quarry_id: string;
  actor_user_id: string;
  idempotency_key_id: string;
  storage_ref: string;
  display_name: string;
  folder_id?: string | null;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  idempotency_status: 'pending' | 'complete';
  sync_status: 'pending' | 'complete';
  audit_status: 'pending' | 'complete';
  attempt_count: number;
  next_attempt_at: Date;
  last_error?: string | null;
  lease_owner?: string | null;
  lease_expires_at?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditEventDocument {
  _id: string; // UUID string
  created_at: Date;
  company_id?: string | null;
  actor_user_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  idempotency_key?: string | null;
  result: AuditResult;
  ip?: string | null;
  user_agent?: string | null;
  meta?: Record<string, any> | null;
}

export interface CompanySyncStateDocument {
  _id?: string;
  company_id: string;
  feed_epoch: string;
  last_seq: number;
  min_valid_seq: number;
  updated_at: Date;
}

export interface ChangeLogDocument {
  _id?: string;
  company_id: string;
  seq: number;
  quarry_id: string;
  entity_type: ChangeEntityType;
  entity_id: string;
  change_type: ChangeType;
  entity_version: number;
  event_key?: string | null;
  payload: Record<string, any>;
  created_at: Date;
}

export type UpdatePolicy = 'optional' | 'mandatory';

export interface AppReleaseDocument {
  _id: string;
  version_code: number;
  version_name: string;
  release_notes?: string | null;
  minimum_supported_version_code: number;
  update_required: boolean;
  update_policy?: UpdatePolicy;
  apk_filename: string;
  apk_size_bytes: number;
  sha256: string;
  storage_ref: string;
  is_withdrawn: boolean;
  published_by?: string | null;
  created_at: Date;
}

export interface AuthContext {
  user: UserDocument;
  company: CompanyDocument;
  membership: MembershipDocument;
  claims: AuthClaims;
  userId: string;
  companyId: string;
  role: MembershipRole | 'platform_admin';
  authUserId?: string;
  platformAdminId?: string;
  supportGrantId?: string;
}

export interface PasswordResetTokenDocument {
  _id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  used_at?: Date | null;
  created_at: Date;
}

export interface PlatformAdminContext {
  admin: PlatformAdminDocument;
  claims: AuthClaims;
  adminId: string;
  authUserId: string;
}

export type BackupType = 'full' | 'scheduled' | 'safety';
export type BackupStatus = 'pending' | 'running' | 'completed' | 'failed' | 'verified';
export type ComponentBackupStatus = 'pending' | 'running' | 'completed' | 'failed';
export type RetentionTier = 'daily' | 'weekly' | 'monthly' | 'safety' | 'manual';

export interface StorageObjectManifest {
  key: string;
  size_bytes: number;
  sha256: string;
  mime_type?: string;
}

export interface BackupManifest {
  manifest_version: string;
  backup_id: string;
  backup_type: BackupType;
  app_version: string;
  created_at: string;
  storage_backend: string;
  database: {
    engine: string;
    db_name?: string;
    has_binary_dump: boolean;
    collections_count: number;
    collections: Record<string, number>;
  };
  storage: {
    backend_type: string;
    objects_count: number;
    total_bytes: number;
    objects?: StorageObjectManifest[];
  };
  system: {
    node_version: string;
    environment: string;
    rpo_target_hours: number;
    rto_target_hours: number;
  };
}

export interface PlatformBackupDocument {
  _id: string;
  backup_id: string;
  backup_type: BackupType;
  status: BackupStatus;
  db_status: ComponentBackupStatus;
  storage_status: ComponentBackupStatus;
  archive_filename: string;
  archive_path: string;
  size_bytes: number;
  checksum_sha256: string;
  manifest: BackupManifest;
  duration_ms: number;
  error_message?: string | null;
  created_by: string;
  created_by_email: string;
  verification_result?: {
    verified: boolean;
    verified_at: Date;
    message?: string;
  } | null;
  retention_tier?: RetentionTier;
  is_locked: boolean;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformRestoreDocument {
  _id: string;
  backup_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  safety_backup_id?: string | null;
  started_at: Date;
  completed_at?: Date | null;
  duration_ms: number;
  restored_by: string;
  restored_by_email: string;
  db_restore_status: ComponentBackupStatus;
  storage_restore_status: ComponentBackupStatus;
  verified_references_count: number;
  missing_storage_objects_count: number;
  reference_check_passed?: boolean;
  details?: any;
  error_message?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformBackupConfigDocument {
  _id: string;
  is_scheduled_enabled: boolean;
  schedule_interval_hours: number;
  retention_daily: number;
  retention_weekly: number;
  retention_monthly: number;
  encryption_enabled: boolean;
  last_scheduled_run?: Date | null;
  next_scheduled_run?: Date | null;
  updated_by?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
