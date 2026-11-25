import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import {
  CompanyModel,
  UserModel,
  MembershipModel,
  QuarryModel,
  QuarryPermissionModel,
  DocumentModel,
  DocumentVersionModel,
  FolderModel,
  IdempotencyKeyModel,
  AuditEventModel,
  ChangeLogModel,
  CompanySyncStateModel,
  UploadReconciliationModel,
  AppReleaseModel,
  PlatformAdminModel,
  SupportGrantModel,
} from '../../database/models/index.js';
import {
  CompanyStatus,
  UserStatus,
  MembershipRole,
  QuarryStatus,
  DocumentStatus,
  AuditResult,
  SupportGrantScope,
  SupportGrantStatus,
} from '../../types/index.js';
import { authenticatePlatformAdmin } from '../../middleware/auth.js';
import { DomainError, NotFoundError, ConflictError, ForbiddenError } from '../../middleware/errors.js';
import { auditService } from '../audit/service.js';
import { storage } from '../storage/index.js';
import { config } from '../../config/index.js';
import { backupRouter } from '../backup/router.js';

export const platformRouter = Router();

const apkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB for APKs
});

// Enforce authenticatePlatformAdmin on all /platform routes
platformRouter.use(authenticatePlatformAdmin);

// Mount backup and disaster recovery router under /platform/backups
platformRouter.use('/backups', backupRouter);

/**
 * GET /platform/overview
 */
platformRouter.get('/overview', async (_req: Request, res: Response, next) => {
  try {
    const totalOffices = await CompanyModel.countDocuments();
    const activeOffices = await CompanyModel.countDocuments({ status: CompanyStatus.active });
    const suspendedOffices = await CompanyModel.countDocuments({ status: CompanyStatus.suspended });

    const totalUsers = await UserModel.countDocuments();
    const activeUsers = await UserModel.countDocuments({ status: UserStatus.active });
    const disabledUsers = await UserModel.countDocuments({ status: UserStatus.inactive });

    const totalQuarries = await QuarryModel.countDocuments();
    const activeDocuments = await DocumentModel.countDocuments({ status: DocumentStatus.available, deleted_at: null });
    const trashDocuments = await DocumentModel.countDocuments({ status: DocumentStatus.available, deleted_at: { $ne: null } });

    const storageAgg = await DocumentModel.aggregate([
      { $match: { status: { $in: [DocumentStatus.pending, DocumentStatus.available] } } },
      { $group: { _id: null, totalBytes: { $sum: '$size_bytes' } } },
    ]);
    const totalUsedBytes = storageAgg.length > 0 ? storageAgg[0].totalBytes : 0;

    const quotaAgg = await CompanyModel.aggregate([
      { $group: { _id: null, totalQuota: { $sum: '$quota_bytes' } } },
    ]);
    const totalQuotaBytes = quotaAgg.length > 0 ? quotaAgg[0].totalQuota : 1;
    const storageUtilizationPct = parseFloat(((totalUsedBytes / totalQuotaBytes) * 100).toFixed(2));

    // Telemetry: 30-day activity counts
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const uploadsCount = await AuditEventModel.countDocuments({ action: 'document.upload', result: AuditResult.success, created_at: { $gte: thirtyDaysAgo } });
    const downloadsCount = await AuditEventModel.countDocuments({ action: 'document.download', result: AuditResult.success, created_at: { $gte: thirtyDaysAgo } });
    const deletionsCount = await AuditEventModel.countDocuments({ action: 'document.delete', result: AuditResult.success, created_at: { $gte: thirtyDaysAgo } });
    const restorationsCount = await AuditEventModel.countDocuments({ action: 'document.restore', result: AuditResult.success, created_at: { $gte: thirtyDaysAgo } });
    const failedOperationsCount = await AuditEventModel.countDocuments({ result: { $in: [AuditResult.denied, AuditResult.failure] }, created_at: { $gte: thirtyDaysAgo } });

    // Dynamic infrastructure health checks
    let databaseHealth = 'unhealthy';
    try {
      if (mongoose.connection.readyState === 1) {
        if (mongoose.connection.db) {
          await mongoose.connection.db.admin().ping();
        }
        databaseHealth = 'healthy';
      }
    } catch {
      databaseHealth = 'unhealthy';
    }

    let storageHealth = 'healthy';
    try {
      await storage.exists('health-check-probe');
    } catch {
      storageHealth = 'degraded';
    }

    const storageBackendName =
      config.storageBackend === 's3'
        ? 'Cloudflare R2 (S3-compatible)'
        : config.storageBackend === 'local'
        ? 'Local Filesystem'
        : config.storageBackend;

    res.json({
      // Snake case keys (backend conventions)
      total_offices: totalOffices,
      active_offices: activeOffices,
      suspended_offices: suspendedOffices,
      total_users: totalUsers,
      active_users: activeUsers,
      disabled_users: disabledUsers,
      total_quarries: totalQuarries,
      active_documents: activeDocuments,
      trash_documents: trashDocuments,
      total_used_bytes: totalUsedBytes,
      total_quota_bytes: totalQuotaBytes,
      storage_utilization_pct: storageUtilizationPct,
      time_range_days: 30,
      uploads_count: uploadsCount,
      downloads_count: downloadsCount,
      deletions_count: deletionsCount,
      restorations_count: restorationsCount,
      failed_operations_count: failedOperationsCount,
      activity_trend: [],
      backend_health: 'healthy',
      database_health: databaseHealth,
      storage_health: storageHealth,
      storage_backend: storageBackendName,

      // Camel case keys (for direct TypeScript frontend binding)
      totalOffices,
      activeOffices,
      suspendedOffices,
      totalUsers,
      activeUsers,
      totalQuarries,
      activeDocs: activeDocuments,
      trashDocs: trashDocuments,
      storageUsageBytes: totalUsedBytes,
      storageQuotaBytes: totalQuotaBytes,
      backendHealth: 'healthy',
      databaseHealth,
      storageHealth,
      storageBackend: storageBackendName,
      telemetry: {
        uploadsCount,
        downloadsCount,
        deletionsCount,
        restorationsCount,
        failuresCount: failedOperationsCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/companies
 */
platformRouter.get('/companies', async (_req: Request, res: Response, next) => {
  try {
    const companies = await CompanyModel.find().sort({ createdAt: -1 }).lean();

    const result = await Promise.all(
      companies.map(async (c) => {
        const userCount = await MembershipModel.countDocuments({ company_id: c._id });
        const usageAgg = await DocumentModel.aggregate([
          { $match: { company_id: c._id, status: { $in: [DocumentStatus.pending, DocumentStatus.available] } } },
          { $group: { _id: null, totalBytes: { $sum: '$size_bytes' } } },
        ]);
        const usedBytes = usageAgg.length > 0 ? usageAgg[0].totalBytes : 0;

        return {
          id: c._id,
          name: c.name,
          status: c.status,
          quota_bytes: c.quota_bytes,
          max_users: c.max_users,
          used_bytes: usedBytes,
          user_count: userCount,
        };
      })
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /platform/companies/:id/status
 * Matches the platform dashboard's active/suspended status control.
 */
platformRouter.patch('/companies/:id/status', async (req: Request, res: Response, next) => {
  try {
    const { status } = req.body;
    if (status !== CompanyStatus.active && status !== CompanyStatus.suspended) {
      throw new DomainError('status must be active or suspended', 400);
    }

    const company = await CompanyModel.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true }
    );
    if (!company) throw new NotFoundError('company not found');

    await auditService.record({
      action: status === CompanyStatus.suspended ? 'platform.company.suspend' : 'platform.company.reactivate',
      result: AuditResult.success,
      targetType: 'company',
      targetId: company._id,
      request: req,
    });

    res.json({ id: company._id, name: company.name, status: company.status });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /platform/companies/:id
 * Permanently removes a company and its tenant data after exact-name confirmation.
 * Audit history is retained; users who also belong to another company are preserved.
 */
platformRouter.delete('/companies/:id', async (req: Request, res: Response, next) => {
  try {
    const company = await CompanyModel.findById(req.params.id).lean();
    if (!company) throw new NotFoundError('company not found');
    if (req.body?.confirmation !== company.name) {
      throw new ConflictError('type the exact company name to confirm permanent deletion');
    }

    const suspendSession = await mongoose.startSession();
    try {
      await suspendSession.withTransaction(async () => {
        const currentCompany = await CompanyModel.findById(company._id).session(suspendSession);
        if (!currentCompany) throw new NotFoundError('company not found');
        currentCompany.status = CompanyStatus.suspended;
        await currentCompany.save({ session: suspendSession });
        await auditService.record({
          action: 'platform.company.delete_started',
          result: AuditResult.success,
          companyId: company._id,
          actorUserId: req.platformAdminContext?.adminId,
          targetType: 'company',
          targetId: company._id,
          meta: { company_name: company.name },
          request: req,
          session: suspendSession,
          raiseOnFailure: true,
        });
      });
    } finally {
      await suspendSession.endSession();
    }

    const [documents, versions, pendingUploads, idempotencyRecords, quarries] = await Promise.all([
      DocumentModel.find({ company_id: company._id }).select('_id storage_ref').lean(),
      DocumentVersionModel.find({ company_id: company._id }).select('storage_ref').lean(),
      UploadReconciliationModel.find({ company_id: company._id }).select('storage_ref').lean(),
      IdempotencyKeyModel.find({ company_id: company._id }).select('storage_ref').lean(),
      QuarryModel.find({ company_id: company._id }).select('_id').lean(),
    ]);
    const quarryIds = quarries.map((quarry) => quarry._id);
    const storageRefs = [...new Set([
      ...documents.map((item) => item.storage_ref),
      ...versions.map((item) => item.storage_ref),
      ...pendingUploads.map((item) => item.storage_ref),
      ...idempotencyRecords.map((item) => item.storage_ref),
    ].filter((key): key is string => typeof key === 'string' && key.length > 0))];
    const safeCompanyId = company._id.replace(/[^a-zA-Z0-9-]/g, '');
    const companyStoragePrefix = `company/${safeCompanyId}/`;
    if (storageRefs.some((key) => !key.startsWith(companyStoragePrefix))) {
      throw new ConflictError('company deletion stopped because a stored file reference is outside this company namespace');
    }

    try {
      for (const storageRef of storageRefs) await storage.delete(storageRef);
    } catch (err) {
      console.error('[PlatformCompanyDelete] Storage cleanup failed; company remains suspended:', err);
      throw new DomainError('company is suspended, but some files could not be removed; retry deletion', 502);
    }

    const deleteSession = await mongoose.startSession();
    try {
      await deleteSession.withTransaction(async () => {
        const currentCompany = await CompanyModel.findById(company._id).session(deleteSession);
        if (!currentCompany || currentCompany.status !== CompanyStatus.suspended) {
          throw new ConflictError('company changed while deletion was in progress; retry the operation');
        }

        const companyMemberships = await MembershipModel.find({ company_id: company._id })
          .select('user_id')
          .session(deleteSession)
          .lean();
        const companyUserIds = [...new Set(companyMemberships.map((membership) => membership.user_id))];
        await MembershipModel.deleteMany({ company_id: company._id }, { session: deleteSession });
        await QuarryPermissionModel.deleteMany({ quarry_id: { $in: quarryIds } }, { session: deleteSession });
        await FolderModel.deleteMany({ company_id: company._id }, { session: deleteSession });
        await DocumentModel.deleteMany({ company_id: company._id }, { session: deleteSession });
        await DocumentVersionModel.deleteMany({ company_id: company._id }, { session: deleteSession });
        await IdempotencyKeyModel.deleteMany({ company_id: company._id }, { session: deleteSession });
        await UploadReconciliationModel.deleteMany({ company_id: company._id }, { session: deleteSession });
        await ChangeLogModel.deleteMany({ company_id: company._id }, { session: deleteSession });
        await CompanySyncStateModel.deleteMany({ company_id: company._id }, { session: deleteSession });
        await SupportGrantModel.deleteMany({ company_id: company._id }, { session: deleteSession });
        await QuarryModel.deleteMany({ company_id: company._id }, { session: deleteSession });

        if (companyUserIds.length) {
          const remainingMemberships = await MembershipModel.distinct('user_id', {
            user_id: { $in: companyUserIds },
          }).session(deleteSession);
          const remainingUserIds = new Set(remainingMemberships.map(String));
          const usersWithoutCompanies = companyUserIds.filter((userId) => !remainingUserIds.has(userId));
          if (usersWithoutCompanies.length) {
            await UserModel.updateMany(
              { _id: { $in: usersWithoutCompanies } },
              { $set: { status: UserStatus.inactive, tokens_revoked_at: new Date(), active_session_id: null } },
              { session: deleteSession }
            );
          }
        }

        await CompanyModel.deleteOne({ _id: company._id }, { session: deleteSession });
        await auditService.record({
          action: 'platform.company.delete',
          result: AuditResult.success,
          companyId: null,
          actorUserId: req.platformAdminContext?.adminId,
          targetType: 'company',
          targetId: company._id,
          meta: {
            company_name: company.name,
            quarry_count: quarryIds.length,
            document_count: documents.length,
            file_count: storageRefs.length,
          },
          request: req,
          session: deleteSession,
          raiseOnFailure: true,
        });
      });
    } finally {
      await deleteSession.endSession();
    }

    res.json({ id: company._id, status: 'deleted' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/companies
 */
platformRouter.post('/companies', async (req: Request, res: Response, next) => {
  try {
    const name = (req.body.name || '').trim();
    const quotaBytes = req.body.quota_bytes ? parseInt(req.body.quota_bytes, 10) : config.defaultCompanyQuotaBytes;
    const maxUsers = req.body.max_users ? parseInt(req.body.max_users, 10) : config.defaultCompanyMaxUsers;

    if (!name) throw new DomainError('Company name is required', 400);

    const existing = await CompanyModel.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
    if (existing) throw new ConflictError('a company with this name already exists');

    const company = await CompanyModel.create({
      name,
      quota_bytes: quotaBytes,
      max_users: maxUsers,
      status: CompanyStatus.active,
    });

    await auditService.record({
      action: 'platform.company.create',
      result: AuditResult.success,
      targetType: 'company',
      targetId: company._id,
      meta: { name, quota_bytes: quotaBytes, max_users: maxUsers },
      request: req,
    });

    res.status(201).json({
      id: company._id,
      name: company.name,
      status: company.status,
      quota_bytes: company.quota_bytes,
      max_users: company.max_users,
      used_bytes: 0,
      user_count: 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/companies/:id/suspend
 */
platformRouter.post('/companies/:id/suspend', async (req: Request, res: Response, next) => {
  try {
    const company = await CompanyModel.findByIdAndUpdate(
      req.params.id,
      { status: CompanyStatus.suspended },
      { new: true }
    );
    if (!company) throw new NotFoundError('company not found');

    await auditService.record({
      action: 'platform.company.suspend',
      result: AuditResult.success,
      targetType: 'company',
      targetId: company._id,
      request: req,
    });

    res.json({ id: company._id, status: company.status });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/companies/:id/reactivate
 */
platformRouter.post('/companies/:id/reactivate', async (req: Request, res: Response, next) => {
  try {
    const company = await CompanyModel.findByIdAndUpdate(
      req.params.id,
      { status: CompanyStatus.active },
      { new: true }
    );
    if (!company) throw new NotFoundError('company not found');

    await auditService.record({
      action: 'platform.company.reactivate',
      result: AuditResult.success,
      targetType: 'company',
      targetId: company._id,
      request: req,
    });

    res.json({ id: company._id, status: company.status });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/users
 */
platformRouter.get('/users', async (req: Request, res: Response, next) => {
  try {
    const { status, role, company_id, search } = req.query;
    const filter: any = {};

    if (status) filter.status = status;
    if (search) {
      const s = String(search).trim();
      filter.$or = [
        { email: { $regex: s, $options: 'i' } },
        { full_name: { $regex: s, $options: 'i' } },
        { username: { $regex: s, $options: 'i' } },
      ];
    }

    const users = await UserModel.find(filter).sort({ createdAt: -1 }).lean();

    const userList = await Promise.all(
      users.map(async (u) => {
        const membership = await MembershipModel.findOne({ user_id: u._id }).lean();
        let companyName: string | null = null;

        if (membership) {
          const comp = await CompanyModel.findById(membership.company_id).lean();
          companyName = comp ? comp.name : null;
        }

        const userRole = membership ? membership.role : 'platform_admin';

        return {
          id: u._id,
          username: u.username || null,
          email: u.email || null,
          full_name: u.full_name || null,
          status: u.status,
          role: userRole,
          company_id: membership ? membership.company_id : null,
          company_name: companyName,
          created_at: u.createdAt,
          must_change_password: Boolean(u.must_change_password),
        };
      })
    );

    // Apply role and company filters in memory
    let filtered = userList;
    if (role) filtered = filtered.filter((u) => u.role === role);
    if (company_id) filtered = filtered.filter((u) => u.company_id === company_id);

    res.json(filtered);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/users
 * Provision an employee, company admin, or platform admin account
 */
platformRouter.post('/users', async (req: Request, res: Response, next) => {
  let createdUserId: string | null = null;
  let createdAuthUserId: string | null = null;
  try {
    const { username, email, password, role, company_id, full_name, fullName } = req.body;
    const finalFullName = (full_name || fullName || '').trim() || null;

    if (!username && !email) {
      throw new DomainError('username or email is required', 400);
    }

    const assignedRole = role || 'employee';
    if (!['employee', 'company_admin', 'platform_admin'].includes(assignedRole)) {
      throw new DomainError('invalid role; must be employee, company_admin, or platform_admin', 400);
    }

    const plainPassword = typeof password === 'string' ? password : '';
    if (!plainPassword) {
      throw new DomainError('password is required', 400);
    }
    if (plainPassword.length < 8) {
      throw new DomainError('password must be at least 8 characters', 400);
    }

    let normalizedUsername: string | null = null;
    if (username) {
      normalizedUsername = String(username).trim().toLowerCase();
      const existingUser = await UserModel.findOne({ normalized_username: normalizedUsername });
      if (existingUser) {
        throw new ConflictError('username is already taken');
      }
    }

    let normalizedEmail: string | null = null;
    if (email) {
      normalizedEmail = String(email).trim().toLowerCase();
      const existingEmail = await UserModel.findOne({ email: normalizedEmail });
      if (existingEmail) {
        throw new ConflictError('email is already registered');
      }
    }

    let targetCompany: any = null;
    if (assignedRole !== 'platform_admin') {
      if (!company_id) {
        throw new DomainError('company_id is required for company users', 400);
      }
      targetCompany = await CompanyModel.findById(company_id);
      if (!targetCompany) {
        throw new NotFoundError('company not found');
      }

      const currentUsersCount = await MembershipModel.countDocuments({ company_id: targetCompany._id });
      if (currentUsersCount >= targetCompany.max_users) {
        throw new ConflictError('company has reached maximum users capacity');
      }
    }

    const passwordHash = await bcrypt.hash(plainPassword, 10);
    const authUserId = uuidv4();
    createdAuthUserId = authUserId;

    const user = await UserModel.create({
      auth_user_id: authUserId,
      username: username ? String(username).trim() : null,
      normalized_username: normalizedUsername,
      email: normalizedEmail,
      password_hash: passwordHash,
      full_name: finalFullName,
      status: UserStatus.active,
      must_change_password: true,
    });
    createdUserId = String(user._id);

    if (assignedRole === 'platform_admin') {
      await PlatformAdminModel.create({
        auth_user_id: authUserId,
        email: normalizedEmail || `${user.username}@quarryvault.internal`,
        full_name: finalFullName || user.username || 'Platform Admin',
        status: UserStatus.active,
      });
    } else {
      await MembershipModel.create({
        user_id: user._id,
        company_id: targetCompany._id,
        role: assignedRole === 'company_admin' ? MembershipRole.company_admin : MembershipRole.employee,
      });

      if (assignedRole === 'employee') {
        const activeQuarries = await QuarryModel.find({
          company_id: targetCompany._id,
          status: QuarryStatus.active,
        }).lean();

        for (const q of activeQuarries) {
          await QuarryPermissionModel.create({
            user_id: user._id,
            quarry_id: q._id,
            can_view: true,
            can_upload: false,
            can_download: false,
            can_delete: false,
          });
        }
      }
    }

    await auditService.record({
      action: 'platform.user.create',
      result: AuditResult.success,
      companyId: targetCompany ? targetCompany._id : null,
      targetType: 'user',
      targetId: user._id,
      meta: {
        username: user.username,
        email: user.email,
        role: assignedRole,
        company_id: targetCompany ? targetCompany._id : null,
      },
      request: req,
    });

    res.status(201).json({
      id: user._id,
      username: user.username || null,
      email: user.email || null,
      full_name: user.full_name || null,
      status: user.status,
      role: assignedRole,
      company_id: targetCompany ? targetCompany._id : null,
      company_name: targetCompany ? targetCompany.name : null,
      created_at: user.createdAt,
      must_change_password: Boolean(user.must_change_password),
    });
  } catch (err) {
    if (createdUserId || createdAuthUserId) {
      try {
        await Promise.all([
          ...(createdUserId ? [QuarryPermissionModel.deleteMany({ user_id: createdUserId })] : []),
          ...(createdUserId ? [MembershipModel.deleteMany({ user_id: createdUserId })] : []),
          ...(createdAuthUserId ? [PlatformAdminModel.deleteOne({ auth_user_id: createdAuthUserId })] : []),
          ...(createdUserId ? [UserModel.deleteOne({ _id: createdUserId })] : []),
        ]);
      } catch (cleanupError) {
        console.error('[platform.user.create] compensating cleanup failed', {
          userId: createdUserId,
          errorType: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
        });
      }
    }
    next(err);
  }
});

/** Strict status parser: unknown or missing values are rejected instead of silently enabling the account. */
function parseUserStatus(value: unknown): UserStatus {
  if (value === 'active') return UserStatus.active;
  if (value === 'disabled' || value === 'inactive') return UserStatus.inactive;
  throw new DomainError("status must be 'active' or 'disabled'", 400);
}

/** Prevents platform-admin lockout: no self-removal and never the last active platform admin. */
async function assertPlatformAdminCanBeRemoved(user: { auth_user_id: string }, req: Request, action: string): Promise<void> {
  const linked = await PlatformAdminModel.findOne({ auth_user_id: user.auth_user_id });
  if (!linked) return;
  if (user.auth_user_id === req.platformAdminContext?.authUserId) {
    throw new ConflictError(`cannot ${action} your own platform administrator account`);
  }
  if (linked.status === UserStatus.active) {
    const activeAdmins = await PlatformAdminModel.countDocuments({ status: UserStatus.active });
    if (activeAdmins <= 1) {
      throw new ConflictError(`cannot ${action} the last active platform administrator`);
    }
  }
}

/**
 * PATCH & POST /platform/users/:id/status
 */
const handleUserStatusUpdate = async (req: Request, res: Response, next: any) => {
  try {
    const targetStatus = parseUserStatus(req.body?.status);
    if (targetStatus === UserStatus.inactive) {
      const existing = await UserModel.findById(req.params.id);
      if (!existing) throw new NotFoundError('user not found');
      await assertPlatformAdminCanBeRemoved(existing, req, 'disable');
    }
    const user = await UserModel.findByIdAndUpdate(
      req.params.id,
      { status: targetStatus, tokens_revoked_at: new Date() },
      { new: true }
    );
    if (!user) throw new NotFoundError('user not found');

    await auditService.record({
      action: 'platform.user.status',
      result: AuditResult.success,
      targetType: 'user',
      targetId: user._id,
      meta: { status: targetStatus },
      request: req,
    });

    res.json({ id: user._id, status: user.status });
  } catch (err) {
    next(err);
  }
};

platformRouter.post('/users/:id/status', handleUserStatusUpdate);
platformRouter.patch('/users/:id/status', handleUserStatusUpdate);

/**
 * PATCH /platform/users/:id and /users/:id
 * Full user edit endpoint (name, username, email, role, company, status)
 */
platformRouter.patch(['/users/:id', '/platform/users/:id'], async (req: Request, res: Response, next) => {
  try {
    const { username, email, full_name, fullName, role, company_id, status, auth_user_id } = req.body;
    const user = await UserModel.findById(req.params.id);
    if (!user) throw new NotFoundError('user not found');

    const finalFullName = (full_name !== undefined ? full_name : fullName !== undefined ? fullName : undefined);
    if (finalFullName !== undefined) {
      user.full_name = finalFullName ? String(finalFullName).trim() : null;
    }

    if (auth_user_id !== undefined) {
      const cleanAuthId = String(auth_user_id).trim();
      if (!cleanAuthId) throw new DomainError('auth_user_id cannot be empty', 400);
      const existing = await UserModel.findOne({
        auth_user_id: cleanAuthId,
        _id: { $ne: user._id },
      });
      if (existing) {
        throw new ConflictError('auth_user_id is already assigned to another user');
      }
      user.auth_user_id = cleanAuthId;
    }

    if (username !== undefined) {
      const trimmedUsername = username ? String(username).trim() : null;
      const normalized = trimmedUsername ? trimmedUsername.toLowerCase() : null;
      if (normalized) {
        const existing = await UserModel.findOne({
          normalized_username: normalized,
          _id: { $ne: user._id },
        });
        if (existing) {
          throw new ConflictError('username is already taken');
        }
      }
      user.username = trimmedUsername;
      user.normalized_username = normalized;
    }

    if (email !== undefined) {
      const trimmedEmail = email ? String(email).trim().toLowerCase() : null;
      if (trimmedEmail) {
        const existing = await UserModel.findOne({
          email: trimmedEmail,
          _id: { $ne: user._id },
        });
        if (existing) {
          throw new ConflictError('email is already registered');
        }
      }
      user.email = trimmedEmail;
    }

    if (status !== undefined) {
      const targetStatus = parseUserStatus(status);
      if (targetStatus === UserStatus.inactive) await assertPlatformAdminCanBeRemoved(user, req, 'disable');
      user.status = targetStatus;
    }

    let membership = await MembershipModel.findOne({ user_id: user._id });
    let adminDoc = await PlatformAdminModel.findOne({ auth_user_id: user.auth_user_id });

    // Handle role or company_id changes
    if (role !== undefined || company_id !== undefined) {
      const currentRole = adminDoc ? 'platform_admin' : (membership ? (membership.role === MembershipRole.company_admin ? 'company_admin' : 'employee') : 'employee');
      const targetRole = role !== undefined ? role : currentRole;

      if (!['employee', 'company_admin', 'platform_admin'].includes(targetRole)) {
        throw new DomainError('invalid role', 400);
      }

      if (targetRole === 'platform_admin') {
        if (!adminDoc) {
          adminDoc = await PlatformAdminModel.create({
            auth_user_id: user.auth_user_id,
            email: user.email || `${user.username}@quarryvault.internal`,
            full_name: user.full_name || user.username || 'Platform Admin',
            status: user.status,
          });
        } else {
          adminDoc.email = user.email || adminDoc.email;
          adminDoc.full_name = user.full_name || adminDoc.full_name;
          adminDoc.status = user.status;
          await adminDoc.save();
        }
        // Remove company membership and quarry permissions when elevated to platform admin
        if (membership) {
          await MembershipModel.deleteOne({ _id: membership._id });
          membership = null;
        }
        await QuarryPermissionModel.deleteMany({ user_id: user._id });
      } else {
        // Target role is employee or company_admin
        if (adminDoc) {
          // Demoted from platform admin
          await assertPlatformAdminCanBeRemoved(user, req, 'demote');
          await PlatformAdminModel.deleteOne({ _id: adminDoc._id });
          adminDoc = null;
        }

        const targetCompanyId = company_id !== undefined ? company_id : (membership ? membership.company_id : null);
        if (!targetCompanyId) {
          throw new DomainError('company_id is required for company users', 400);
        }

        const targetCompany = await CompanyModel.findById(targetCompanyId);
        if (!targetCompany) {
          throw new NotFoundError('company not found');
        }

        if (!membership) {
          const currentUsersCount = await MembershipModel.countDocuments({ company_id: targetCompany._id });
          if (currentUsersCount >= targetCompany.max_users) {
            throw new ConflictError('company has reached maximum users capacity');
          }
          membership = await MembershipModel.create({
            user_id: user._id,
            company_id: targetCompany._id,
            role: targetRole === 'company_admin' ? MembershipRole.company_admin : MembershipRole.employee,
          });
        } else {
          if (membership.company_id !== targetCompany._id) {
            const currentUsersCount = await MembershipModel.countDocuments({ company_id: targetCompany._id });
            if (currentUsersCount >= targetCompany.max_users) {
              throw new ConflictError('company has reached maximum users capacity');
            }
            membership.company_id = targetCompany._id;
            // Clear quarry permissions from previous company
            await QuarryPermissionModel.deleteMany({ user_id: user._id });
          }
          membership.role = targetRole === 'company_admin' ? MembershipRole.company_admin : MembershipRole.employee;
          await membership.save();
        }
      }

      // Revoke sessions when role or company changes
      user.tokens_revoked_at = new Date();
    } else {
      // Sync adminDoc if platform admin
      if (adminDoc) {
        adminDoc.auth_user_id = user.auth_user_id;
        if (user.email) adminDoc.email = user.email;
        if (user.full_name) adminDoc.full_name = user.full_name;
        adminDoc.status = user.status;
        await adminDoc.save();
      }
    }

    await user.save();

    await auditService.record({
      action: 'platform.user.update',
      result: AuditResult.success,
      targetType: 'user',
      targetId: user._id,
      meta: {
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        status: user.status,
      },
      request: req,
    });

    const finalRole = adminDoc ? 'platform_admin' : (membership ? membership.role : 'employee');
    let companyName: string | null = null;
    if (membership) {
      const comp = await CompanyModel.findById(membership.company_id).lean();
      companyName = comp ? comp.name : null;
    }

    res.json({
      id: user._id,
      username: user.username || null,
      email: user.email || null,
      full_name: user.full_name || null,
      status: user.status,
      role: finalRole,
      company_id: membership ? membership.company_id : null,
      company_name: companyName,
      created_at: user.createdAt,
      must_change_password: Boolean(user.must_change_password),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /platform/users/:id and /users/:id
 * Soft deletes/deactivates user, revokes sessions, clears memberships and permissions
 */
platformRouter.delete(['/users/:id', '/platform/users/:id'], async (req: Request, res: Response, next) => {
  try {
    const user = await UserModel.findById(req.params.id);
    if (!user) throw new NotFoundError('user not found');

    // Prevent self-deletion
    if (
      user.auth_user_id === req.platformAdminContext?.authUserId ||
      user._id === req.platformAdminContext?.adminId
    ) {
      throw new ConflictError('cannot delete your own account');
    }

    // Check if linked platform admin and prevent deleting the last active platform admin
    const linkedAdmin = await PlatformAdminModel.findOne({ auth_user_id: user.auth_user_id });
    if (linkedAdmin) {
      const activeAdmins = await PlatformAdminModel.countDocuments({ status: UserStatus.active });
      if (activeAdmins <= 1) {
        throw new ConflictError('cannot delete the last active platform administrator');
      }
      await PlatformAdminModel.deleteOne({ _id: linkedAdmin._id });
    }

    // Preserve all content: set user references to null so folders and documents remain intact
    await DocumentModel.updateMany({ uploaded_by: user._id }, { uploaded_by: null });
    await DocumentModel.updateMany({ deleted_by: user._id }, { deleted_by: null });

    // Remove memberships and quarry permissions
    await MembershipModel.deleteMany({ user_id: user._id });
    await QuarryPermissionModel.deleteMany({ user_id: user._id });

    const permanent = req.query.permanent === 'true' || req.query.hard === 'true';

    if (permanent) {
      // Permanently delete user
      await UserModel.findByIdAndDelete(user._id);

      await auditService.record({
        action: 'platform.user.delete',
        result: AuditResult.success,
        targetType: 'user',
        targetId: user._id,
        meta: { username: user.username, email: user.email, permanent: true },
        request: req,
      });

      res.json({
        id: user._id,
        status: 'deleted',
        detail: 'User permanently deleted successfully',
      });
    } else {
      user.status = UserStatus.inactive;
      user.tokens_revoked_at = new Date();
      user.active_session_id = null;
      await user.save();

      await auditService.record({
        action: 'platform.user.delete',
        result: AuditResult.success,
        targetType: 'user',
        targetId: user._id,
        meta: { username: user.username, email: user.email, permanent: false },
        request: req,
      });

      res.json({
        id: user._id,
        status: UserStatus.inactive,
        detail: 'User deactivated successfully',
      });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /platform/users/:id/role
 */
platformRouter.patch('/users/:id/role', async (req: Request, res: Response, next) => {
  try {
    const { role } = req.body;
    if (!['employee', 'company_admin', 'platform_admin'].includes(role)) {
      throw new DomainError('invalid role', 400);
    }

    const user = await UserModel.findById(req.params.id);
    if (!user) throw new NotFoundError('user not found');

    if (role === 'platform_admin') {
      await PlatformAdminModel.findOneAndUpdate(
        { auth_user_id: user.auth_user_id },
        {
          auth_user_id: user.auth_user_id,
          email: user.email || `${user.username}@quarryvault.internal`,
          full_name: user.full_name || user.username || 'Platform Admin',
          status: UserStatus.active,
        },
        { upsert: true }
      );
    } else {
      const membership = await MembershipModel.findOne({ user_id: user._id });
      const linkedAdmin = await PlatformAdminModel.findOne({ auth_user_id: user.auth_user_id });
      if (linkedAdmin) {
        if (!membership) {
          throw new DomainError('a platform administrator needs a company membership to be demoted; use PATCH /platform/users/:id with company_id', 400);
        }
        await assertPlatformAdminCanBeRemoved(user, req, 'demote');
        await PlatformAdminModel.deleteOne({ _id: linkedAdmin._id });
      }
      if (membership) {
        membership.role = role === 'company_admin' ? MembershipRole.company_admin : MembershipRole.employee;
        await membership.save();
      }
    }

    user.tokens_revoked_at = new Date();
    await user.save();

    res.json({ id: user._id, role });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/users/:id/reset-password
 */
platformRouter.post(['/users/:id/reset-password', '/platform/users/:id/reset-password'], async (req: Request, res: Response, next) => {
  try {
    const temporary_password = typeof req.body?.temporary_password === 'string'
      ? req.body.temporary_password
      : '';
    const confirm_password = typeof req.body?.confirm_password === 'string'
      ? req.body.confirm_password
      : '';
    if (!temporary_password) {
      throw new DomainError('temporary_password is required', 400);
    }
    if (temporary_password.length < 8) {
      throw new DomainError('temporary password must be at least 8 characters', 400);
    }
    if (!confirm_password || temporary_password !== confirm_password) {
      throw new DomainError('passwords do not match', 400);
    }

    const user = await UserModel.findById(req.params.id);
    if (!user) throw new NotFoundError('user not found');

    const hash = await bcrypt.hash(temporary_password, 10);
    user.password_hash = hash;
    user.must_change_password = true;
    user.tokens_revoked_at = new Date();
    await user.save();

    await auditService.record({
      action: 'platform.user.reset_password',
      result: AuditResult.success,
      targetType: 'user',
      targetId: user._id,
      request: req,
    });

    res.json({ status: 'ok', detail: 'Password reset successfully' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/users/:id/revoke-sessions
 */
platformRouter.post(['/users/:id/revoke-sessions', '/platform/users/:id/revoke-sessions'], async (req: Request, res: Response, next) => {
  try {
    const user = await UserModel.findByIdAndUpdate(
      req.params.id,
      { tokens_revoked_at: new Date() },
      { new: true }
    );
    if (!user) throw new NotFoundError('user not found');

    await auditService.record({
      action: 'platform.user.revoke_sessions',
      result: AuditResult.success,
      targetType: 'user',
      targetId: user._id,
      request: req,
    });

    res.json({ status: 'ok', detail: 'Sessions revoked' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/support-grants
 * Request scoped support access. The request is inert until another active Platform Admin approves it.
 */
platformRouter.post('/support-grants', async (req: Request, res: Response, next) => {
  try {
    const adminId = req.platformAdminContext!.adminId;
    const companyId = typeof req.body?.company_id === 'string' ? req.body.company_id.trim() : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const durationSeconds = Number(req.body?.duration_seconds);
    const rawScopes = req.body?.scopes;
    const allowedScopes = new Set<string>(Object.values(SupportGrantScope));
    if (!companyId) throw new DomainError('company_id is required', 400);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600) {
      throw new DomainError('duration_seconds must be an integer from 1 to 3600', 400);
    }
    if (reason.length < 5 || reason.length > 500) throw new DomainError('reason must be 5 to 500 characters', 400);
    if (!Array.isArray(rawScopes) || rawScopes.length === 0 || rawScopes.some((scope: unknown) => typeof scope !== 'string' || !allowedScopes.has(scope))) {
      throw new DomainError('scopes must contain document_metadata_read and/or document_download only', 400);
    }
    const scopes = [...new Set(rawScopes)] as SupportGrantScope[];
    const company = await CompanyModel.findById(companyId).lean();
    if (!company || company.status !== CompanyStatus.active) throw new NotFoundError('active company not found');

    const grant = await SupportGrantModel.create({
      company_id: company._id,
      requested_by_platform_admin_id: adminId,
      scopes,
      requested_duration_seconds: durationSeconds,
      reason,
      status: SupportGrantStatus.pending,
      requested_at: new Date(),
    });
    await auditService.record({
      action: 'platform.support_grant.requested',
      result: AuditResult.success,
      companyId: company._id,
      actorUserId: adminId,
      targetType: 'support_grant',
      targetId: grant._id,
      meta: { scopes, duration_seconds: durationSeconds, reason },
      request: req,
      raiseOnFailure: true,
    });
    res.status(201).json({
      id: grant._id,
      company_id: grant.company_id,
      status: grant.status,
      scopes: grant.scopes,
      duration_seconds: grant.requested_duration_seconds,
      reason: grant.reason,
      requested_by_platform_admin_id: grant.requested_by_platform_admin_id,
      requested_at: grant.requested_at,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /platform/support-grants */
platformRouter.get('/support-grants', async (req: Request, res: Response, next) => {
  try {
    const filter: Record<string, unknown> = {};
    if (typeof req.query.company_id === 'string') filter.company_id = req.query.company_id;
    if (typeof req.query.status === 'string') {
      if (!Object.values(SupportGrantStatus).includes(req.query.status as SupportGrantStatus)) {
        throw new DomainError('invalid support-grant status', 400);
      }
      filter.status = req.query.status;
    }
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit || '50'), 10) || 50, 100));
    const grants = await SupportGrantModel.find(filter).sort({ requested_at: -1 }).limit(limit).lean();
    res.json({ items: grants });
  } catch (err) {
    next(err);
  }
});

/** POST /platform/support-grants/:id/approve */
platformRouter.post('/support-grants/:id/approve', async (req: Request, res: Response, next) => {
  try {
    const approverId = req.platformAdminContext!.adminId;
    const pending = await SupportGrantModel.findById(req.params.id).lean();
    if (!pending) throw new NotFoundError('support grant not found');
    if (pending.status !== SupportGrantStatus.pending) throw new ConflictError('support grant is not pending');
    if (pending.requested_by_platform_admin_id === approverId) {
      throw new DomainError('a different active Platform Admin must approve this request', 403);
    }
    if (pending.requested_duration_seconds < 1 || pending.requested_duration_seconds > 3600 ||
        pending.scopes.length === 0 || pending.scopes.some((scope) => !Object.values(SupportGrantScope).includes(scope))) {
      throw new DomainError('support grant request is invalid', 400);
    }
    const requester = await PlatformAdminModel.findOne({
      _id: pending.requested_by_platform_admin_id,
      status: UserStatus.active,
    }).lean();
    if (!requester) throw new ForbiddenError('requesting Platform Admin is no longer active');
    const company = await CompanyModel.findOne({ _id: pending.company_id, status: CompanyStatus.active }).lean();
    if (!company) throw new ForbiddenError('target company is not active');

    const approvedAt = new Date();
    const expiresAt = new Date(approvedAt.getTime() + pending.requested_duration_seconds * 1000);
    const grant = await SupportGrantModel.findOneAndUpdate(
      { _id: pending._id, status: SupportGrantStatus.pending, requested_by_platform_admin_id: { $ne: approverId } },
      { $set: { status: SupportGrantStatus.active, approved_by_platform_admin_id: approverId, approved_at: approvedAt, expires_at: expiresAt } },
      { new: true }
    ).lean();
    if (!grant) throw new ConflictError('support grant was changed or approved by another administrator');

    try {
      await auditService.record({
        action: 'platform.support_grant.approved',
        result: AuditResult.success,
        companyId: grant.company_id,
        actorUserId: approverId,
        targetType: 'support_grant',
        targetId: grant._id,
        meta: { requested_by_platform_admin_id: grant.requested_by_platform_admin_id, scopes: grant.scopes, expires_at: grant.expires_at, reason: grant.reason },
        request: req,
        raiseOnFailure: true,
      });
    } catch (auditError) {
      await SupportGrantModel.findOneAndUpdate(
        { _id: grant._id, status: SupportGrantStatus.active, approved_by_platform_admin_id: approverId },
        { $set: { status: SupportGrantStatus.revoked, revoked_at: new Date() } }
      ).catch(() => null);
      throw auditError;
    }
    res.json({ id: grant._id, status: grant.status, scopes: grant.scopes, approved_at: grant.approved_at, expires_at: grant.expires_at });
  } catch (err) {
    next(err);
  }
});

/** DELETE /platform/support-grants/:id */
platformRouter.delete('/support-grants/:id', async (req: Request, res: Response, next) => {
  try {
    const adminId = req.platformAdminContext!.adminId;
    const grant = await SupportGrantModel.findOneAndUpdate(
      { _id: req.params.id, status: { $in: [SupportGrantStatus.pending, SupportGrantStatus.active] } },
      { $set: { status: SupportGrantStatus.revoked, revoked_at: new Date() } },
      { new: true }
    ).lean();
    if (!grant) throw new NotFoundError('pending or active support grant not found');
    await auditService.record({
      action: 'platform.support_grant.revoked',
      result: AuditResult.success,
      companyId: grant.company_id,
      actorUserId: adminId,
      targetType: 'support_grant',
      targetId: grant._id,
      meta: { requested_by_platform_admin_id: grant.requested_by_platform_admin_id, approved_by_platform_admin_id: grant.approved_by_platform_admin_id || null, reason: grant.reason },
      request: req,
      raiseOnFailure: true,
    });
    res.json({ id: grant._id, status: grant.status, revoked_at: grant.revoked_at });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/audit
 */
platformRouter.get('/audit', async (req: Request, res: Response, next) => {
  try {
    const parsePositiveInt = (value: unknown, fallback: number, maximum: number) => {
      if (value === undefined || value === '') return fallback;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new DomainError('invalid pagination value', 400);
      return Math.min(parsed, maximum);
    };
    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parseDateBound = (value: unknown, endExclusive = false): Date | null => {
      if (value === undefined || value === '') return null;
      const input = String(value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
        const [year, month, day] = input.split('-').map(Number);
        const date = new Date(Date.UTC(year, month - 1, day + (endExclusive ? 1 : 0)));
        const check = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
        if (check !== input) throw new DomainError('invalid audit date filter', 400);
        return date;
      }
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) {
        throw new DomainError('invalid audit date filter', 400);
      }
      const date = new Date(input);
      if (Number.isNaN(date.getTime())) throw new DomainError('invalid audit date filter', 400);
      return date;
    };
    const pageRequested = parsePositiveInt(req.query.page, 1, 1000000);
    const limit = parsePositiveInt(req.query.limit, 25, 100);
    const { result, search } = req.query;
    const filter: Record<string, any> = {};

    const companyIdFilter = String(req.query.company_id || '').trim();
    if (companyIdFilter) {
      if (companyIdFilter.length > 128) throw new DomainError('invalid audit company filter', 400);
      filter.company_id = companyIdFilter;
    }

    if (result !== undefined && result !== '') {
      const validResults = [AuditResult.success, AuditResult.denied, AuditResult.failure];
      if (!validResults.includes(String(result) as AuditResult)) throw new DomainError('invalid audit result filter', 400);
      filter.result = result;
    }

    const actionGroup = String(req.query.action_group || '').trim();
    const actionPrefixes: Record<string, string[]> = {
      auth: ['auth.'],
      platform: ['platform.'],
      company: ['company.', 'platform.company.', 'platform.user.'],
      quarry: ['quarry.', 'company.quarry.', 'platform.quarry.'],
      document: ['document.', 'platform.document.'],
      backup: ['backup.', 'restore.', 'platform.backup.', 'platform.restore.'],
      app_release: ['app_release.', 'platform.app_release.'],
    };
    if (actionGroup && !actionPrefixes[actionGroup]) throw new DomainError('invalid audit action filter', 400);
    if (actionGroup) {
      const prefixExpression = `^(?:${actionPrefixes[actionGroup].map(escapeRegex).join('|')})`;
      filter.action = { $regex: prefixExpression, $options: 'i' };
    }

    const from = parseDateBound(req.query.from);
    const toExclusive = parseDateBound(req.query.to, true);
    if (from && toExclusive && from >= toExclusive) throw new DomainError('audit date range is invalid', 400);
    if (from || toExclusive) {
      filter.created_at = {
        ...(from ? { $gte: from } : {}),
        ...(toExclusive ? { $lt: toExclusive } : {}),
      };
    }

    const searchText = String(search || '').trim().slice(0, 100);
    if (searchText) {
      const expression = new RegExp(escapeRegex(searchText), 'i');
      const [matchingUsers, matchingCompanies] = await Promise.all([
        UserModel.find({ $or: [{ username: expression }, { full_name: expression }, { email: expression }] })
          .select({ _id: 1, auth_user_id: 1 }).limit(100).lean(),
        CompanyModel.find({ name: expression }).select({ _id: 1 }).limit(100).lean(),
      ]);
      const actorIds = matchingUsers.flatMap((user) => [String(user._id), user.auth_user_id].filter(Boolean));
      const companyIds = matchingCompanies.map((company) => String(company._id));
      filter.$or = [
        { action: expression },
        { target_type: expression },
        { target_id: expression },
        { actor_user_id: expression },
        { company_id: expression },
        ...(actorIds.length ? [{ actor_user_id: { $in: actorIds } }] : []),
        ...(companyIds.length ? [{ company_id: { $in: companyIds } }] : []),
      ];
    }

    const total = await AuditEventModel.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(pageRequested, pages);
    const items = await AuditEventModel.find(filter)
      .sort({ created_at: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const actorIds = [...new Set(items.map((item) => item.actor_user_id).filter(Boolean).map(String))];
    const companyIds = [...new Set(items.map((item) => item.company_id).filter(Boolean).map(String))];
    const [actors, platformAdmins, companies] = await Promise.all([
      actorIds.length
        ? UserModel.find({ $or: [{ _id: { $in: actorIds } }, { auth_user_id: { $in: actorIds } }] })
            .select({ _id: 1, auth_user_id: 1, username: 1, full_name: 1 }).lean()
        : [],
      actorIds.length
        ? PlatformAdminModel.find({ $or: [{ _id: { $in: actorIds } }, { auth_user_id: { $in: actorIds } }] })
            .select({ _id: 1, auth_user_id: 1, full_name: 1, email: 1 }).lean()
        : [],
      companyIds.length ? CompanyModel.find({ _id: { $in: companyIds } }).select({ _id: 1, name: 1 }).lean() : [],
    ]);
    const actorNames = new Map<string, string>();
    for (const actor of actors) {
      const name = actor.full_name || actor.username;
      if (name) {
        actorNames.set(String(actor._id), name);
        if (actor.auth_user_id) actorNames.set(actor.auth_user_id, name);
      }
    }
    for (const admin of platformAdmins) {
      const name = admin.full_name || admin.email;
      if (name) {
        actorNames.set(String(admin._id), name);
        if (admin.auth_user_id) actorNames.set(admin.auth_user_id, name);
      }
    }
    const companyNames = new Map(companies.map((company) => [String(company._id), company.name]));
    const safeMetaKeys = new Set([
      'company_name', 'quarry_name', 'status', 'role', 'scope', 'version_code', 'permanent',
      'document_count', 'quarry_count', 'user_count', 'quota_bytes', 'max_users', 'size_bytes',
      'reason_code', 'reason', 'old_status', 'new_status', 'expires_at',
    ]);
    const projectSafeMeta = (meta: unknown): Record<string, string | number | boolean> => {
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
      const safe: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
        if (!safeMetaKeys.has(key)) continue;
        if (key === 'reason' && (typeof value !== 'string' || !/^[a-z0-9_.:-]{1,100}$/i.test(value))) continue;
        if (typeof value === 'string' && value.length <= 120) safe[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
        else if (typeof value === 'boolean') safe[key] = value;
      }
      return safe;
    };

    res.json({
      total,
      page,
      pages,
      limit,
      items: items.map((item) => ({
        id: item._id,
        timestamp: item.created_at,
        company_id: item.company_id || null,
        company_name: item.company_id ? companyNames.get(item.company_id) || null : null,
        actor_id: item.actor_user_id || null,
        actor_name: item.actor_user_id ? actorNames.get(item.actor_user_id) || null : null,
        action: item.action,
        target_type: item.target_type || null,
        target_id: item.target_id || null,
        result: item.result,
        ip_address: item.ip || null,
        metadata: projectSafeMeta(item.meta),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/alerts
 */
platformRouter.get('/alerts', async (_req: Request, res: Response, next) => {
  try {
    const checkedAt = new Date();
    const timestamp = checkedAt.toISOString();
    const alerts: Array<{ id: string; level: 'critical' | 'warning' | 'info'; title: string; message: string; timestamp: string }> = [];

    let databaseReady = mongoose.connection.readyState === 1;
    if (databaseReady) {
      try {
        if (mongoose.connection.db) await mongoose.connection.db.admin().ping();
      } catch {
        databaseReady = false;
      }
    }
    if (!databaseReady) {
      alerts.push({
        id: 'database-connectivity',
        level: 'critical',
        title: 'قاعدة البيانات غير متاحة',
        message: 'فشل فحص اتصال قاعدة البيانات. توقفت بقية الفحوصات المعتمدة عليها.',
        timestamp,
      });
    } else {
      let storageAvailable = true;
      try {
        await storage.exists('health-check-probe');
      } catch {
        storageAvailable = false;
      }
      if (!storageAvailable) {
        alerts.push({
          id: 'storage-connectivity',
          level: 'critical',
          title: 'مخزن الملفات غير متاح',
          message: 'تعذر إكمال فحص القراءة لمخزن الملفات. راجع اتصال التخزين وإعداداته.',
          timestamp,
        });
      }

      const companies = await CompanyModel.find({ status: CompanyStatus.active })
        .select({ _id: 1, name: 1, quota_bytes: 1, used_bytes: 1 }).lean();
      const activeCompanyIds = companies.map((company) => String(company._id));
      const [documentUsage, versionUsage] = await Promise.all([
        DocumentModel.aggregate([
          { $match: { company_id: { $in: activeCompanyIds }, status: { $in: [DocumentStatus.pending, DocumentStatus.available] } } },
          { $group: { _id: '$company_id', bytes: { $sum: '$size_bytes' } } },
        ]),
        DocumentVersionModel.aggregate([
          { $match: { company_id: { $in: activeCompanyIds } } },
          { $group: { _id: '$company_id', bytes: { $sum: '$size_bytes' } } },
        ]),
      ]);
      const actualBytes = new Map<string, number>();
      for (const row of [...documentUsage, ...versionUsage]) {
        const id = String(row._id);
        actualBytes.set(id, (actualBytes.get(id) || 0) + Number(row.bytes || 0));
      }
      for (const company of companies) {
        const quota = Number(company.quota_bytes || 0);
        if (quota <= 0) continue;
        const tracked = Number(company.used_bytes || 0);
        const used = Math.max(tracked, actualBytes.get(String(company._id)) || 0);
        const percent = (used / quota) * 100;
        if (percent < 90) continue;
        const rounded = Math.round(percent * 10) / 10;
        alerts.push({
          id: `quota-${company._id}`,
          level: percent >= 100 ? 'critical' : 'warning',
          title: percent >= 100 ? 'الحصة التخزينية مستنفدة' : 'اقتراب استنفاد الحصة التخزينية',
          message: `الشركة «${company.name}»: استخدام مقدّر ${rounded}% (${Math.round(used).toLocaleString('ar')} من ${Math.round(quota).toLocaleString('ar')} بايت).`,
          timestamp,
        });
      }

      const authWindowStart = new Date(checkedAt.getTime() - 15 * 60 * 1000);
      const failedAuthCount = await AuditEventModel.countDocuments({
        action: /^auth\./,
        result: { $in: [AuditResult.denied, AuditResult.failure] },
        created_at: { $gte: authWindowStart },
      });
      if (failedAuthCount >= 10) {
        alerts.push({
          id: 'auth-failures-15m',
          level: failedAuthCount >= 25 ? 'critical' : 'warning',
          title: 'ارتفاع محاولات المصادقة المرفوضة',
          message: `سُجلت ${failedAuthCount.toLocaleString('ar')} محاولات دخول/مصادقة فاشلة أو مرفوضة خلال آخر 15 دقيقة.`,
          timestamp,
        });
      }
    }

    const severityOrder = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => severityOrder[a.level] - severityOrder[b.level] || a.id.localeCompare(b.id));
    res.json({ checked_at: timestamp, items: alerts.slice(0, 50) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/releases
 */
platformRouter.get('/releases', async (_req: Request, res: Response, next) => {
  try {
    const releases = await AppReleaseModel.find().sort({ version_code: -1 }).lean();
    res.json(
      releases.map((r) => {
        const isMand = r.update_policy === 'mandatory' || r.update_required === true;
        return {
          id: r._id,
          _id: r._id,
          version_code: r.version_code,
          version_name: r.version_name,
          release_notes: r.release_notes || null,
          minimum_supported_version_code: r.minimum_supported_version_code ?? 1,
          min_supported_version: r.minimum_supported_version_code ?? 1,
          update_policy: isMand ? 'mandatory' : 'optional',
          update_required: isMand,
          is_mandatory: isMand,
          apk_filename: r.apk_filename,
          apk_size_bytes: r.apk_size_bytes,
          file_size_bytes: r.apk_size_bytes,
          sha256: r.sha256,
          sha256_checksum: r.sha256,
          is_withdrawn: r.is_withdrawn,
          published_by: r.published_by || null,
          created_at: r.created_at,
          published_at: r.created_at,
          download_url: `/app/updates/download/${r.version_code}`,
          apk_url: `/app/updates/download/${r.version_code}`,
        };
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/releases
 */
platformRouter.post('/releases', apkUpload.single('file'), async (req: Request, res: Response, next) => {
  try {
    const file = req.file;
    if (!file) throw new DomainError('APK file is required', 400);

    // 1. File size validation
    if (!file.buffer || file.size <= 0) {
      throw new DomainError('APK file cannot be empty', 400);
    }
    if (file.size > 150 * 1024 * 1024) {
      throw new DomainError('APK file size exceeds 150 MB limit', 400);
    }

    // 2. Format validation (ZIP/APK magic header PK\x03\x04)
    const isZip = file.buffer.length >= 4 &&
      file.buffer[0] === 0x50 && file.buffer[1] === 0x4b &&
      file.buffer[2] === 0x03 && file.buffer[3] === 0x04;
    if (!isZip) {
      throw new DomainError('Invalid APK file format: file must be a valid Android application package (ZIP/APK)', 400);
    }

    // 3. Extension validation
    const originalName = file.originalname || '';
    if (!originalName.toLowerCase().endsWith('.apk')) {
      throw new DomainError('Uploaded file must have a .apk extension', 400);
    }

    // 4. Version & metadata validation
    const versionCode = parseInt(req.body.version_code, 10);
    const versionName = (req.body.version_name || '').trim();
    const releaseNotes = req.body.release_notes ? req.body.release_notes.trim() : null;

    if (isNaN(versionCode) || versionCode <= 0) {
      throw new DomainError('Valid positive version_code is required', 400);
    }
    if (!versionName) {
      throw new DomainError('Valid version_name is required', 400);
    }

    // Explicit Update Policy: Default to 'optional' unless explicitly chosen as 'mandatory'
    let updatePolicy: 'optional' | 'mandatory' = 'optional';
    if (
      req.body.update_policy === 'mandatory' ||
      req.body.update_required === 'true' ||
      req.body.update_required === true ||
      req.body.is_mandatory === 'true' ||
      req.body.is_mandatory === true
    ) {
      updatePolicy = 'mandatory';
    }
    const updateRequired = updatePolicy === 'mandatory';

    // Minimum supported version code:
    // If explicitly provided, parse and validate it.
    // If NOT provided, maintain existing active minimum supported version (or 1), NEVER default to versionCode!
    let minCode: number;
    const rawMin = req.body.minimum_supported_version_code !== undefined && req.body.minimum_supported_version_code !== '' && req.body.minimum_supported_version_code !== null
      ? req.body.minimum_supported_version_code
      : req.body.min_supported_version;

    if (rawMin !== undefined && rawMin !== '' && rawMin !== null) {
      minCode = parseInt(String(rawMin), 10);
    } else {
      const previousActive = await AppReleaseModel.findOne({ is_withdrawn: false }).sort({ version_code: -1 }).lean();
      minCode = (previousActive && previousActive.minimum_supported_version_code && previousActive.minimum_supported_version_code < (previousActive.version_code || versionCode))
        ? previousActive.minimum_supported_version_code
        : 1;
    }

    if (isNaN(minCode) || minCode <= 0) {
      throw new DomainError('Valid positive minimum_supported_version_code is required', 400);
    }
    if (minCode > versionCode) {
      throw new DomainError('minimum_supported_version_code cannot exceed version_code', 400);
    }
    if (updatePolicy === 'optional' && minCode >= versionCode && versionCode > 1) {
      throw new DomainError('An optional release cannot set minimum_supported_version_code equal to or greater than version_code', 400);
    }

    const existing = await AppReleaseModel.findOne({ version_code: versionCode });
    if (existing) throw new ConflictError(`Release with versionCode ${versionCode} already exists`);

    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const storageKey = `releases/${versionCode}/${originalName || `app-v${versionCode}.apk`}`;

    await storage.put(file.buffer, storageKey, {
      contentType: 'application/vnd.android.package-archive',
      sizeBytes: file.size,
    });

    let release;
    try {
      release = await AppReleaseModel.create({
        version_code: versionCode,
        version_name: versionName,
        release_notes: releaseNotes,
        minimum_supported_version_code: minCode,
        update_required: updateRequired,
        update_policy: updatePolicy,
        apk_filename: originalName || `app-v${versionCode}.apk`,
        apk_size_bytes: file.size,
        sha256,
        storage_ref: storageKey,
        is_withdrawn: false,
        published_by: req.platformAdminContext!.adminId,
      });
    } catch (dbErr) {
      // Compensate: Delete uploaded storage artifact if metadata creation fails
      await storage.delete(storageKey).catch(() => {});
      throw dbErr;
    }

    await auditService.record({
      action: 'app_release.publish',
      result: AuditResult.success,
      actorUserId: req.platformAdminContext!.adminId,
      targetId: String(release._id),
      targetType: 'app_release',
      meta: {
        version_code: versionCode,
        version_name: versionName,
        minimum_supported_version_code: minCode,
        update_policy: updatePolicy,
        update_required: updateRequired,
        sha256,
        size_bytes: file.size,
      },
    });

    res.status(201).json({
      id: release._id,
      _id: release._id,
      version_code: release.version_code,
      version_name: release.version_name,
      release_notes: release.release_notes,
      minimum_supported_version_code: release.minimum_supported_version_code,
      min_supported_version: release.minimum_supported_version_code,
      update_policy: updatePolicy,
      update_required: updateRequired,
      is_mandatory: updateRequired,
      apk_filename: release.apk_filename,
      apk_size_bytes: release.apk_size_bytes,
      file_size_bytes: release.apk_size_bytes,
      sha256: release.sha256,
      sha256_checksum: release.sha256,
      is_withdrawn: release.is_withdrawn,
      published_by: release.published_by,
      created_at: release.created_at,
      published_at: release.created_at,
      download_url: `/app/updates/download/${release.version_code}`,
      apk_url: `/app/updates/download/${release.version_code}`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/releases/:id/withdraw
 */
platformRouter.post('/releases/:id/withdraw', async (req: Request, res: Response, next) => {
  try {
    const release = await AppReleaseModel.findByIdAndUpdate(
      req.params.id,
      { is_withdrawn: true },
      { new: true }
    );
    if (!release) throw new NotFoundError('release not found');

    if (release.storage_ref) {
      await storage.delete(release.storage_ref).catch((err) => {
        console.warn(`[Release Withdrawal] Storage delete warning for ${release.storage_ref}:`, err);
      });
    }

    await auditService.record({
      action: 'app_release.withdraw',
      result: AuditResult.success,
      actorUserId: req.platformAdminContext!.adminId,
      targetId: String(release._id),
      targetType: 'app_release',
      meta: {
        version_code: release.version_code,
        apk_deleted: true,
      },
    });

    const isMand = release.update_policy === 'mandatory' || release.update_required === true;
    res.json({
      id: release._id,
      _id: release._id,
      version_code: release.version_code,
      version_name: release.version_name,
      release_notes: release.release_notes,
      minimum_supported_version_code: release.minimum_supported_version_code,
      min_supported_version: release.minimum_supported_version_code,
      update_policy: isMand ? 'mandatory' : 'optional',
      update_required: isMand,
      is_mandatory: isMand,
      apk_filename: release.apk_filename,
      apk_size_bytes: release.apk_size_bytes,
      file_size_bytes: release.apk_size_bytes,
      sha256: release.sha256,
      sha256_checksum: release.sha256,
      is_withdrawn: release.is_withdrawn,
      published_by: release.published_by,
      created_at: release.created_at,
      published_at: release.created_at,
      download_url: `/app/updates/download/${release.version_code}`,
      apk_url: `/app/updates/download/${release.version_code}`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /platform/releases/:id
 * Allows authorized administrators to change update policy (optional vs mandatory),
 * minimum supported version code, and release notes.
 */
platformRouter.patch(['/releases/:id', '/platform/releases/:id'], async (req: Request, res: Response, next) => {
  try {
    const release = await AppReleaseModel.findById(req.params.id);
    if (!release) throw new NotFoundError('release not found');

    const updates: any = {};
    const previousPolicy = release.update_policy || (release.update_required ? 'mandatory' : 'optional');

    if (req.body.update_policy !== undefined || req.body.update_required !== undefined || req.body.is_mandatory !== undefined) {
      let targetPolicy: 'optional' | 'mandatory' = 'optional';
      if (
        req.body.update_policy === 'mandatory' ||
        req.body.update_required === true ||
        req.body.update_required === 'true' ||
        req.body.is_mandatory === true ||
        req.body.is_mandatory === 'true'
      ) {
        targetPolicy = 'mandatory';
      } else if (
        req.body.update_policy === 'optional' ||
        req.body.update_required === false ||
        req.body.update_required === 'false' ||
        req.body.is_mandatory === false ||
        req.body.is_mandatory === 'false'
      ) {
        targetPolicy = 'optional';
      } else {
        throw new DomainError('Invalid update_policy. Must be "optional" or "mandatory"', 400);
      }

      updates.update_policy = targetPolicy;
      updates.update_required = targetPolicy === 'mandatory';
    }

    if (req.body.minimum_supported_version_code !== undefined || req.body.min_supported_version !== undefined) {
      const minVal = req.body.minimum_supported_version_code !== undefined ? req.body.minimum_supported_version_code : req.body.min_supported_version;
      const minCode = parseInt(String(minVal), 10);
      if (isNaN(minCode) || minCode <= 0) {
        throw new DomainError('Valid positive minimum_supported_version_code is required', 400);
      }
      if (minCode > release.version_code) {
        throw new DomainError('minimum_supported_version_code cannot exceed version_code', 400);
      }
      const effectivePolicy = updates.update_policy || release.update_policy || (release.update_required ? 'mandatory' : 'optional');
      if (effectivePolicy === 'optional' && minCode >= release.version_code && release.version_code > 1) {
        throw new DomainError('An optional release cannot set minimum_supported_version_code equal to or greater than version_code', 400);
      }
      updates.minimum_supported_version_code = minCode;
    }

    if (req.body.release_notes !== undefined) {
      updates.release_notes = typeof req.body.release_notes === 'string' ? req.body.release_notes.trim() : null;
    }

    const updatedRelease = await AppReleaseModel.findByIdAndUpdate(release._id, updates, { new: true }).lean();
    if (!updatedRelease) throw new NotFoundError('release not found');

    await auditService.record({
      action: 'app_release.update_policy',
      result: AuditResult.success,
      actorUserId: req.platformAdminContext!.adminId,
      targetId: String(updatedRelease._id),
      targetType: 'app_release',
      meta: {
        version_code: updatedRelease.version_code,
        previous_policy: previousPolicy,
        new_policy: updatedRelease.update_policy,
        update_required: updatedRelease.update_required,
        minimum_supported_version_code: updatedRelease.minimum_supported_version_code,
      },
      request: req,
    });

    const isMand = updatedRelease.update_policy === 'mandatory' || updatedRelease.update_required === true;
    res.json({
      id: updatedRelease._id,
      _id: updatedRelease._id,
      version_code: updatedRelease.version_code,
      version_name: updatedRelease.version_name,
      release_notes: updatedRelease.release_notes,
      minimum_supported_version_code: updatedRelease.minimum_supported_version_code,
      min_supported_version: updatedRelease.minimum_supported_version_code,
      update_policy: isMand ? 'mandatory' : 'optional',
      update_required: isMand,
      is_mandatory: isMand,
      apk_filename: updatedRelease.apk_filename,
      apk_size_bytes: updatedRelease.apk_size_bytes,
      file_size_bytes: updatedRelease.apk_size_bytes,
      sha256: updatedRelease.sha256,
      sha256_checksum: updatedRelease.sha256,
      is_withdrawn: updatedRelease.is_withdrawn,
      published_by: updatedRelease.published_by,
      created_at: updatedRelease.created_at,
      published_at: updatedRelease.created_at,
      download_url: `/app/updates/download/${updatedRelease.version_code}`,
      apk_url: `/app/updates/download/${updatedRelease.version_code}`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /platform/releases/:id
 * Permanently removes release metadata AND physically deletes the APK artifact from storage
 */
platformRouter.delete(['/releases/:id', '/platform/releases/:id'], async (req: Request, res: Response, next) => {
  try {
    const release = await AppReleaseModel.findById(req.params.id);
    if (!release) throw new NotFoundError('release not found');

    const storageRef = release.storage_ref;
    const versionCode = release.version_code;

    if (storageRef) {
      await storage.delete(storageRef).catch((err) => {
        console.warn(`[Release Deletion] Storage delete warning for ${storageRef}:`, err);
      });
    }

    await AppReleaseModel.findByIdAndDelete(release._id);

    await auditService.record({
      action: 'app_release.delete',
      result: AuditResult.success,
      actorUserId: req.platformAdminContext!.adminId,
      targetId: String(release._id),
      targetType: 'app_release',
      meta: {
        version_code: versionCode,
        apk_deleted: true,
        storage_ref: storageRef,
      },
      request: req,
    });

    res.json({
      status: 'deleted',
      message: 'Release and APK artifact permanently deleted',
      version_code: versionCode,
    });
  } catch (err) {
    next(err);
  }
});
