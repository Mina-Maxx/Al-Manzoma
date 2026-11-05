import mongoose, { Schema, Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import {
  AuditResult,
  ChangeEntityType,
  ChangeType,
  CompanyDocument,
  CompanyStatus,
  DocumentItem,
  DocumentStatus,
  FolderDocument,
  IdempotencyKeyDocument,
  IdempotencyStatus,
  MembershipDocument,
  MembershipRole,
  PlatformAdminDocument,
  SupportGrantDocument,
  SupportGrantScope,
  SupportGrantStatus,
  QuarryDocument,
  QuarryPermissionDocument,
  QuarryStatus,
  UserDocument,
  UserStatus,
  DocumentVersionDocument,
  AuditEventDocument,
  CompanySyncStateDocument,
  ChangeLogDocument,
  UploadReconciliationDocument,
  AppReleaseDocument,
  PasswordResetTokenDocument,
  PlatformBackupDocument,
  PlatformRestoreDocument,
  PlatformBackupConfigDocument,
} from '../../types/index.js';

// --- 1. Company Model ---
const CompanySchema = new Schema<CompanyDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    name: { type: String, required: true, maxlength: 200, trim: true },
    status: { type: String, enum: Object.values(CompanyStatus), default: CompanyStatus.active },
    quota_bytes: { type: Number, required: true, default: 5368709120 }, // 5 GiB
    max_users: { type: Number, required: true, default: 10 },
    used_bytes: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

CompanySchema.index({ name: 1 });
CompanySchema.index({ status: 1 });

export const CompanyModel: Model<CompanyDocument> = mongoose.model<CompanyDocument>('Company', CompanySchema);

// --- 2. User Model ---
const UserSchema = new Schema<UserDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    auth_user_id: { type: String, required: true, unique: true, index: true },
    username: { type: String, default: null, trim: true },
    normalized_username: { type: String, default: null, sparse: true, index: true, lowercase: true, trim: true },
    email: { type: String, default: null, lowercase: true, trim: true },
    password_hash: { type: String, default: null },
    full_name: { type: String, default: null, trim: true },
    status: { type: String, enum: Object.values(UserStatus), default: UserStatus.active },
    must_change_password: { type: Boolean, default: false },
    tokens_revoked_at: { type: Date, default: null },
    active_session_id: { type: String, default: null },
  },
  { timestamps: true }
);

UserSchema.index({ email: 1 });
UserSchema.index({ status: 1 });

export const UserModel: Model<UserDocument> = mongoose.model<UserDocument>('User', UserSchema);

// --- 3. Membership Model ---
const MembershipSchema = new Schema<MembershipDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    user_id: { type: String, required: true, index: true },
    company_id: { type: String, required: true, index: true },
    role: { type: String, enum: Object.values(MembershipRole), required: true },
    can_view: { type: Boolean, default: true },
    can_upload: { type: Boolean, default: true },
    can_download: { type: Boolean, default: true },
    can_delete: { type: Boolean, default: false },
    hidden_quarries: { type: [String], default: [] },
  },
  { timestamps: true }
);

MembershipSchema.index({ user_id: 1, company_id: 1 }, { unique: true });

export const MembershipModel: Model<MembershipDocument> = mongoose.model<MembershipDocument>('Membership', MembershipSchema);

// --- 4. PlatformAdmin Model ---
const PlatformAdminSchema = new Schema<PlatformAdminDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    auth_user_id: { type: String, required: true, unique: true, index: true },
    email: { type: String, default: null, lowercase: true, trim: true },
    full_name: { type: String, default: null, trim: true },
    status: { type: String, enum: Object.values(UserStatus), default: UserStatus.active },
  },
  { timestamps: true }
);

export const PlatformAdminModel: Model<PlatformAdminDocument> = mongoose.model<PlatformAdminDocument>('PlatformAdmin', PlatformAdminSchema);

const SupportGrantSchema = new Schema<SupportGrantDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    company_id: { type: String, required: true, index: true },
    requested_by_platform_admin_id: { type: String, required: true, index: true },
    approved_by_platform_admin_id: { type: String, default: null, index: true },
    scopes: { type: [{ type: String, enum: Object.values(SupportGrantScope) }], required: true },
    requested_duration_seconds: { type: Number, required: true, min: 1, max: 3600 },
    reason: { type: String, required: true, maxlength: 500, trim: true },
    status: { type: String, enum: Object.values(SupportGrantStatus), default: SupportGrantStatus.pending, index: true },
    requested_at: { type: Date, required: true, default: Date.now },
    approved_at: { type: Date, default: null },
    expires_at: { type: Date, default: null, index: true },
    revoked_at: { type: Date, default: null },
  },
  { timestamps: true }
);

SupportGrantSchema.index({ company_id: 1, status: 1, expires_at: 1 });

export const SupportGrantModel: Model<SupportGrantDocument> = mongoose.model<SupportGrantDocument>(
  'SupportGrant',
  SupportGrantSchema
);

// --- 5. Quarry Model ---
const QuarrySchema = new Schema<QuarryDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    company_id: { type: String, required: true, index: true },
    name: { type: String, required: true, maxlength: 200, trim: true },
    quarry_number: { type: String, default: null, trim: true },
    quarry_type: { type: String, default: null, trim: true },
    status: { type: String, enum: Object.values(QuarryStatus), default: QuarryStatus.active },
  },
  { timestamps: true }
);

QuarrySchema.index({ company_id: 1, name: 1 }, { unique: true });
QuarrySchema.index(
  { company_id: 1, quarry_number: 1 },
  {
    unique: true,
    partialFilterExpression: { quarry_number: { $type: 'string' } },
  }
);
QuarrySchema.index({ company_id: 1, status: 1 });

export const QuarryModel: Model<QuarryDocument> = mongoose.model<QuarryDocument>('Quarry', QuarrySchema);

// --- 6. QuarryPermission Model ---
const QuarryPermissionSchema = new Schema<QuarryPermissionDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    user_id: { type: String, required: true, index: true },
    quarry_id: { type: String, required: true, index: true },
    can_view: { type: Boolean, default: false },
    can_upload: { type: Boolean, default: false },
    can_download: { type: Boolean, default: false },
    can_delete: { type: Boolean, default: false },
  },
  { timestamps: true }
);

QuarryPermissionSchema.index({ user_id: 1, quarry_id: 1 }, { unique: true });

export const QuarryPermissionModel: Model<QuarryPermissionDocument> = mongoose.model<QuarryPermissionDocument>('QuarryPermission', QuarryPermissionSchema);

// --- 7. Folder Model ---
const FolderSchema = new Schema<FolderDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    company_id: { type: String, required: true, index: true },
    quarry_id: { type: String, required: true, index: true },
    parent_id: { type: String, default: null, index: true },
    name: { type: String, required: true, maxlength: 200, trim: true },
    version: { type: Number, default: 1, min: 1 },
    is_standard: { type: Boolean, default: false, index: true },
    standard_order: { type: Number, default: null },
    standard_key: { type: String, default: null },
    deleted_at: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

FolderSchema.index({ quarry_id: 1, parent_id: 1, name: 1 });

export const FolderModel: Model<FolderDocument> = mongoose.model<FolderDocument>('Folder', FolderSchema);

// --- 8. Document Model ---
const DocumentSchema = new Schema<DocumentItem>(
  {
    _id: { type: String, default: () => uuidv4() },
    company_id: { type: String, required: true, index: true },
    quarry_id: { type: String, required: true, index: true },
    folder_id: { type: String, default: null, index: true },
    display_name: { type: String, required: true, maxlength: 255, trim: true },
    original_filename: { type: String, required: true, maxlength: 255 },
    mime_type: { type: String, required: true, maxlength: 100 },
    size_bytes: { type: Number, required: true, min: 0 },
    sha256: { type: String, default: null, maxlength: 64 },
    storage_ref: { type: String, default: null },
    status: { type: String, enum: Object.values(DocumentStatus), default: DocumentStatus.pending },
    uploaded_by: { type: String, default: null },
    version: { type: Number, default: 1, min: 1 },
    deleted_at: { type: Date, default: null, index: true },
    deleted_by: { type: String, default: null },
    purge_attempt: { type: Number, default: 0 },
    purge_token: { type: String, default: null },
    purge_claimed_at: { type: Date, default: null },
    purge_failed_at: { type: Date, default: null },
  },
  { timestamps: true }
);

DocumentSchema.index({ company_id: 1, quarry_id: 1, status: 1 });
DocumentSchema.index({ company_id: 1, status: 1 });
DocumentSchema.index({ quarry_id: 1, folder_id: 1, status: 1 });
DocumentSchema.index({ deleted_at: 1, status: 1 });

export const DocumentModel: Model<DocumentItem> = mongoose.model<DocumentItem>('Document', DocumentSchema);

// --- 9. DocumentVersion Model ---
const DocumentVersionSchema = new Schema<DocumentVersionDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    document_id: { type: String, required: true, index: true },
    company_id: { type: String, required: true, index: true },
    quarry_id: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    size_bytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    storage_ref: { type: String, required: true },
    mime_type: { type: String, required: true },
    uploaded_by: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  }
);

DocumentVersionSchema.index({ document_id: 1, version: 1 }, { unique: true });

export const DocumentVersionModel: Model<DocumentVersionDocument> = mongoose.model<DocumentVersionDocument>('DocumentVersion', DocumentVersionSchema);

// --- 10. IdempotencyKey Model ---
const IdempotencyKeySchema = new Schema<IdempotencyKeyDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    company_id: { type: String, required: true, index: true },
    user_id: { type: String, required: true, index: true },
    quarry_id: { type: String, required: true, index: true },
    key: { type: String, required: true },
    content_sha256: { type: String, required: true },
    status: { type: String, enum: Object.values(IdempotencyStatus), default: IdempotencyStatus.in_progress },
    document_id: { type: String, default: null },
    owner_token: { type: String, default: null },
    lease_expires_at: { type: Date, default: null, index: true },
    failed_at: { type: Date, default: null },
    storage_ref: { type: String, default: null },
  },
  { timestamps: true }
);

IdempotencyKeySchema.index({ company_id: 1, user_id: 1, key: 1 }, { unique: true });

export const IdempotencyKeyModel: Model<IdempotencyKeyDocument> = mongoose.model<IdempotencyKeyDocument>('IdempotencyKey', IdempotencyKeySchema);

// --- 11. AuditEvent Model ---
const AuditEventSchema = new Schema<AuditEventDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    created_at: { type: Date, default: Date.now, index: true },
    company_id: { type: String, default: null, index: true },
    actor_user_id: { type: String, default: null, index: true },
    action: { type: String, required: true, index: true },
    target_type: { type: String, default: null },
    target_id: { type: String, default: null },
    idempotency_key: { type: String, default: undefined },
    result: { type: String, enum: Object.values(AuditResult), required: true },
    ip: { type: String, default: null },
    user_agent: { type: String, default: null },
    meta: { type: Schema.Types.Mixed, default: null },
  }
);

AuditEventSchema.index({ company_id: 1, created_at: -1 });
AuditEventSchema.index({ idempotency_key: 1 }, { unique: true, sparse: true });

export const AuditEventModel: Model<AuditEventDocument> = mongoose.model<AuditEventDocument>('AuditEvent', AuditEventSchema);

// --- 12. CompanySyncState Model ---
const CompanySyncStateSchema = new Schema<CompanySyncStateDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    company_id: { type: String, required: true, unique: true },
    feed_epoch: { type: String, default: () => uuidv4() },
    last_seq: { type: Number, default: 0 },
    min_valid_seq: { type: Number, default: 0 },
    updated_at: { type: Date, default: Date.now },
  }
);

export const CompanySyncStateModel: Model<CompanySyncStateDocument> = mongoose.model<CompanySyncStateDocument>('CompanySyncState', CompanySyncStateSchema);

// --- 13. ChangeLog Model ---
const ChangeLogSchema = new Schema<ChangeLogDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    company_id: { type: String, required: true, index: true },
    seq: { type: Number, required: true },
    quarry_id: { type: String, required: true, index: true },
    entity_type: { type: String, enum: Object.values(ChangeEntityType), required: true },
    entity_id: { type: String, required: true },
    change_type: { type: String, enum: Object.values(ChangeType), required: true },
    entity_version: { type: Number, required: true },
    event_key: { type: String, default: undefined },
    payload: { type: Schema.Types.Mixed, default: {} },
    created_at: { type: Date, default: Date.now, index: true },
  }
);

ChangeLogSchema.index({ company_id: 1, seq: 1 }, { unique: true });
ChangeLogSchema.index({ company_id: 1, created_at: -1 });
ChangeLogSchema.index({ company_id: 1, event_key: 1 }, { unique: true, partialFilterExpression: { event_key: { $type: 'string' } } });

export const ChangeLogModel: Model<ChangeLogDocument> = mongoose.model<ChangeLogDocument>('ChangeLog', ChangeLogSchema);

const UploadReconciliationSchema = new Schema<UploadReconciliationDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    document_id: { type: String, required: true, unique: true, index: true },
    company_id: { type: String, required: true, index: true },
    quarry_id: { type: String, required: true, index: true },
    actor_user_id: { type: String, required: true },
    idempotency_key_id: { type: String, required: true },
    storage_ref: { type: String, required: true },
    display_name: { type: String, required: true },
    folder_id: { type: String, default: null },
    mime_type: { type: String, required: true },
    size_bytes: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true },
    idempotency_status: { type: String, enum: ['pending', 'complete'], default: 'pending', index: true },
    sync_status: { type: String, enum: ['pending', 'complete'], default: 'pending', index: true },
    audit_status: { type: String, enum: ['pending', 'complete'], default: 'pending', index: true },
    attempt_count: { type: Number, default: 0, min: 0 },
    next_attempt_at: { type: Date, default: Date.now, index: true },
    last_error: { type: String, default: null, maxlength: 500 },
    lease_owner: { type: String, default: null },
    lease_expires_at: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

UploadReconciliationSchema.index({ idempotency_status: 1, sync_status: 1, audit_status: 1, next_attempt_at: 1 });

export const UploadReconciliationModel: Model<UploadReconciliationDocument> = mongoose.model<UploadReconciliationDocument>(
  'UploadReconciliation',
  UploadReconciliationSchema
);

// --- 14. AppRelease Model ---
const AppReleaseSchema = new Schema<AppReleaseDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    version_code: { type: Number, required: true, unique: true },
    version_name: { type: String, required: true },
    release_notes: { type: String, default: null },
    minimum_supported_version_code: { type: Number, required: true, default: 1 },
    update_required: { type: Boolean, default: false },
    update_policy: { type: String, enum: ['optional', 'mandatory'], default: 'optional' },
    apk_filename: { type: String, required: true },
    apk_size_bytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    storage_ref: { type: String, required: true },
    is_withdrawn: { type: Boolean, default: false },
    published_by: { type: String, default: null },
    created_at: { type: Date, default: Date.now },
  }
);

export const AppReleaseModel: Model<AppReleaseDocument> = mongoose.model<AppReleaseDocument>('AppRelease', AppReleaseSchema);

// --- 15. PasswordResetToken Model ---
const PasswordResetTokenSchema = new Schema<PasswordResetTokenDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    user_id: { type: String, required: true, index: true },
    token_hash: { type: String, required: true, index: true },
    expires_at: { type: Date, required: true, index: true },
    used_at: { type: Date, default: null, index: true },
    created_at: { type: Date, default: Date.now },
  }
);

PasswordResetTokenSchema.index({ token_hash: 1, used_at: 1 });
PasswordResetTokenSchema.index({ user_id: 1, used_at: 1 });

export const PasswordResetTokenModel: Model<PasswordResetTokenDocument> = mongoose.model<PasswordResetTokenDocument>(
  'PasswordResetToken',
  PasswordResetTokenSchema
);

// --- 16. Platform Backup Model ---
const PlatformBackupSchema = new Schema<PlatformBackupDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    backup_id: { type: String, required: true, unique: true, index: true },
    backup_type: {
      type: String,
      enum: ['full', 'scheduled', 'safety'],
      default: 'full',
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed', 'verified'],
      default: 'pending',
      index: true,
    },
    db_status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    storage_status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    archive_filename: { type: String, default: '' },
    archive_path: { type: String, default: '' },
    size_bytes: { type: Number, default: 0 },
    checksum_sha256: { type: String, default: '' },
    manifest: { type: Schema.Types.Mixed, default: {} },
    duration_ms: { type: Number, default: 0 },
    error_message: { type: String, default: null },
    created_by: { type: String, required: true },
    created_by_email: { type: String, required: true },
    verification_result: { type: Schema.Types.Mixed, default: null },
    retention_tier: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'safety', 'manual'],
      default: 'manual',
      index: true,
    },
    is_locked: { type: Boolean, default: false },
    notes: { type: String, default: null },
  },
  { timestamps: true }
);

PlatformBackupSchema.index({ createdAt: -1 });
PlatformBackupSchema.index({ status: 1, createdAt: -1 });

export const PlatformBackupModel: Model<PlatformBackupDocument> = mongoose.model<PlatformBackupDocument>(
  'PlatformBackup',
  PlatformBackupSchema
);

// --- 17. Platform Restore Model ---
const PlatformRestoreSchema = new Schema<PlatformRestoreDocument>(
  {
    _id: { type: String, default: () => uuidv4() },
    backup_id: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    safety_backup_id: { type: String, default: null },
    started_at: { type: Date, default: Date.now },
    completed_at: { type: Date, default: null },
    duration_ms: { type: Number, default: 0 },
    restored_by: { type: String, required: true },
    restored_by_email: { type: String, required: true },
    db_restore_status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    storage_restore_status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    verified_references_count: { type: Number, default: 0 },
    missing_storage_objects_count: { type: Number, default: 0 },
    reference_check_passed: { type: Boolean, default: true },
    details: { type: Schema.Types.Mixed, default: {} },
    error_message: { type: String, default: null },
  },
  { timestamps: true }
);

export const PlatformRestoreModel: Model<PlatformRestoreDocument> = mongoose.model<PlatformRestoreDocument>(
  'PlatformRestore',
  PlatformRestoreSchema
);

// --- 18. Platform Backup Configuration Model ---
const PlatformBackupConfigSchema = new Schema<PlatformBackupConfigDocument>(
  {
    _id: { type: String, default: () => 'platform-backup-global-config' },
    is_scheduled_enabled: { type: Boolean, default: true },
    schedule_interval_hours: { type: Number, default: 4 }, // 4 hours to satisfy RPO <= 4h
    retention_daily: { type: Number, default: 7 },
    retention_weekly: { type: Number, default: 4 },
    retention_monthly: { type: Number, default: 3 },
    encryption_enabled: { type: Boolean, default: false },
    last_scheduled_run: { type: Date, default: null },
    next_scheduled_run: { type: Date, default: null },
    updated_by: { type: String, default: null },
  },
  { timestamps: true }
);

export const PlatformBackupConfigModel: Model<PlatformBackupConfigDocument> = mongoose.model<PlatformBackupConfigDocument>(
  'PlatformBackupConfig',
  PlatformBackupConfigSchema
);
