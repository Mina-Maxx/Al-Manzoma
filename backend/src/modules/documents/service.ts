import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import {
  DocumentModel,
  QuarryModel,
  FolderModel,
  QuarryPermissionModel,
  DocumentVersionModel,
  UserModel,
  PlatformAdminModel,
  UploadReconciliationModel,
} from '../../database/models/index.js';
import {
  AuthContext,
  DocumentItem,
  DocumentStatus,
  MembershipRole,
  QuarryStatus,
  AuditResult,
  ChangeEntityType,
  ChangeType,
  UserStatus,
} from '../../types/index.js';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  GoneError,
  NotFoundError,
  PreconditionFailedError,
  StorageFailureError,
} from '../../middleware/errors.js';
import { storage, buildStorageKey } from '../storage/index.js';
import { beginIdempotencyAttempt, completeIdempotencyKey, failIdempotencyKey, activeOwners } from '../../services/idempotency.js';
import { reserveQuota, reserveQuotaBytes, releaseQuota } from '../../services/quota.js';
import { appendChange } from '../../services/sync.js';
import { reconcileUploadSideEffects } from '../../services/uploadReconciliation.js';
import { auditService } from '../audit/service.js';

export const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
export const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpeg', '.jpg', '.png']);

export function sanitizeFilename(filename: string): string {
  let name = filename || '';
  try {
    // If multer/busboy misparsed UTF-8 multipart header bytes as ISO-8859-1 (latin1)
    if (/[\u0080-\u00FF]/.test(name)) {
      const converted = Buffer.from(name, 'latin1').toString('utf8');
      if (!converted.includes('\uFFFD') && converted !== name) {
        name = converted;
      }
    }
  } catch {
    // Keep name as-is if decoding fails
  }
  return name.replace(/[\r\n\t]/g, '').trim().substring(0, 255);
}

export function getFileExtension(filename: string): string {
  const ext = filename.slice(((filename.lastIndexOf('.') - 1) >>> 0) + 2);
  return ext ? `.${ext.toLowerCase()}` : '';
}

/**
 * Validates a new filename for renaming:
 * - Rejects empty or whitespace-only names
 * - Trims leading/trailing whitespace
 * - Prevents path traversal, directory separators (/, \), null bytes, and control characters
 * - Rejects invalid filesystem/storage characters (: * ? " < > |)
 * - Preserves existing file extension by default (appends if omitted, rejects if altered)
 * - Enforces max length of 255 characters
 */
export function validateRenameFilename(
  inputName: string,
  existingFilename: string
): { displayName: string; originalFilename: string } {
  if (typeof inputName !== 'string') {
    throw new DomainError('filename must be a string', 400);
  }
  let name = inputName.trim();
  if (!name) {
    throw new DomainError('filename cannot be empty', 400);
  }

  // Prevent directory separators, path traversal, null bytes, and control characters
  if (/[\/\\\x00-\x1f\x7f]/.test(name) || name.includes('..')) {
    throw new DomainError('filename cannot contain directory separators or path traversal', 400);
  }

  // Reject invalid filesystem / storage characters (: * ? " < > |)
  if (/[:*?"<>|]/.test(name)) {
    throw new DomainError('filename contains invalid characters', 400);
  }

  // Preserve existing file extension by default
  const existingExt = getFileExtension(existingFilename || '');
  const inputExt = getFileExtension(name);

  let displayName = name;
  let originalFilename = name;

  if (!inputExt) {
    if (existingExt) {
      originalFilename = `${name}${existingExt}`;
    }
  } else if (existingExt && inputExt.toLowerCase() !== existingExt.toLowerCase()) {
    throw new DomainError(`changing file extension from ${existingExt} to ${inputExt} is not permitted`, 400);
  }

  // Schema maxlength constraint
  if (displayName.length > 255 || originalFilename.length > 255) {
    throw new DomainError('filename exceeds maximum length of 255 characters', 400);
  }

  return { displayName, originalFilename };
}

export async function uploadDocument(
  ctx: AuthContext,
  quarryId: string,
  file: Express.Multer.File,
  metadata: {
    displayName?: string;
    folderId?: string | null;
    idempotencyKey: string;
  }
): Promise<{ document: DocumentItem; created: boolean; reconciliationPending?: boolean }> {
  const originalFilename = sanitizeFilename(file.originalname);
  const ext = getFileExtension(originalFilename);

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new DomainError('file extension is not allowed', 400);
  }

  let mimeType = file.mimetype;
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    if (ext === '.pdf') {
      mimeType = 'application/pdf';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.png') {
      mimeType = 'image/png';
    }
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new DomainError('file content type is not allowed', 400);
  }

  // Validate folder if specified
  if (metadata.folderId) {
    const folder = await FolderModel.findOne({
      _id: metadata.folderId,
      company_id: ctx.companyId,
      quarry_id: quarryId,
      deleted_at: null,
    }).lean();

    if (!folder) {
      throw new NotFoundError('folder not found');
    }
  }

  // Calculate SHA-256
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

  // Idempotency attempt
  const attempt = await beginIdempotencyAttempt(
    ctx.companyId,
    ctx.userId,
    quarryId,
    metadata.idempotencyKey,
    sha256
  );

  if (attempt.isCompleted && attempt.documentId) {
    const doc = await DocumentModel.findById(attempt.documentId).lean();
    if (doc) {
      return { document: doc as any, created: false };
    }
  }

  activeOwners.register(attempt.keyId, attempt.ownerToken);

  let pendingDoc: DocumentItem | null = null;
  let storageUploadedKey: string | null = null;
  let reconciliationId: string | null = null;
  let availabilityWriteStarted = false;
  try {
    // 1. Atomically reserve quota & insert pending document
    pendingDoc = (await reserveQuota(ctx.companyId, quarryId, file.size, {
      displayName: sanitizeFilename(metadata.displayName || originalFilename),
      originalFilename,
      mimeType,
      sha256,
      uploadedBy: ctx.userId,
      folderId: metadata.folderId,
    })) as any;

    const storageKey = buildStorageKey(ctx.companyId, quarryId, pendingDoc!._id);

    // 2. Upload to Cloudflare R2 / S3 storage
    storageUploadedKey = storageKey;
    await storage.put(file.buffer, storageKey, {
      contentType: mimeType,
      sizeBytes: file.size,
    });

    // Persist reconciliation intent before availability so crashes cannot strand a committed document without retry metadata.
    const reconciliation = await UploadReconciliationModel.create({
      document_id: pendingDoc!._id,
      company_id: ctx.companyId,
      quarry_id: quarryId,
      actor_user_id: ctx.userId,
      idempotency_key_id: attempt.keyId,
      storage_ref: storageKey,
      display_name: pendingDoc!.display_name,
      folder_id: pendingDoc!.folder_id || null,
      mime_type: pendingDoc!.mime_type,
      size_bytes: pendingDoc!.size_bytes,
      sha256: pendingDoc!.sha256 || sha256,
      idempotency_status: 'pending',
      sync_status: 'pending',
      audit_status: 'pending',
      attempt_count: 0,
      next_attempt_at: new Date(),
    });
    reconciliationId = reconciliation._id;

    // 3. From this write onward, preserve the document, object, and quota even if a later database call fails.
    availabilityWriteStarted = true;
    const updated = await DocumentModel.findByIdAndUpdate(
      pendingDoc!._id,
      {
        status: DocumentStatus.available,
        storage_ref: storageKey,
      },
      { new: true }
    ).lean();
    if (!updated) throw new Error('document could not be marked available');

    // 4. Complete idempotency key
    await completeIdempotencyKey(attempt.keyId, pendingDoc!._id, storageKey);
    await UploadReconciliationModel.updateOne({ _id: reconciliationId }, { $set: { idempotency_status: 'complete' } });

    // Sync and audit are replayed from the durable intent; failures do not roll back an available document.
    const reconciled = await reconcileUploadSideEffects(reconciliationId);
    return { document: updated as any, created: true, reconciliationPending: !reconciled };
  } catch (err) {
    if (!availabilityWriteStarted) {
      let safeToRemoveStorage = !pendingDoc;
      if (pendingDoc) {
        try {
          const deleted = await DocumentModel.findOneAndDelete({ _id: pendingDoc._id, status: DocumentStatus.pending });
          if (deleted) {
            await releaseQuota(ctx.companyId, file.size);
            safeToRemoveStorage = true;
          } else {
            const current = await DocumentModel.findById(pendingDoc._id).select({ status: 1 }).lean();
            safeToRemoveStorage = !current;
          }
        } catch {
          safeToRemoveStorage = false;
        }
      }
      if (safeToRemoveStorage) {
        if (reconciliationId) await UploadReconciliationModel.deleteOne({ _id: reconciliationId }).catch(() => null);
        if (storageUploadedKey) await storage.delete(storageUploadedKey).catch(() => {});
        await failIdempotencyKey(attempt.keyId).catch(() => {});
      }
    } else if (reconciliationId) {
      await UploadReconciliationModel.updateOne(
        { _id: reconciliationId },
        { $set: { next_attempt_at: new Date(), last_error: 'Upload completion requires reconciliation; stored data was preserved.' } }
      ).catch(() => null);
    }
    throw err;
  } finally {
    activeOwners.unregister(attempt.keyId, attempt.ownerToken);
  }
}

export async function softDeleteDocument(
  ctx: AuthContext,
  quarryId: string,
  documentId: string,
  expectedVersion?: number
): Promise<DocumentItem> {
  const document = await DocumentModel.findOne({
    _id: documentId,
    company_id: ctx.companyId,
    quarry_id: quarryId,
    status: DocumentStatus.available,
    deleted_at: null,
  });

  if (!document) {
    throw new NotFoundError('document not found');
  }

  if (expectedVersion !== undefined && document.version !== expectedVersion) {
    throw new PreconditionFailedError('document version does not match If-Match');
  }

  document.deleted_at = new Date();
  document.deleted_by = ctx.userId;
  document.version += 1;
  await document.save();

  await appendChange(ctx.companyId, {
    quarryId,
    entityType: ChangeEntityType.document,
    entityId: document._id,
    changeType: ChangeType.deleted,
    entityVersion: document.version,
    payload: {},
  });

  await auditService.record({
    action: 'document.delete',
    result: AuditResult.success,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    targetType: 'document',
    targetId: document._id,
    meta: {
      deleted_by_user_id: ctx.userId,
      deleted_by_email: ctx.user.email,
      document_name: document.display_name,
      size_bytes: document.size_bytes,
      quarry_id: quarryId,
    },
  });

  return document.toObject() as any;
}

export async function restoreDocument(
  ctx: AuthContext,
  quarryId: string,
  documentId: string,
  expectedVersion?: number
): Promise<DocumentItem> {
  const document = await DocumentModel.findOne({
    _id: documentId,
    company_id: ctx.companyId,
    quarry_id: quarryId,
  });

  if (!document) {
    throw new NotFoundError('document not found');
  }

  if (!document.deleted_at) {
    throw new ConflictError('document is not deleted');
  }

  if (expectedVersion !== undefined && document.version !== expectedVersion) {
    throw new PreconditionFailedError('document version does not match If-Match');
  }

  const isAdmin = ctx.role === MembershipRole.company_admin || (ctx.role as string) === 'platform_admin';
  const isDeleter = document.deleted_by === ctx.userId;

  if (!isAdmin && !isDeleter) {
    throw new ForbiddenError('only the deleting employee or a company administrator may restore this document');
  }

  if (!isAdmin) {
    const hiddenQuarries = ctx.membership?.hidden_quarries || [];
    if (hiddenQuarries.includes(quarryId)) {
      throw new NotFoundError('document not found');
    }
  }

  // 30-day retention boundary check
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (document.deleted_at < cutoff || document.purge_attempt > 0) {
    throw new GoneError('document retention period has expired; cannot be restored');
  }

  // Verify every retained object before changing the deleted state. Soft deletion
  // does not release quota, so restoration must not reserve or release quota again.
  if (
    !document.storage_ref ||
    !document.original_filename ||
    !document.mime_type ||
    !Number.isFinite(document.size_bytes) ||
    document.size_bytes < 0
  ) {
    throw new StorageFailureError('required document metadata is incomplete; restoration was not completed');
  }
  const versions = await DocumentVersionModel.find({ document_id: document._id }).lean();
  const requiredStorageRefs = [document.storage_ref, ...versions.map((version) => version.storage_ref)];
  if (requiredStorageRefs.some((ref) => !ref)) {
    throw new StorageFailureError('a required document version reference is missing; restoration was not completed');
  }
  try {
    for (const storageRef of new Set(requiredStorageRefs)) {
      if (!(await storage.exists(storageRef))) {
        throw new StorageFailureError('a required document object is missing; restoration was not completed');
      }
    }
  } catch (err) {
    if (err instanceof StorageFailureError) throw err;
    throw new StorageFailureError('document storage could not be verified; restoration was not completed');
  }

  // Parent folder check: unfile to root if parent folder was deleted
  let folderUnfiled = false;
  if (document.folder_id) {
    const folder = await FolderModel.findOne({
      _id: document.folder_id,
      quarry_id: quarryId,
      deleted_at: null,
    }).lean();

    if (!folder) {
      document.folder_id = null;
      folderUnfiled = true;
    }
  }

  // Check for duplicate active file name in destination folder
  const existingActive = await DocumentModel.findOne({
    company_id: ctx.companyId,
    quarry_id: quarryId,
    folder_id: document.folder_id,
    display_name: document.display_name,
    deleted_at: null,
    _id: { $ne: document._id },
  }).lean();

  if (existingActive) {
    throw new ConflictError('يوجد ملف بنفس الاسم في هذا المجلد. يرجى تغيير اسم الملف الحالي أولاً قبل استعادة هذا المستند');
  }

  const originalDeletedBy = document.deleted_by;
  const originalDeletedAt = document.deleted_at;

  document.deleted_at = null;
  document.deleted_by = null;
  document.version += 1;
  await document.save();

  await appendChange(ctx.companyId, {
    quarryId,
    entityType: ChangeEntityType.document,
    entityId: document._id,
    changeType: ChangeType.created,
    entityVersion: document.version,
    payload: {
      display_name: document.display_name,
      folder_id: document.folder_id,
      mime_type: document.mime_type,
      size_bytes: document.size_bytes,
      sha256: document.sha256,
    },
  });

  await auditService.record({
    action: 'document.restore',
    result: AuditResult.success,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    targetType: 'document',
    targetId: document._id,
    meta: {
      restored_by_user_id: ctx.userId,
      folder_unfiled: folderUnfiled,
      previously_deleted_by: originalDeletedBy,
      previously_deleted_at: originalDeletedAt?.toISOString(),
      ...(ctx.platformAdminId ? { platform_admin_id: ctx.platformAdminId } : {}),
    },
  });

  return document.toObject() as any;
}

/**
 * Permanently deletes a soft-deleted document from Trash.
 * - Allowed only for authorized Company Admin or Platform Admin
 * - Deletes physical storage objects for primary file and all historical versions
 * - Removes records from database
 * - Releases quota atomically
 * - Emits sync change and records audit log
 */
export async function permanentlyDeleteDocument(
  ctx: AuthContext,
  quarryId: string,
  documentId: string
): Promise<{ id: string; original_filename: string; freed_bytes: number }> {
  // Only Company Admin and Platform Admin can permanently delete
  if (ctx.role !== MembershipRole.company_admin && (ctx.role as string) !== 'platform_admin') {
    throw new ForbiddenError('صلاحية مسؤول مطلوبة للحذف النهائي للمستندات من سلة المهملات');
  }

  // Find and lock document atomically to prevent concurrent double-deletion and double-quota release
  const doc = await DocumentModel.findOneAndUpdate(
    {
      _id: documentId,
      company_id: ctx.companyId,
      quarry_id: quarryId,
      deleted_at: { $ne: null },
      status: DocumentStatus.available,
    },
    {
      $set: { status: DocumentStatus.pending },
    },
    { new: true }
  );

  if (!doc) {
    throw new NotFoundError('المستند غير موجود في سلة المهملات أو تم حذفه نهائياً بالفعل');
  }

  let totalFreedBytes = doc.size_bytes;

  try {
    // 1. Delete physical object from storage
    if (doc.storage_ref) {
      await storage.delete(doc.storage_ref);
    }

    // 2. Find and delete physical objects for all historical versions
    const versions = await DocumentVersionModel.find({ document_id: doc._id });
    for (const ver of versions) {
      if (ver.storage_ref) {
        await storage.delete(ver.storage_ref);
      }
      totalFreedBytes += ver.size_bytes;
    }
    await DocumentVersionModel.deleteMany({ document_id: doc._id });

    // 3. Delete document record
    await DocumentModel.findByIdAndDelete(doc._id);

    // 4. Release quota atomically
    await releaseQuota(doc.company_id, totalFreedBytes);
  } catch (err) {
    await DocumentModel.findByIdAndUpdate(doc._id, { $set: { status: DocumentStatus.available } });
    console.error(`[PermanentDelete] Failed to delete storage object for document ${doc._id}:`, err);
    throw new StorageFailureError('فشل حذف الملف من التخزين السحابي. يرجى إعادة المحاولة.');
  }

  // 5. Append sync change event (purged)
  await appendChange(ctx.companyId, {
    quarryId,
    entityType: ChangeEntityType.document,
    entityId: doc._id,
    changeType: ChangeType.deleted,
    entityVersion: doc.version,
    payload: { permanent: true, original_filename: doc.original_filename },
  });

  // 6. Record audit event
  await auditService.record({
    action: 'document.permanent_delete',
    result: AuditResult.success,
    companyId: doc.company_id,
    actorUserId: ctx.userId,
    targetType: 'document',
    targetId: doc._id,
    meta: {
      original_filename: doc.original_filename,
      total_freed_bytes: totalFreedBytes,
    },
  });

  return {
    id: doc._id,
    original_filename: doc.original_filename,
    freed_bytes: totalFreedBytes,
  };
}

/**
 * Renames an existing document without modifying file content, storage reference,
 * or creating a new file version.
 * - Allowed for any user with can_view permission in the quarry
 * - Preserves existing file extension by default
 * - Checks duplicate name in the same quarry and folder
 * - Emits sync change and records audit log
 */
export async function renameDocument(
  ctx: AuthContext,
  documentId: string,
  newFilenameInput: string,
  options?: {
    quarryId?: string;
    expectedVersion?: number;
    request?: Request;
  }
): Promise<DocumentItem> {
  // 1. Fetch document with multi-tenant check
  let document;
  const isPlatformAdmin =
    ctx.role === 'platform_admin' ||
    Boolean(
      await PlatformAdminModel.exists({
        auth_user_id: ctx.authUserId || ctx.claims.sub,
        status: UserStatus.active,
      })
    );

  if (isPlatformAdmin) {
    // Platform Admin dual-identity status check
    const platformAdmin = await PlatformAdminModel.findOne({
      auth_user_id: ctx.authUserId || ctx.claims.sub,
      status: UserStatus.active,
    }).lean();

    if (!platformAdmin) {
      throw new ForbiddenError('administrator account is disabled');
    }

    const linkedUser = await UserModel.findOne({
      auth_user_id: ctx.authUserId || ctx.claims.sub,
    }).lean();

    if (linkedUser && linkedUser.status !== UserStatus.active) {
      throw new ForbiddenError('administrator account is disabled');
    }

    document = await DocumentModel.findOne({
      _id: documentId,
      status: DocumentStatus.available,
      deleted_at: null,
    });

    if (!document) {
      throw new NotFoundError('document not found');
    }

    // Context override protection
    if (options?.request) {
      const clientCompanyId = (options.request.headers['x-company-id'] || options.request.query.company_id) as string | undefined;
      if (clientCompanyId && clientCompanyId !== document.company_id) {
        throw new NotFoundError('document not found');
      }
    }
  } else {
    // Standard tenant user check (company admin or employee)
    document = await DocumentModel.findOne({
      _id: documentId,
      company_id: ctx.companyId,
      status: DocumentStatus.available,
      deleted_at: null,
    });

    if (!document) {
      throw new NotFoundError('document not found');
    }

    // Authorization: Company Admin or quarry-level can_view permission
    if (ctx.role !== MembershipRole.company_admin) {
      const hiddenQuarries = ctx.membership?.hidden_quarries || [];
      if (hiddenQuarries.includes(String(document.quarry_id))) {
        throw new NotFoundError('document not found');
      }

      const perm = await QuarryPermissionModel.findOne({
        user_id: ctx.userId,
        quarry_id: String(document.quarry_id),
      }).lean();

      const canView = perm ? Boolean(perm.can_view) : true;
      if (!canView) {
        await auditService.record({
          action: 'document.rename',
          result: AuditResult.denied,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'document',
          targetId: document._id,
          request: options?.request,
        });
        throw new ForbiddenError('permission denied');
      }
    }
  }

  // 2. Validate quarry association if provided
  if (options?.quarryId && options.quarryId !== document.quarry_id) {
    throw new NotFoundError('document not found');
  }

  // 3. Concurrency check (If-Match)
  if (options?.expectedVersion !== undefined && document.version !== options.expectedVersion) {
    throw new PreconditionFailedError('document version does not match If-Match');
  }

  // 4. Validate and sanitize new filename with extension preservation
  const existingFilename = document.original_filename || document.display_name;
  const { displayName: validatedDisplayName, originalFilename: validatedOriginalFilename } =
    validateRenameFilename(newFilenameInput, existingFilename);

  // 5. Duplicate check in the same folder and quarry
  const duplicate = await DocumentModel.findOne({
    _id: { $ne: document._id },
    company_id: document.company_id,
    quarry_id: document.quarry_id,
    folder_id: document.folder_id,
    status: DocumentStatus.available,
    deleted_at: null,
    $or: [
      { display_name: validatedDisplayName },
      { original_filename: validatedOriginalFilename },
      { display_name: validatedOriginalFilename },
    ],
  }).lean();

  if (duplicate) {
    throw new ConflictError('A document with this name already exists in this folder');
  }

  // 6. Update document metadata if name actually changed
  const previousFilename = document.original_filename || document.display_name;
  if (
    validatedDisplayName !== document.display_name ||
    validatedOriginalFilename !== document.original_filename
  ) {
    document.display_name = validatedDisplayName;
    document.original_filename = validatedOriginalFilename;
    document.version += 1;
    await document.save();

    // 7. Append sync event for offline client synchronization
    await appendChange(document.company_id, {
      quarryId: document.quarry_id,
      entityType: ChangeEntityType.document,
      entityId: document._id,
      changeType: ChangeType.updated,
      entityVersion: document.version,
      payload: {
        display_name: document.display_name,
        original_filename: document.original_filename,
        folder_id: document.folder_id,
        mime_type: document.mime_type,
        size_bytes: document.size_bytes,
        sha256: document.sha256,
      },
    });

    // 8. Record audit event
    await auditService.record({
      action: 'document.rename',
      result: AuditResult.success,
      companyId: document.company_id,
      actorUserId: ctx.userId,
      targetType: 'document',
      targetId: document._id,
      meta: {
        quarry_id: document.quarry_id,
        previous_filename: previousFilename,
        new_filename: validatedOriginalFilename,
        new_display_name: validatedDisplayName,
      },
      request: options?.request,
    });
  }

  return document.toObject() as any;
}



export async function listTrashDocuments(
  ctx: AuthContext,
  quarryId: string
) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const query: any = {
    company_id: ctx.companyId,
    quarry_id: quarryId,
    status: DocumentStatus.available,
    deleted_at: { $ne: null, $gte: cutoff },
    purge_attempt: 0,
  };

  if (ctx.role !== MembershipRole.company_admin && (ctx.role as string) !== 'platform_admin') {
    query.deleted_by = ctx.userId;
  }

  const docs = await DocumentModel.find(query).sort({ deleted_at: -1 }).lean();

  const userIds = Array.from(new Set([...docs.map((d) => d.deleted_by), ...docs.map((d) => d.uploaded_by)].filter(Boolean)));
  const users = userIds.length > 0 ? await UserModel.find({ _id: { $in: userIds } }).lean() : [];
  const userMap = new Map(users.map((u) => [u._id, u.full_name || u.username || u.email || 'مستخدم']));

  return docs.map((doc) => {
    const canRestore = ctx.role === MembershipRole.company_admin || (ctx.role as string) === 'platform_admin' || doc.deleted_by === ctx.userId;
    const retentionExpiresAt = new Date(new Date(doc.deleted_at!).getTime() + 30 * 24 * 60 * 60 * 1000);
    const uploadedByName = doc.uploaded_by ? userMap.get(doc.uploaded_by) || doc.uploaded_by : 'غير معروف';

    return {
      id: doc._id,
      quarry_id: doc.quarry_id,
      folder_id: doc.folder_id,
      display_name: doc.display_name,
      title: doc.display_name,
      original_filename: doc.original_filename,
      file_name: doc.original_filename,
      mime_type: doc.mime_type,
      size_bytes: doc.size_bytes,
      file_size: doc.size_bytes,
      version: doc.version,
      created_at: doc.createdAt,
      deleted_at: doc.deleted_at,
      deleted_by: doc.deleted_by,
      uploaded_by: doc.uploaded_by,
      uploaded_by_name: uploadedByName,
      can_restore: canRestore,
      retention_expires_at: retentionExpiresAt,
      purge_at: retentionExpiresAt.toISOString(),
    };
  });
}

/**
 * Centralized Company Trash
 * Aggregates soft-deleted documents across all accessible quarries within the company,
 * including formatted quarry and folder names, deleting user display name, and retention timestamps.
 */
export async function listCompanyTrashDocuments(ctx: AuthContext) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  let accessibleQuarries: any[] = [];
  if (ctx.role === MembershipRole.company_admin || (ctx.role as string) === 'platform_admin') {
    accessibleQuarries = await QuarryModel.find({ company_id: ctx.companyId }).lean();
  } else {
    const allCompanyQuarries = await QuarryModel.find({
      company_id: ctx.companyId,
      status: QuarryStatus.active,
    }).lean();

    const hiddenQuarries = new Set(ctx.membership?.hidden_quarries || []);
    const explicitPerms = await QuarryPermissionModel.find({
      user_id: ctx.userId,
      quarry_id: { $in: allCompanyQuarries.map((q) => q._id) },
    }).lean();
    const explicitMap = new Map(explicitPerms.map((p) => [p.quarry_id, p]));

    accessibleQuarries = allCompanyQuarries.filter((q) => {
      if (hiddenQuarries.has(q._id)) return false;
      const explicit = explicitMap.get(q._id);
      return explicit ? Boolean(explicit.can_view) : true;
    });
  }

  const accessibleQuarryIds = accessibleQuarries.map((q) => q._id);
  const quarryMap = new Map(accessibleQuarries.map((q) => [q._id, q]));

  const query: any = {
    company_id: ctx.companyId,
    quarry_id: { $in: accessibleQuarryIds },
    status: DocumentStatus.available,
    deleted_at: { $ne: null, $gte: cutoff },
    purge_attempt: 0,
  };

  if (ctx.role !== MembershipRole.company_admin && (ctx.role as string) !== 'platform_admin') {
    query.deleted_by = ctx.userId;
  }

  const docs = await DocumentModel.find(query).sort({ deleted_at: -1 }).lean();

  const folderIds = docs.map((d) => d.folder_id).filter(Boolean);
  const userIds = Array.from(new Set([...docs.map((d) => d.deleted_by), ...docs.map((d) => d.uploaded_by)].filter(Boolean)));

  const [folders, users] = await Promise.all([
    FolderModel.find({ _id: { $in: folderIds } }).lean(),
    UserModel.find({ _id: { $in: userIds } }).lean(),
  ]);

  const folderMap = new Map(folders.map((f) => [f._id, f.name]));
  const userMap = new Map(users.map((u) => [u._id, u.full_name || u.username || u.email || 'مستخدم']));

  return docs.map((doc) => {
    const canRestore = ctx.role === MembershipRole.company_admin || (ctx.role as string) === 'platform_admin' || doc.deleted_by === ctx.userId;
    const retentionExpiresAt = new Date(new Date(doc.deleted_at!).getTime() + 30 * 24 * 60 * 60 * 1000);
    const quarry = quarryMap.get(doc.quarry_id);
    const quarryName = quarry
      ? (quarry.quarry_number && quarry.quarry_type
          ? `${quarry.name} - رقم ${quarry.quarry_number} (${quarry.quarry_type})`
          : quarry.name)
      : 'محجر غير معروف';
    const folderName = doc.folder_id ? folderMap.get(doc.folder_id) || 'مجلد محذوف' : 'المجلد الرئيسي';
    const deletedByName = doc.deleted_by ? userMap.get(doc.deleted_by) || doc.deleted_by : 'غير محدد';
    const uploadedByName = doc.uploaded_by ? userMap.get(doc.uploaded_by) || doc.uploaded_by : 'غير معروف';

    return {
      id: doc._id,
      quarry_id: doc.quarry_id,
      quarry_name: quarryName,
      folder_id: doc.folder_id || null,
      folder_name: folderName,
      display_name: doc.display_name,
      title: doc.display_name,
      original_filename: doc.original_filename,
      file_name: doc.original_filename,
      mime_type: doc.mime_type,
      size_bytes: doc.size_bytes,
      file_size: doc.size_bytes,
      version: doc.version,
      created_at: doc.createdAt,
      deleted_at: doc.deleted_at,
      deleted_by: doc.deleted_by,
      deleted_by_name: deletedByName,
      uploaded_by: doc.uploaded_by,
      uploaded_by_name: uploadedByName,
      can_restore: canRestore,
      retention_expires_at: retentionExpiresAt,
      purge_at: retentionExpiresAt.toISOString(),
    };
  });
}

/**
 * Upload a new version of an existing document
 */
export async function uploadNewDocumentVersion(
  ctx: AuthContext,
  quarryId: string,
  documentId: string,
  file: Express.Multer.File,
  metadata?: { expectedVersion?: number }
): Promise<DocumentItem> {
  const document = await DocumentModel.findOne({
    _id: documentId,
    company_id: ctx.companyId,
    quarry_id: quarryId,
    status: DocumentStatus.available,
    deleted_at: null,
  });

  if (!document) {
    throw new NotFoundError('document not found');
  }

  if (metadata?.expectedVersion !== undefined && document.version !== metadata.expectedVersion) {
    throw new PreconditionFailedError('document version does not match If-Match');
  }

  const originalFilename = sanitizeFilename(file.originalname);
  const ext = getFileExtension(originalFilename);

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new DomainError('file extension is not allowed', 400);
  }

  let mimeType = file.mimetype;
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    if (ext === '.pdf') {
      mimeType = 'application/pdf';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.png') {
      mimeType = 'image/png';
    }
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new DomainError('file content type is not allowed', 400);
  }

  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const nextVersionNumber = document.version + 1;

  // Atomically reserve quota for the new version's size
  await reserveQuotaBytes(ctx.companyId, file.size);

  // Archive current version into DocumentVersionModel
  if (document.storage_ref) {
    await DocumentVersionModel.create({
      _id: uuidv4(),
      document_id: document._id,
      company_id: ctx.companyId,
      quarry_id: quarryId,
      version: document.version,
      size_bytes: document.size_bytes,
      sha256: document.sha256 || '',
      storage_ref: document.storage_ref,
      mime_type: document.mime_type,
      uploaded_by: document.uploaded_by || ctx.userId,
    });
  }

  const newStorageKey = buildStorageKey(ctx.companyId, quarryId, document._id, nextVersionNumber);

  // Upload to R2 / Storage
  await storage.put(file.buffer, newStorageKey, {
    contentType: file.mimetype,
    sizeBytes: file.size,
  });

  document.version = nextVersionNumber;
  document.storage_ref = newStorageKey;
  document.size_bytes = file.size;
  document.sha256 = sha256;
  document.mime_type = file.mimetype;
  document.original_filename = originalFilename;
  await document.save();

  await appendChange(ctx.companyId, {
    quarryId,
    entityType: ChangeEntityType.document,
    entityId: document._id,
    changeType: ChangeType.updated,
    entityVersion: document.version,
    payload: {
      display_name: document.display_name,
      folder_id: document.folder_id,
      mime_type: document.mime_type,
      size_bytes: document.size_bytes,
      sha256: document.sha256,
    },
  });

  await auditService.record({
    action: 'document.version_create',
    result: AuditResult.success,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    targetType: 'document',
    targetId: document._id,
    meta: {
      version: document.version,
      size_bytes: document.size_bytes,
      quarry_id: quarryId,
    },
  });

  return document.toObject() as any;
}



/**
 * List historical versions of a document
 */
export async function listDocumentVersions(
  ctx: AuthContext,
  quarryId: string,
  documentId: string
) {
  const document = await DocumentModel.findOne({
    _id: documentId,
    company_id: ctx.companyId,
    quarry_id: quarryId,
    status: DocumentStatus.available,
    deleted_at: null,
  }).lean();

  if (!document) {
    throw new NotFoundError('document not found');
  }

  const versions = await DocumentVersionModel.find({
    document_id: documentId,
    company_id: ctx.companyId,
  })
    .sort({ version: -1 })
    .lean();

  return versions.map((v) => ({
    id: v._id,
    document_id: v.document_id,
    version: v.version,
    size_bytes: v.size_bytes,
    sha256: v.sha256,
    mime_type: v.mime_type,
    created_at: v.createdAt,
    uploaded_by: v.uploaded_by,
  }));
}

export interface PurgeReport {
  purgedCount: number;
  freedBytes: number;
  failedCount: number;
}

/**
 * Permanently purge expired soft-deleted documents and release their quota.
 */
export async function purgeExpiredDocuments(options?: {
  retentionDays?: number;
  batchSize?: number;
  dryRun?: boolean;
}): Promise<PurgeReport> {
  const retentionDays = options?.retentionDays ?? 30;
  const batchSize = options?.batchSize ?? 50;
  const dryRun = options?.dryRun ?? false;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const expiredDocs = await DocumentModel.find({
    deleted_at: { $ne: null, $lt: cutoff },
    status: DocumentStatus.available,
  })
    .sort({ deleted_at: 1 })
    .limit(batchSize);

  let purgedCount = 0;
  let freedBytes = 0;
  let failedCount = 0;

  for (const doc of expiredDocs) {
    if (dryRun) {
      purgedCount++;
      freedBytes += doc.size_bytes;
      continue;
    }

    try {
      // 1. Delete main file from storage
      if (doc.storage_ref) {
        await storage.delete(doc.storage_ref);
      }

      let totalDocBytes = doc.size_bytes;

      // 2. Find and delete historical versions
      const versions = await DocumentVersionModel.find({ document_id: doc._id });
      for (const ver of versions) {
        if (ver.storage_ref) {
          try {
            await storage.delete(ver.storage_ref);
          } catch (verErr) {
            console.warn(`[PURGE] Failed to delete version object ${ver.storage_ref}:`, verErr);
          }
        }
        totalDocBytes += ver.size_bytes;
      }
      await DocumentVersionModel.deleteMany({ document_id: doc._id });

      // 3. Delete document record
      await DocumentModel.findByIdAndDelete(doc._id);

      // 4. Release quota atomically
      await releaseQuota(doc.company_id, totalDocBytes);

      await auditService.record({
        action: 'document.purge',
        result: AuditResult.success,
        companyId: doc.company_id,
        targetType: 'document',
        targetId: doc._id,
        meta: {
          storage_ref: doc.storage_ref,
          total_freed_bytes: totalDocBytes,
        },
      });

      purgedCount++;
      freedBytes += totalDocBytes;
    } catch (err) {
      failedCount++;
      console.error(`[PURGE] Failed to purge document ${doc._id}:`, err);
    }
  }

  return { purgedCount, freedBytes, failedCount };
}
