import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
  QuarryModel,
  QuarryPermissionModel,
  FolderModel,
  DocumentModel,
  PlatformAdminModel,
  UserModel,
  MembershipModel,
} from '../../database/models/index.js';
import {
  QuarryStatus,
  MembershipRole,
  DocumentStatus,
  UserStatus,
  ChangeEntityType,
  ChangeType,
  AuditResult,
} from '../../types/index.js';
import {
  authenticate,
  requireCompanyAdmin,
  requireQuarryPermission,
  resolveQuarryPermission,
} from '../../middleware/auth.js';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
} from '../../middleware/errors.js';
import {
  uploadDocument,
  uploadNewDocumentVersion,
  listDocumentVersions,
  softDeleteDocument,
  restoreDocument,
  permanentlyDeleteDocument,
  listTrashDocuments,
  listCompanyTrashDocuments,
  renameDocument,
} from '../documents/service.js';
import { appendChange } from '../../services/sync.js';
import { auditService } from '../audit/service.js';
import { config } from '../../config/index.js';
import { provisionQuarry } from './provision.js';

export function formatQuarryDisplayName(name: string, quarryNumber?: string | null, quarryType?: string | null): string {
  if (quarryNumber && quarryType) {
    return `${name} - رقم ${quarryNumber} (${quarryType})`;
  }
  if (quarryNumber) {
    return `${name} - رقم ${quarryNumber}`;
  }
  return name;
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const quarriesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSizeBytes },
});

export function parseIfMatch(header?: string): number | undefined {
  if (!header) return undefined;
  const match = header.match(/"?(\d+)"?/);
  if (!match) {
    throw new DomainError('malformed If-Match header', 400);
  }
  return parseInt(match[1], 10);
}

/**
 * GET /quarries
 */
quarriesRouter.get('/quarries', authenticate, async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const activeQuarries = await QuarryModel.find({
      company_id: ctx.companyId,
      status: QuarryStatus.active,
    }).lean();

    // Deterministic Arabic/English alphabetical sorting
    activeQuarries.sort((a, b) => (a.name || '').localeCompare(b.name || '', ['ar', 'en'], { sensitivity: 'base', numeric: true }));

    const isCompanyAdmin = ctx.role === MembershipRole.company_admin || (ctx.role as string) === 'company_admin';
    if ((ctx.role as string) === 'platform_admin' || isCompanyAdmin) {
      const out = activeQuarries.map((q) => ({
        id: q._id,
        name: q.name,
        quarry_number: q.quarry_number || null,
        quarry_type: q.quarry_type || null,
        display_name: formatQuarryDisplayName(q.name, q.quarry_number, q.quarry_type),
        status: q.status,
        permissions: {
          can_view: true,
          can_upload: true,
          can_download: true,
          can_delete: true,
        },
      }));
      return res.json(out);
    }

    // Resolve all company members' company-wide grants together with quarry-level restrictions.
    const membership = await MembershipModel.findOne({
      user_id: ctx.userId,
      company_id: ctx.companyId,
    }).lean();

    const hiddenSet = new Set(membership?.hidden_quarries || []);

    // Check legacy QuarryPermissionModel records
    const explicitPerms = await QuarryPermissionModel.find({
      user_id: ctx.userId,
      quarry_id: { $in: activeQuarries.map((q) => q._id) },
    }).lean();

    const permMap = new Map(explicitPerms.map((p) => [p.quarry_id, p]));

    // Company-wide operational permissions
    const companyWidePerms = {
      can_view: membership?.can_view ?? true,
      can_upload: membership?.can_upload ?? true,
      can_download: membership?.can_download ?? true,
      can_delete: membership?.can_delete ?? false,
    };

    // If company-wide view is disabled, return empty list
    if (!companyWidePerms.can_view) {
      return res.json([]);
    }

    const out: any[] = [];

    for (const q of activeQuarries) {
      const explicit = permMap.get(q._id);

      // Quarry is hidden if in hidden_quarries or explicit legacy can_view is false
      if (hiddenSet.has(q._id) || (explicit && explicit.can_view === false)) {
        continue;
      }

      const effectivePerm = {
        can_view: resolveQuarryPermission('can_view', membership, explicit),
        can_upload: resolveQuarryPermission('can_upload', membership, explicit),
        can_download: resolveQuarryPermission('can_download', membership, explicit),
        can_delete: resolveQuarryPermission('can_delete', membership, explicit),
      };

      out.push({
        id: q._id,
        name: q.name,
        quarry_number: q.quarry_number || null,
        quarry_type: q.quarry_type || null,
        display_name: formatQuarryDisplayName(q.name, q.quarry_number, q.quarry_type),
        status: q.status,
        permissions: effectivePerm,
      });
    }

    // Maintain deterministic sorting
    out.sort((a, b) => (a.name || '').localeCompare(b.name || '', ['ar', 'en'], { sensitivity: 'base', numeric: true }));

    res.json(out);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /quarries
 */
quarriesRouter.post('/quarries', authenticate, async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const name = (req.body.name || '').trim();
    const quarryNumber = (req.body.quarry_number || req.body.quarryNumber || '').trim();
    const quarryType = (req.body.quarry_type || req.body.quarryType || '').trim();

    if (!name) {
      throw new DomainError('اسم المحجر مطلوب', 400);
    }
    if (!quarryNumber) {
      throw new DomainError('رقم المحجر مطلوب', 400);
    }
    if (!quarryType) {
      throw new DomainError('نوع المحجر مطلوب', 400);
    }

    const quarry = await provisionQuarry({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      companyId: ctx.companyId,
      name,
      quarryNumber,
      quarryType,
      request: req,
    });

    res.status(201).json({
      id: quarry.id,
      name: quarry.name,
      quarry_number: quarry.quarry_number,
      quarry_type: quarry.quarry_type,
      display_name: formatQuarryDisplayName(quarry.name, quarry.quarry_number, quarry.quarry_type),
      status: quarry.status,
      permissions: quarry.permissions,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /quarries/:id
 * Edit quarry information (Company Admin or Platform Admin)
 */
quarriesRouter.patch(
  '/quarries/:id',
  authenticate,
  requireCompanyAdmin,
  async (req: Request, res: Response, next) => {
    try {
      const ctx = req.authContext!;
      const quarry = await QuarryModel.findOne({ _id: req.params.id, company_id: ctx.companyId });
      if (!quarry) throw new NotFoundError('quarry not found');

      if (req.body.name !== undefined) {
        const name = String(req.body.name || '').trim();
        if (!name) throw new DomainError('اسم المحجر مطلوب', 400);
        const duplicate = await QuarryModel.findOne({
          _id: { $ne: quarry._id },
          company_id: ctx.companyId,
          name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
        });
        if (duplicate) throw new ConflictError('اسم المحجر مسجل بالفعل لهذه الشركة');
        quarry.name = name;
      }

      if (req.body.quarry_number !== undefined || req.body.quarryNumber !== undefined) {
        const qNum = String(req.body.quarry_number ?? req.body.quarryNumber ?? '').trim();
        if (qNum) {
          const duplicate = await QuarryModel.findOne({
            _id: { $ne: quarry._id },
            company_id: ctx.companyId,
            quarry_number: { $regex: new RegExp(`^${escapeRegex(qNum)}$`, 'i') },
          });
          if (duplicate) throw new ConflictError('رقم المحجر مسجل بالفعل لهذه الشركة');
          quarry.quarry_number = qNum;
        }
      }

      if (req.body.quarry_type !== undefined || req.body.quarryType !== undefined) {
        const qType = String(req.body.quarry_type ?? req.body.quarryType ?? '').trim();
        quarry.quarry_type = qType || null;
      }

      await quarry.save();

      await auditService.record({
        action: 'quarry.update',
        result: AuditResult.success,
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        targetType: 'quarry',
        targetId: quarry._id,
        meta: { name: quarry.name, quarry_number: quarry.quarry_number, quarry_type: quarry.quarry_type },
        request: req,
      });

      res.json({
        id: quarry._id,
        name: quarry.name,
        quarry_number: quarry.quarry_number,
        quarry_type: quarry.quarry_type,
        display_name: formatQuarryDisplayName(quarry.name, quarry.quarry_number, quarry.quarry_type),
        status: quarry.status,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /quarries/:id
 * Safe soft-delete / archival of quarry without deleting documents or audit records
 */
quarriesRouter.delete(
  '/quarries/:id',
  authenticate,
  requireCompanyAdmin,
  async (req: Request, res: Response, next) => {
    try {
      const ctx = req.authContext!;
      const quarry = await QuarryModel.findOne({ _id: req.params.id, company_id: ctx.companyId });
      if (!quarry) throw new NotFoundError('quarry not found');

      quarry.status = QuarryStatus.inactive;
      await quarry.save();

      await auditService.record({
        action: 'quarry.delete',
        result: AuditResult.success,
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        targetType: 'quarry',
        targetId: quarry._id,
        meta: { name: quarry.name },
        request: req,
      });

      res.json({
        id: quarry._id,
        name: quarry.name,
        status: quarry.status,
        message: 'تم تعطيل/أرشفة المحجر بنجاح دون المساس بمستندات الأرشيف',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /quarries/:id/folders
 */
quarriesRouter.get(
  '/quarries/:id/folders',
  authenticate,
  requireQuarryPermission('can_view'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const folders = await FolderModel.find({
        company_id: req.authContext!.companyId,
        quarry_id: quarryId,
        deleted_at: null,
      }).lean();

      // Standard folders ordered first (1..8), then custom folders alphabetically
      folders.sort((a, b) => {
        if (a.is_standard && b.is_standard) {
          return (a.standard_order ?? 0) - (b.standard_order ?? 0);
        }
        if (a.is_standard && !b.is_standard) return -1;
        if (!a.is_standard && b.is_standard) return 1;
        return a.name.localeCompare(b.name, 'ar', { sensitivity: 'base' });
      });

      res.json(
        folders.map((f) => ({
          id: f._id,
          quarry_id: f.quarry_id,
          parent_id: f.parent_id || null,
          name: f.name,
          is_standard: Boolean(f.is_standard),
          standard_order: f.standard_order ?? null,
          standard_key: f.standard_key ?? null,
          version: f.version,
          created_at: f.createdAt,
          updated_at: f.updatedAt,
        }))
      );
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /quarries/:id/folders
 */
quarriesRouter.post(
  '/quarries/:id/folders',
  authenticate,
  requireQuarryPermission('can_upload'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const ctx = req.authContext!;
      const name = (req.body.name || '').trim();
      const parentId = req.body.parent_id || null;

      if (!name) {
        throw new DomainError('folder name is required', 400);
      }

      if (parentId) {
        const parent = await FolderModel.findOne({
          _id: parentId,
          company_id: ctx.companyId,
          quarry_id: quarryId,
          deleted_at: null,
        }).lean();
        if (!parent) {
          throw new NotFoundError('parent folder not found');
        }
      }

      const duplicate = await FolderModel.findOne({
        quarry_id: quarryId,
        parent_id: parentId,
        deleted_at: null,
        name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
      });
      if (duplicate) {
        throw new ConflictError('a folder with this name already exists in this parent');
      }

      const folder = await FolderModel.create({
        company_id: ctx.companyId,
        quarry_id: quarryId,
        parent_id: parentId,
        name,
        version: 1,
      });

      await appendChange(ctx.companyId, {
        quarryId,
        entityType: ChangeEntityType.folder,
        entityId: folder._id,
        changeType: ChangeType.created,
        entityVersion: 1,
        payload: { name: folder.name, parent_id: folder.parent_id },
      });

      res.status(201).json({
        id: folder._id,
        quarry_id: folder.quarry_id,
        parent_id: folder.parent_id || null,
        name: folder.name,
        version: folder.version,
        created_at: folder.createdAt,
        updated_at: folder.updatedAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /quarries/:id/folders/:folderId
 */
quarriesRouter.patch(
  '/quarries/:id/folders/:folderId',
  authenticate,
  requireQuarryPermission('can_upload'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const folderId = String(req.params.folderId);
      const ctx = req.authContext!;
      const name = (req.body.name || '').trim();
      const ifMatch = parseIfMatch(req.headers['if-match'] as string);

      if (!name) throw new DomainError('folder name is required', 400);

      const folder = await FolderModel.findOne({
        _id: folderId,
        company_id: ctx.companyId,
        quarry_id: quarryId,
        deleted_at: null,
      });

      if (!folder) throw new NotFoundError('folder not found');

      // Standard folders cannot be renamed
      if (folder.is_standard) {
        throw new ForbiddenError('المجلدات القياسية محمية ولا يمكن تعديل اسمها');
      }

      if (ifMatch !== undefined && folder.version !== ifMatch) {
        throw new PreconditionFailedError('folder version does not match If-Match');
      }

      const duplicate = await FolderModel.findOne({
        _id: { $ne: folder._id },
        quarry_id: quarryId,
        parent_id: folder.parent_id,
        deleted_at: null,
        name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
      });
      if (duplicate) throw new ConflictError('a folder with this name already exists');

      folder.name = name;
      folder.version += 1;
      await folder.save();

      await appendChange(ctx.companyId, {
        quarryId,
        entityType: ChangeEntityType.folder,
        entityId: folder._id,
        changeType: ChangeType.updated,
        entityVersion: folder.version,
        payload: { name: folder.name, parent_id: folder.parent_id },
      });

      res.json({
        id: folder._id,
        quarry_id: folder.quarry_id,
        parent_id: folder.parent_id || null,
        name: folder.name,
        version: folder.version,
        created_at: folder.createdAt,
        updated_at: folder.updatedAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /quarries/:id/folders/:folderId
 */
quarriesRouter.delete(
  '/quarries/:id/folders/:folderId',
  authenticate,
  requireQuarryPermission('can_delete'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const folderId = String(req.params.folderId);
      const ctx = req.authContext!;
      const ifMatch = parseIfMatch(req.headers['if-match'] as string);

      const folder = await FolderModel.findOne({
        _id: folderId,
        company_id: ctx.companyId,
        quarry_id: quarryId,
        deleted_at: null,
      });

      if (!folder) throw new NotFoundError('folder not found');
      if (ifMatch !== undefined && folder.version !== ifMatch) {
        throw new PreconditionFailedError('folder version does not match If-Match');
      }

      if (folder.is_standard) {
        const isPlatformAdmin = Boolean(
          await PlatformAdminModel.exists({
            auth_user_id: ctx.authUserId,
            status: UserStatus.active,
          })
        );
        if (!isPlatformAdmin) {
          throw new ForbiddenError('المجلدات القياسية محمية ولا يمكن حذفها إلا من قبل مسؤولي لوحة الإدارة');
        }

        // Platform Admin deleting standard folder:
        // Safely move all active documents inside the folder into Trash with 30-day retention
        const activeDocs = await DocumentModel.find({
          folder_id: folder._id,
          quarry_id: quarryId,
          company_id: ctx.companyId,
          status: DocumentStatus.available,
          deleted_at: null,
        });

        const now = new Date();
        for (const doc of activeDocs) {
          doc.deleted_at = now;
          doc.deleted_by = ctx.userId;
          doc.version += 1;
          await doc.save();

          await appendChange(ctx.companyId, {
            quarryId,
            entityType: ChangeEntityType.document,
            entityId: doc._id,
            changeType: ChangeType.deleted,
            entityVersion: doc.version,
            payload: {},
          });

          await auditService.record({
            action: 'document.delete',
            result: AuditResult.success,
            companyId: ctx.companyId,
            actorUserId: ctx.userId,
            targetType: 'document',
            targetId: doc._id,
            meta: {
              deleted_by_user_id: ctx.userId,
              document_name: doc.display_name,
              reason: 'standard_folder_deletion_by_platform_admin',
              quarry_id: quarryId,
              folder_id: folder._id,
            },
          });
        }

        folder.deleted_at = now;
        folder.version += 1;
        await folder.save();

        await appendChange(ctx.companyId, {
          quarryId,
          entityType: ChangeEntityType.folder,
          entityId: folder._id,
          changeType: ChangeType.deleted,
          entityVersion: folder.version,
          payload: {},
        });

        await auditService.record({
          action: 'folder.delete_standard',
          result: AuditResult.success,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'folder',
          targetId: folder._id,
          meta: {
            folder_name: folder.name,
            is_standard: true,
            documents_moved_to_trash: activeDocs.length,
            quarry_id: quarryId,
          },
        });

        return res.status(204).end();
      }

      // Check if folder is empty (no active child folders and no active documents)
      const hasChildFolders = await FolderModel.exists({
        parent_id: folder._id,
        deleted_at: null,
      });
      if (hasChildFolders) throw new ConflictError('folder is not empty');

      const hasDocuments = await DocumentModel.exists({
        folder_id: folder._id,
        status: DocumentStatus.available,
        deleted_at: null,
      });
      if (hasDocuments) throw new ConflictError('folder is not empty');

      folder.deleted_at = new Date();
      folder.version += 1;
      await folder.save();

      await appendChange(ctx.companyId, {
        quarryId,
        entityType: ChangeEntityType.folder,
        entityId: folder._id,
        changeType: ChangeType.deleted,
        entityVersion: folder.version,
        payload: {},
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /quarries/:id/documents
 */
quarriesRouter.get(
  '/quarries/:id/documents',
  authenticate,
  requireQuarryPermission('can_view'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const ctx = req.authContext!;
      const folderId = req.query.folder_id as string | undefined;
      const rootOnly = req.query.root_only === 'true';
      const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '100'), 10), 500));
      const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10));

      if (folderId && rootOnly) {
        throw new DomainError('folder_id and root_only cannot be combined', 422);
      }

      const query: any = {
        company_id: ctx.companyId,
        quarry_id: quarryId,
        status: DocumentStatus.available,
        deleted_at: null,
      };

      if (folderId) {
        query.folder_id = folderId;
      } else if (rootOnly) {
        query.folder_id = null;
      }

      const docs = await DocumentModel.find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean();

      // Resolve uploader names, folder names, and quarry name for metadata display
      const uploaderIds = Array.from(new Set(docs.map((d) => d.uploaded_by).filter(Boolean)));
      const folderIds = Array.from(new Set(docs.map((d) => d.folder_id).filter(Boolean)));

      const [uploaders, folders, quarry] = await Promise.all([
        uploaderIds.length > 0
          ? UserModel.find({ _id: { $in: uploaderIds } }).select('_id full_name username email').lean()
          : [],
        folderIds.length > 0
          ? FolderModel.find({ _id: { $in: folderIds } }).select('_id name').lean()
          : [],
        QuarryModel.findById(quarryId).select('name quarry_number quarry_type').lean(),
      ]);

      const uploaderMap = new Map<string, string>(
        uploaders.map((u): [string, string] => [u._id, u.full_name || u.username || u.email || 'مستخدم'])
      );
      const folderMap = new Map<string, string>(folders.map((f): [string, string] => [f._id, f.name]));
      const quarryName = quarry
        ? (quarry.quarry_number && quarry.quarry_type
            ? `${quarry.name} - رقم ${quarry.quarry_number} (${quarry.quarry_type})`
            : quarry.name)
        : null;

      const out = docs.map((d) => ({
        id: d._id,
        quarry_id: d.quarry_id,
        quarry_name: quarryName,
        folder_id: d.folder_id || null,
        folder_name: d.folder_id ? folderMap.get(d.folder_id) || 'مجلد' : 'المجلد الرئيسي',
        display_name: d.display_name,
        title: d.display_name,
        original_filename: d.original_filename,
        file_name: d.original_filename,
        mime_type: d.mime_type,
        size_bytes: d.size_bytes,
        file_size: d.size_bytes,
        sha256: d.sha256 || null,
        status: d.status,
        uploaded_by: d.uploaded_by || null,
        uploaded_by_name: d.uploaded_by ? uploaderMap.get(d.uploaded_by) || d.uploaded_by : 'غير معروف',
        version: d.version,
        created_at: d.createdAt,
        updated_at: d.updatedAt,
      }));

      // Deterministic Arabic/English alphabetical sorting for files
      out.sort((a, b) => {
        const nameA = a.display_name || a.original_filename || '';
        const nameB = b.display_name || b.original_filename || '';
        return nameA.localeCompare(nameB, ['ar', 'en'], { sensitivity: 'base', numeric: true });
      });

      res.json(out);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /quarries/:id/documents (Upload)
 */
quarriesRouter.post(
  '/quarries/:id/documents',
  authenticate,
  requireQuarryPermission('can_upload'),
  upload.single('file'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const file = req.file;
      if (!file) {
        throw new DomainError('no file provided in request', 400);
      }

      const rawIdempotencyKey = (req.headers['idempotency-key'] as string || '').trim();
      const idempotencyKey = rawIdempotencyKey || `auto-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const displayName = req.body.display_name;
      const folderId = req.body.folder_id || null;

      const { document, created, reconciliationPending } = await uploadDocument(req.authContext!, quarryId, file, {
        displayName,
        folderId,
        idempotencyKey,
      });

      res.status(created ? 201 : 200).json({
        id: document._id,
        quarry_id: document.quarry_id,
        folder_id: document.folder_id || null,
        display_name: document.display_name,
        title: document.display_name,
        original_filename: document.original_filename,
        file_name: document.original_filename,
        mime_type: document.mime_type,
        size_bytes: document.size_bytes,
        file_size: document.size_bytes,
        sha256: document.sha256 || null,
        status: document.status,
        reconciliation_pending: reconciliationPending || false,
        uploaded_by: document.uploaded_by || null,
        version: document.version,
        created_at: document.createdAt,
        updated_at: document.updatedAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /quarries/:id/documents/:documentId/versions (Upload new version)
 */
quarriesRouter.post(
  '/quarries/:id/documents/:documentId/versions',
  authenticate,
  requireQuarryPermission('can_upload'),
  upload.single('file'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const documentId = String(req.params.documentId);
      const file = req.file;
      if (!file) {
        throw new DomainError('no file provided in request', 400);
      }

      const ifMatch = parseIfMatch(req.headers['if-match'] as string);
      const updated = await uploadNewDocumentVersion(
        req.authContext!,
        quarryId,
        documentId,
        file,
        { expectedVersion: ifMatch }
      );

      res.status(201).json({
        id: updated._id,
        quarry_id: updated.quarry_id,
        folder_id: updated.folder_id || null,
        display_name: updated.display_name,
        original_filename: updated.original_filename,
        mime_type: updated.mime_type,
        size_bytes: updated.size_bytes,
        sha256: updated.sha256 || null,
        status: updated.status,
        version: updated.version,
        created_at: updated.createdAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /quarries/:id/documents/:documentId/versions (List versions)
 */
quarriesRouter.get(
  '/quarries/:id/documents/:documentId/versions',
  authenticate,
  requireQuarryPermission('can_view'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const documentId = String(req.params.documentId);
      const versions = await listDocumentVersions(req.authContext!, quarryId, documentId);
      res.json(versions);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /quarries/:id/documents/:documentId (Move and/or Rename)
 * Renaming requires can_view; moving to another folder requires can_upload.
 */
quarriesRouter.patch(
  '/quarries/:id/documents/:documentId',
  authenticate,
  requireQuarryPermission('can_view'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const documentId = String(req.params.documentId);
      const ctx = req.authContext!;
      const ifMatch = parseIfMatch(req.headers['if-match'] as string);

      // If moving folder, verify can_upload permission
      if (req.body.folder_id !== undefined) {
        const perm = await QuarryPermissionModel.findOne({
          user_id: ctx.userId,
          quarry_id: quarryId,
        }).lean();
        if (!resolveQuarryPermission('can_upload', ctx.membership, perm)) {
          throw new ForbiddenError('permission denied: can_upload required to move documents');
        }
      }

      const doc = await DocumentModel.findOne({
        _id: documentId,
        company_id: ctx.companyId,
        quarry_id: quarryId,
        status: DocumentStatus.available,
        deleted_at: null,
      });

      if (!doc) throw new NotFoundError('document not found');
      if (ifMatch !== undefined && doc.version !== ifMatch) {
        throw new PreconditionFailedError('document version does not match If-Match');
      }

      // Check rename
      const renameInput = req.body.display_name ?? req.body.name ?? req.body.filename;
      if (renameInput !== undefined) {
        const updatedDoc = await renameDocument(ctx, documentId, renameInput, {
          quarryId,
          expectedVersion: ifMatch,
          request: req,
        });
        doc.display_name = updatedDoc.display_name;
        doc.original_filename = updatedDoc.original_filename;
        doc.version = updatedDoc.version;

      }

      // Check folder move
      if (req.body.folder_id !== undefined) {
        const targetFolderId = req.body.folder_id || null;
        if (targetFolderId) {
          const folder = await FolderModel.findOne({
            _id: targetFolderId,
            company_id: ctx.companyId,
            quarry_id: quarryId,
            deleted_at: null,
          });
          if (!folder) throw new NotFoundError('destination folder not found');
        }
        if (doc.folder_id !== targetFolderId) {
          doc.folder_id = targetFolderId;
          doc.version += 1;
          await doc.save();

          await appendChange(ctx.companyId, {
            quarryId,
            entityType: ChangeEntityType.document,
            entityId: doc._id,
            changeType: ChangeType.updated,
            entityVersion: doc.version,
            payload: {
              display_name: doc.display_name,
              original_filename: doc.original_filename,
              folder_id: doc.folder_id,
              mime_type: doc.mime_type,
              size_bytes: doc.size_bytes,
              sha256: doc.sha256,
            },
          });
  
        }
      }

      res.json({
        id: doc._id,
        quarry_id: doc.quarry_id,
        folder_id: doc.folder_id || null,
        display_name: doc.display_name,
        original_filename: doc.original_filename,
        mime_type: doc.mime_type,
        size_bytes: doc.size_bytes,
        sha256: doc.sha256 || null,
        status: doc.status,
        uploaded_by: doc.uploaded_by || null,
        version: doc.version,
        created_at: doc.createdAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /quarries/:id/documents/:documentId/rename (Dedicated Rename Endpoint)
 * Requires can_view permission only.
 */
quarriesRouter.patch(
  '/quarries/:id/documents/:documentId/rename',
  authenticate,
  requireQuarryPermission('can_view'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const documentId = String(req.params.documentId);
      const ctx = req.authContext!;
      const newName = req.body.name ?? req.body.display_name ?? req.body.filename;
      if (!newName || typeof newName !== 'string') {
        throw new DomainError('name is required', 400);
      }
      const ifMatch = parseIfMatch(req.headers['if-match'] as string);
      const updated = await renameDocument(ctx, documentId, newName, {
        quarryId,
        expectedVersion: ifMatch,
        request: req,
      });

      res.json({
        id: updated._id,
        quarry_id: updated.quarry_id,
        folder_id: updated.folder_id || null,
        display_name: updated.display_name,
        original_filename: updated.original_filename,
        mime_type: updated.mime_type,
        size_bytes: updated.size_bytes,
        sha256: updated.sha256 || null,
        status: updated.status,
        uploaded_by: updated.uploaded_by || null,
        version: updated.version,
        created_at: updated.createdAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /quarries/:id/documents/:documentId (Soft delete)
 * Requires can_delete independently of can_upload!
 */
quarriesRouter.delete(
  '/quarries/:id/documents/:documentId',
  authenticate,
  requireQuarryPermission('can_delete'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const documentId = String(req.params.documentId);
      const ifMatch = parseIfMatch(req.headers['if-match'] as string);

      await softDeleteDocument(req.authContext!, quarryId, documentId, ifMatch);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /quarries/:id/trash
 */
quarriesRouter.get(
  '/quarries/:id/trash',
  authenticate,
  requireQuarryPermission('can_view'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const trash = await listTrashDocuments(req.authContext!, quarryId);
      // Alphabetical sorting for trash items
      trash.sort((a, b) => {
        const nameA = a.display_name || a.original_filename || '';
        const nameB = b.display_name || b.original_filename || '';
        return nameA.localeCompare(nameB, ['ar', 'en'], { sensitivity: 'base', numeric: true });
      });
      res.json(trash);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /quarries/:id/documents/:documentId/restore
 */
quarriesRouter.post(
  '/quarries/:id/documents/:documentId/restore',
  authenticate,
  requireQuarryPermission('can_view'),
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const documentId = String(req.params.documentId);
      const ifMatch = parseIfMatch(req.headers['if-match'] as string);

      const restored = await restoreDocument(req.authContext!, quarryId, documentId, ifMatch);
      res.json({
        id: restored._id,
        quarry_id: restored.quarry_id,
        folder_id: restored.folder_id || null,
        display_name: restored.display_name,
        original_filename: restored.original_filename,
        mime_type: restored.mime_type,
        size_bytes: restored.size_bytes,
        sha256: restored.sha256 || null,
        status: restored.status,
        uploaded_by: restored.uploaded_by || null,
        version: restored.version,
        created_at: restored.createdAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /quarries/:id/documents/:documentId/permanent
 * DELETE /quarries/:id/trash/:documentId
 * Permanently purge a soft-deleted document from Trash (Company Admin & Platform Admin only)
 */
quarriesRouter.delete(
  ['/quarries/:id/documents/:documentId/permanent', '/quarries/:id/trash/:documentId'],
  authenticate,
  requireCompanyAdmin,
  async (req: Request, res: Response, next) => {
    try {
      const quarryId = String(req.params.id);
      const documentId = String(req.params.documentId);
      const result = await permanentlyDeleteDocument(req.authContext!, quarryId, documentId);
      res.json({
        id: result.id,
        original_filename: result.original_filename,
        freed_bytes: result.freed_bytes,
        status: 'permanently_deleted',
        message: 'تم حذف المستند نهائياً بنجاح وتفريغ مساحته التخزينية',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /company/trash
 * Centralized company-level trash aggregating soft-deleted documents across accessible quarries
 */
quarriesRouter.get('/company/trash', authenticate, async (req: Request, res: Response, next) => {
  try {
    const trash = await listCompanyTrashDocuments(req.authContext!);
    // Alphabetical sorting for company trash items
    trash.sort((a, b) => {
      const nameA = a.display_name || a.original_filename || '';
      const nameB = b.display_name || b.original_filename || '';
      return nameA.localeCompare(nameB, ['ar', 'en'], { sensitivity: 'base', numeric: true });
    });
    res.json(trash);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /company/trash/:documentId/permanent
 * DELETE /company/trash/:documentId
 * Centralized permanent deletion of document from company trash (Company Admin only)
 */
quarriesRouter.delete(
  ['/company/trash/:documentId/permanent', '/company/trash/:documentId'],
  authenticate,
  requireCompanyAdmin,
  async (req: Request, res: Response, next) => {
    try {
      const documentId = String(req.params.documentId);
      const doc = await DocumentModel.findOne({
        _id: documentId,
        company_id: req.authContext!.companyId,
      }).lean();
      if (!doc) {
        throw new NotFoundError('document not found');
      }
      const result = await permanentlyDeleteDocument(req.authContext!, doc.quarry_id, documentId);
      res.json({
        id: result.id,
        original_filename: result.original_filename,
        freed_bytes: result.freed_bytes,
        status: 'permanently_deleted',
        message: 'تم حذف المستند نهائياً بنجاح وتفريغ مساحته التخزينية',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /company/trash/:documentId/restore
 * Centralized trash restoration to the original quarry and folder location
 */
quarriesRouter.post(
  '/company/trash/:documentId/restore',
  authenticate,
  async (req: Request, res: Response, next) => {
    try {
      const documentId = String(req.params.documentId);
      const ctx = req.authContext!;
      const ifMatch = parseIfMatch(req.headers['if-match'] as string);

      const doc = await DocumentModel.findOne({
        _id: documentId,
        company_id: ctx.companyId,
      });

      if (!doc) {
        throw new NotFoundError('document not found');
      }

      // Check quarry view permission for employees and company administrators alike.
      if (ctx.membership?.hidden_quarries?.includes(doc.quarry_id)) {
        throw new NotFoundError('document not found');
      }
      const perm = await QuarryPermissionModel.findOne({
        user_id: ctx.userId,
        quarry_id: doc.quarry_id,
      }).lean();
      if (!resolveQuarryPermission('can_view', ctx.membership, perm)) {
        throw new ForbiddenError('insufficient permissions for quarry');
      }

      const restored = await restoreDocument(ctx, doc.quarry_id, documentId, ifMatch);
      res.json({
        id: restored._id,
        quarry_id: restored.quarry_id,
        folder_id: restored.folder_id || null,
        display_name: restored.display_name,
        original_filename: restored.original_filename,
        mime_type: restored.mime_type,
        size_bytes: restored.size_bytes,
        sha256: restored.sha256 || null,
        status: restored.status,
        uploaded_by: restored.uploaded_by || null,
        version: restored.version,
        created_at: restored.createdAt,
      });
    } catch (err) {
      next(err);
    }
  }
);
