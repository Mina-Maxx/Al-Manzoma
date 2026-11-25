import { Router, Request, Response } from 'express';
import {
  DocumentModel,
  DocumentVersionModel,
  QuarryModel,
  QuarryPermissionModel,
  PlatformAdminModel,
  UserModel,
  CompanyModel,
} from '../../database/models/index.js';
import {
  DocumentStatus,
  QuarryStatus,
  AuditResult,
  UserStatus,
  CompanyStatus,
} from '../../types/index.js';
import { authenticate, resolveQuarryPermission } from '../../middleware/auth.js';
import {
  NotFoundError,
  ForbiddenError,
  StorageFailureError,
  DomainError,
} from '../../middleware/errors.js';
import { storage } from '../storage/index.js';
import { pipeToResponse } from '../../utils/pipeResponse.js';
import { auditService } from '../audit/service.js';
import { buildContentDisposition } from '../../utils/contentDisposition.js';
import { renameDocument } from './service.js';
import { parseIfMatch } from '../quarries/router.js';

export const documentsRouter = Router();

/**
 * GET /documents/:id/download or /documents/:id/view
 */
documentsRouter.get(['/documents/:id/download', '/documents/:id/view'], authenticate, async (req: Request, res: Response, next) => {
  try {
    const documentId = String(req.params.id);
    const ctx = req.authContext!;
    const isViewRequest = req.path.endsWith('/view');
    const accessPermission = isViewRequest ? 'can_view' : 'can_download';
    const documentAction = isViewRequest ? 'document.view' : 'document.download';
    const verifiedPlatformAdminContext = Boolean(
      ctx.role === 'platform_admin' &&
        ctx.platformAdminId &&
        req.platformAdminContext &&
        ctx.platformAdminId === req.platformAdminContext.adminId &&
        ctx.authUserId === req.platformAdminContext.authUserId
    );

    // 1. Fetch document
    const document = await DocumentModel.findById(documentId).lean();

    // 2. Validate document existence, availability, and active state
    if (
      !document ||
      document.status !== DocumentStatus.available ||
      document.deleted_at !== null
    ) {
      await auditService.record({
        action: documentAction,
        result: AuditResult.denied,
        companyId: ctx.companyId || null,
        actorUserId: ctx.userId,
        targetType: 'document',
        targetId: documentId,
        request: req,
      });
      throw new NotFoundError('document not found');
    }

    // 3. Validate quarry existence and ensure document strictly belongs to this quarry and company
    const quarry = await QuarryModel.findById(String(document.quarry_id)).lean();
    if (
      !quarry ||
      (!verifiedPlatformAdminContext && quarry.status !== QuarryStatus.active) ||
      quarry.company_id !== document.company_id
    ) {
      await auditService.record({
        action: documentAction,
        result: AuditResult.denied,
        companyId: ctx.companyId || null,
        actorUserId: ctx.userId,
        targetType: 'document',
        targetId: documentId,
        request: req,
      });
      throw new NotFoundError('document not found');
    }

    // 4. Validate company existence
    const company = await CompanyModel.findById(document.company_id).lean();
    if (!company || (!verifiedPlatformAdminContext && company.status !== CompanyStatus.active)) {
      await auditService.record({
        action: documentAction,
        result: AuditResult.denied,
        companyId: ctx.companyId || null,
        actorUserId: ctx.userId,
        targetType: 'document',
        targetId: documentId,
        request: req,
      });
      throw new NotFoundError('document not found');
    }

    // 5. Determine caller authorization mode
    const isPlatformAdmin =
      ctx.role === 'platform_admin' ||
      Boolean(
        await PlatformAdminModel.exists({
          auth_user_id: ctx.authUserId || ctx.claims.sub,
          status: UserStatus.active,
        })
      );

    if (isPlatformAdmin) {
      // --- Explicit Platform Admin Authorization Decision ---
      // (Never uses synthetic company_admin context)

      // Verify PlatformAdmin authority record is active
      const platformAdmin = await PlatformAdminModel.findOne({
        auth_user_id: ctx.authUserId || ctx.claims.sub,
        status: UserStatus.active,
      }).lean();

      if (!platformAdmin) {
        await auditService.record({
          action: 'platform.cross_office_content_access',
          result: AuditResult.denied,
          companyId: document.company_id,
          actorUserId: ctx.userId,
          targetType: 'document',
          targetId: documentId,
          meta: { reason: 'platform_admin_disabled_or_missing' },
          request: req,
        });
        throw new ForbiddenError('administrator account is disabled');
      }

      // Dual-identity status synchronization: verify linked User record is active
      const linkedUser = await UserModel.findOne({
        auth_user_id: ctx.authUserId || ctx.claims.sub,
      }).lean();

      if (linkedUser && linkedUser.status !== UserStatus.active) {
        await auditService.record({
          action: 'platform.cross_office_content_access',
          result: AuditResult.denied,
          companyId: document.company_id,
          actorUserId: ctx.userId,
          targetType: 'document',
          targetId: documentId,
          meta: { reason: 'linked_user_inactive' },
          request: req,
        });
        throw new ForbiddenError('administrator account is disabled');
      }

      // Context override protection:
      // If client supplied X-Company-Id or query company_id, it MUST match document.company_id.
      // Attempting to request Document A with Company B is rejected with 404 to prevent company context tampering.
      const clientCompanyId = (req.headers['x-company-id'] || req.query.company_id) as string | undefined;
      if (!clientCompanyId) {
        await auditService.record({
          action: 'platform.cross_office_content_access',
          result: AuditResult.denied,
          companyId: document.company_id,
          actorUserId: ctx.userId,
          targetType: 'document',
          targetId: documentId,
          meta: { reason: 'missing_explicit_company_context' },
          request: req,
        });
        throw new ForbiddenError('explicit company context (X-Company-Id) is required for platform admin document access');
      }
      if (clientCompanyId !== document.company_id) {
        await auditService.record({
          action: 'platform.cross_office_content_access',
          result: AuditResult.denied,
          companyId: document.company_id,
          actorUserId: ctx.userId,
          targetType: 'document',
          targetId: documentId,
          meta: {
            reason: 'company_id_mismatch',
            client_company_id: clientCompanyId,
            document_company_id: document.company_id,
          },
          request: req,
        });
        throw new NotFoundError('document not found');
      }

      const targetCompany = await CompanyModel.findById(clientCompanyId).lean();
      if (!targetCompany || clientCompanyId !== ctx.companyId) {
        await auditService.record({
          action: 'platform.cross_office_content_access',
          result: AuditResult.denied,
          companyId: document.company_id,
          actorUserId: platformAdmin._id,
          targetType: 'document',
          targetId: documentId,
          meta: { reason: 'selected_company_missing_or_mismatched' },
          request: req,
        });
        throw new NotFoundError('document not found');
      }
      ctx.platformAdminId = platformAdmin._id;

      // Platform Admin access is audited independently from Support Grants.
      await auditService.record({
        action: 'platform.cross_office_content_access',
        result: AuditResult.success,
        companyId: document.company_id,
        actorUserId: platformAdmin._id,
        targetType: 'document',
        targetId: document._id,
        meta: {
          admin_id: platformAdmin._id,
          admin_email: platformAdmin.email,
          filename: document.original_filename,
          size_bytes: document.size_bytes,
          quarry_id: document.quarry_id,
          version: req.query.version ? parseInt(String(req.query.version), 10) : document.version,
        },
        request: req,
      });
    } else {
      // --- Standard Tenant User Authorization ---
      // Strict multi-tenant isolation: user from Company A cannot access Company B document
      if (document.company_id !== ctx.companyId) {
        await auditService.record({
          action: documentAction,
          result: AuditResult.denied,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'document',
          targetId: documentId,
          meta: { reason: 'cross_tenant_access_attempt' },
          request: req,
        });
        throw new NotFoundError('document not found');
      }

      // Company Admins use the same explicitly managed document permissions as employees.
      if (ctx.membership?.hidden_quarries?.includes(String(document.quarry_id))) {
        throw new NotFoundError('document not found');
      }
      const quarryPermission = await QuarryPermissionModel.findOne({
        user_id: ctx.userId,
        quarry_id: String(document.quarry_id),
      }).lean();
      const canView = resolveQuarryPermission('can_view', ctx.membership, quarryPermission);
      if (!canView) {
        throw new NotFoundError('document not found');
      }
      if (!resolveQuarryPermission(accessPermission, ctx.membership, quarryPermission)) {
        await auditService.record({
          action: `quarry.${accessPermission}`,
          result: AuditResult.denied,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'document',
          targetId: document._id,
          request: req,
        });
        throw new ForbiddenError('permission denied');
      }

      // Record standard tenant document download audit
      await auditService.record({
        action: documentAction,
        result: AuditResult.success,
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        targetType: 'document',
        targetId: document._id,
        meta: {
          document_name: document.display_name,
          size_bytes: document.size_bytes,
          quarry_id: document.quarry_id,
          version: req.query.version ? parseInt(String(req.query.version), 10) : document.version,
        },
        request: req,
      });
    }

    // 6. Version resolution
    let targetStorageRef = document.storage_ref;
    let targetMimeType = document.mime_type;
    let targetSizeBytes = document.size_bytes;

    if (req.query.version) {
      const requestedVersion = parseInt(String(req.query.version), 10);
      if (isNaN(requestedVersion) || requestedVersion < 1) {
        throw new DomainError('invalid version parameter', 400);
      }

      if (requestedVersion === document.version) {
        targetStorageRef = document.storage_ref;
        targetMimeType = document.mime_type;
        targetSizeBytes = document.size_bytes;
      } else {
        const docVersion = await DocumentVersionModel.findOne({
          document_id: documentId,
          version: requestedVersion,
        }).lean();

        if (!docVersion) {
          throw new NotFoundError('document version not found');
        }

        targetStorageRef = docVersion.storage_ref;
        targetMimeType = docVersion.mime_type;
        targetSizeBytes = docVersion.size_bytes;
      }
    }

    if (!targetStorageRef) {
      throw new StorageFailureError('document has no storage reference');
    }

    // 7. Stream from configured storage backend
    const storageItem = await storage.get(targetStorageRef);

    const filenameToSend = document.original_filename || document.display_name || 'document';
    res.setHeader('Content-Type', targetMimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', buildContentDisposition(filenameToSend));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (targetSizeBytes) {
      res.setHeader('Content-Length', targetSizeBytes);
    }

    req.on('close', () => {
      if (!res.writableEnded) {
        if ('destroy' in storageItem.stream && typeof (storageItem.stream as any).destroy === 'function') {
          (storageItem.stream as any).destroy();
        }
      }
    });

    pipeToResponse(storageItem.stream as any, res, next);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /documents/:id/rename
 * Renames a document without requiring quarry ID in the path.
 * Requires can_view permission in the document's quarry.
 */
documentsRouter.patch('/documents/:id/rename', authenticate, async (req: Request, res: Response, next) => {
  try {
    const documentId = String(req.params.id);
    const ctx = req.authContext!;
    const newName = req.body.name ?? req.body.display_name ?? req.body.filename;
    if (!newName || typeof newName !== 'string') {
      throw new DomainError('name is required', 400);
    }
    const ifMatch = parseIfMatch(req.headers['if-match'] as string);
    const updated = await renameDocument(ctx, documentId, newName, {
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
});
