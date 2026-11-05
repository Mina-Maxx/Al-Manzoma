import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import {
  UserModel,
  CompanyModel,
  MembershipModel,
  QuarryModel,
  QuarryPermissionModel,
  AuditEventModel,
  FolderModel,
  DocumentModel,
  DocumentVersionModel,
  IdempotencyKeyModel,
  UploadReconciliationModel,
  ChangeLogModel,
} from '../../database/models/index.js';
import {
  UserStatus,
  MembershipRole,
  QuarryStatus,
  AuditResult,
} from '../../types/index.js';
import { authenticate, requireCompanyAdmin } from '../../middleware/auth.js';
import { DomainError, NotFoundError, ConflictError, ForbiddenError } from '../../middleware/errors.js';
import { getCompanyUsage } from '../../services/quota.js';
import { auditService } from '../audit/service.js';
import { storage } from '../storage/index.js';
import { formatQuarryDisplayName, escapeRegex } from '../quarries/router.js';
import { provisionQuarry } from '../quarries/provision.js';

export const companiesRouter = Router();

// Enforce authenticate and requireCompanyAdmin for all company management routes
companiesRouter.use('/company', authenticate, requireCompanyAdmin);

/**
 * GET /company/employees
 */
companiesRouter.get('/company/employees', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const memberships = await MembershipModel.find({ company_id: ctx.companyId }).lean();
    const userIds = memberships.map((m) => m.user_id);
    const users = await UserModel.find({ _id: { $in: userIds } }).lean();
    const userMap = new Map(users.map((u) => [u._id, u]));

    const out = memberships
      .map((m) => {
        const u = userMap.get(m.user_id);
        if (!u) return null;
        return {
          id: u._id,
          username: u.username || null,
          email: u.email || null,
          full_name: u.full_name || null,
          status: u.status,
          role: m.role,
          must_change_password: Boolean(u.must_change_password),
          permissions: {
            can_view: m.can_view ?? true,
            can_upload: m.can_upload ?? true,
            can_download: m.can_download ?? true,
            can_delete: m.can_delete ?? false,
          },
          hidden_quarries: m.hidden_quarries || [],
        };
      })
      .filter(Boolean);

    // Deterministic Arabic/English alphabetical sorting for employees
    out.sort((a: any, b: any) => {
      const nameA = a.full_name || a.username || '';
      const nameB = b.full_name || b.username || '';
      return nameA.localeCompare(nameB, ['ar', 'en'], { sensitivity: 'base', numeric: true });
    });

    res.json(out);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /company/employees or /company/:company_id/employees
 * Creates an employee with direct credentials & initial quarry permissions
 */
companiesRouter.post(['/company/employees', '/company/:company_id/employees'], async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const { username, password, email, full_name, fullName, quarry_permissions, default_access_all_quarries } = req.body;
    const finalFullName = (typeof full_name === 'string' ? full_name : typeof fullName === 'string' ? fullName : '').trim() || null;

    const plainPassword = typeof password === 'string' ? password : '';
    if (!plainPassword) {
      throw new DomainError('password is required', 400);
    }
    if (plainPassword.length < 8) {
      throw new DomainError('password must be at least 8 characters', 400);
    }

    // Check company max_users capacity
    const currentCount = await MembershipModel.countDocuments({ company_id: ctx.companyId });
    if (currentCount >= ctx.company.max_users) {
      throw new ConflictError('company has reached maximum users capacity');
    }

    const normalizeFlag = (value: unknown, fallback: boolean, field: string): boolean => {
      if (value === undefined) return fallback;
      if (typeof value !== 'boolean') throw new DomainError(`${field} must be a boolean`, 400);
      return value;
    };
    const permissionsInput = req.body.permissions;
    const canView = normalizeFlag(permissionsInput?.can_view ?? req.body.can_view, true, 'can_view');
    const canUpload = normalizeFlag(permissionsInput?.can_upload ?? req.body.can_upload, true, 'can_upload');
    const canDownload = normalizeFlag(permissionsInput?.can_download ?? req.body.can_download, true, 'can_download');
    const canDelete = normalizeFlag(permissionsInput?.can_delete ?? req.body.can_delete, false, 'can_delete');

    const rawHiddenQuarries = req.body.hidden_quarries ?? req.body.hiddenQuarries ?? [];
    if (!Array.isArray(rawHiddenQuarries) || rawHiddenQuarries.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new DomainError('hidden_quarries must be an array of quarry IDs', 400);
    }
    const hiddenQuarriesInput: string[] = [...new Set(rawHiddenQuarries.map((id: string) => id.trim()))];

    if (quarry_permissions !== undefined && !Array.isArray(quarry_permissions)) {
      throw new DomainError('quarry_permissions must be an array', 400);
    }
    const seenQuarryPermissions = new Set<string>();
    const normalizedQuarryPermissions = (Array.isArray(quarry_permissions) ? quarry_permissions : []).map((permission: any) => {
      if (!permission || typeof permission.quarry_id !== 'string' || !permission.quarry_id.trim()) {
        throw new DomainError('each quarry permission requires a quarry_id', 400);
      }
      const quarryId = permission.quarry_id.trim();
      if (seenQuarryPermissions.has(quarryId)) throw new DomainError('duplicate quarry assignment', 400);
      seenQuarryPermissions.add(quarryId);
      return {
        quarry_id: quarryId,
        can_view: normalizeFlag(permission.can_view, true, 'quarry can_view'),
        can_upload: normalizeFlag(permission.can_upload, false, 'quarry can_upload'),
        can_download: normalizeFlag(permission.can_download, false, 'quarry can_download'),
        can_delete: normalizeFlag(permission.can_delete, false, 'quarry can_delete'),
      };
    });

    const companyPermissionFlags = {
      can_view: canView,
      can_upload: canUpload,
      can_download: canDownload,
      can_delete: canDelete,
    };
    if (normalizedQuarryPermissions.some((permission) =>
      (Object.keys(companyPermissionFlags) as Array<keyof typeof companyPermissionFlags>)
        .some((field) => permission[field] && !companyPermissionFlags[field])
    )) {
      throw new DomainError('quarry permissions cannot grant beyond company membership permissions', 400);
    }

    const normalizedEmail = email ? String(email).trim().toLowerCase() : '';
    if (email !== undefined && !normalizedEmail) throw new DomainError('email must not be blank', 400);
    if ((ctx.role as string) === 'platform_admin') {
      if (!normalizedEmail) throw new DomainError('email is required for employee creation', 400);
      if (normalizedQuarryPermissions.length === 0) {
        throw new DomainError('at least one quarry assignment is required', 400);
      }
    }

    if (normalizedQuarryPermissions.some((permission) => hiddenQuarriesInput.includes(permission.quarry_id))) {
      throw new DomainError('a quarry cannot be both assigned and hidden', 400);
    }

    const referencedQuarryIds = [...new Set([
      ...hiddenQuarriesInput,
      ...normalizedQuarryPermissions.map((permission) => permission.quarry_id),
    ])];
    let referencedQuarries: any[] = [];
    if (referencedQuarryIds.length) {
      try {
        referencedQuarries = await QuarryModel.find({
          _id: { $in: referencedQuarryIds },
          company_id: ctx.companyId,
        }).select('_id status').lean();
      } catch (err: any) {
        if (err?.name === 'CastError') throw new DomainError('invalid quarry ID', 400);
        throw err;
      }
    }
    if (referencedQuarries.length !== referencedQuarryIds.length) {
      throw new NotFoundError('one or more quarries do not belong to the selected company');
    }
    const quarryById = new Map(referencedQuarries.map((quarry) => [String(quarry._id), quarry]));
    if (normalizedQuarryPermissions.some((permission) => quarryById.get(permission.quarry_id)?.status !== QuarryStatus.active)) {
      throw new ConflictError('employees can only be assigned to active quarries');
    }

    const trimmedUsername = username ? String(username).trim() : '';
    let normalizedUsername: string | null = null;
    if (trimmedUsername) {
      normalizedUsername = trimmedUsername.toLowerCase();
      const escapedUsername = escapeRegex(normalizedUsername);
      const existing = await UserModel.findOne({
        $or: [
          { normalized_username: normalizedUsername },
          { username: { $regex: new RegExp(`^${escapedUsername}$`, 'i') } },
        ],
      });
      if (existing) {
        throw new ConflictError('username is already taken');
      }
    }

    if (username !== undefined && !trimmedUsername) throw new DomainError('username must not be blank', 400);
    if (!normalizedUsername && !normalizedEmail) throw new DomainError('username or email is required', 400);

    if (normalizedEmail) {
      const existingEmail = await UserModel.findOne({ email: normalizedEmail });
      if (existingEmail) {
        throw new ConflictError('email is already registered');
      }
    }

    const passwordHash = await bcrypt.hash(plainPassword, 10);
    const authUserId = uuidv4();
    let user: any;
    let membership: any;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const targetCompany = await CompanyModel.findById(ctx.companyId).session(session).lean();
        if (!targetCompany || targetCompany.status !== 'active') {
          throw new ForbiddenError('selected company is not active');
        }
        const transactionalCount = await MembershipModel.countDocuments({ company_id: ctx.companyId }).session(session);
        if (transactionalCount >= targetCompany.max_users) {
          throw new ConflictError('company has reached maximum users capacity');
        }
        if (referencedQuarryIds.length) {
          const currentQuarries = await QuarryModel.find({
            _id: { $in: referencedQuarryIds },
            company_id: ctx.companyId,
          }).select('_id status').session(session).lean();
          if (currentQuarries.length !== referencedQuarryIds.length) {
            throw new NotFoundError('one or more quarries do not belong to the selected company');
          }
          const activeIds = new Set(currentQuarries.filter((quarry) => quarry.status === QuarryStatus.active).map((quarry) => String(quarry._id)));
          if (normalizedQuarryPermissions.some((permission) => !activeIds.has(permission.quarry_id))) {
            throw new ConflictError('employees can only be assigned to active quarries');
          }
        }

        [user] = await UserModel.create([{
          auth_user_id: authUserId,
          username: trimmedUsername || null,
          normalized_username: normalizedUsername,
          email: normalizedEmail || null,
          password_hash: passwordHash,
          full_name: finalFullName,
          status: UserStatus.active,
          must_change_password: true,
        }], { session });
        [membership] = await MembershipModel.create([{
          user_id: user._id,
          company_id: ctx.companyId,
          role: MembershipRole.employee,
          can_view: canView,
          can_upload: canUpload,
          can_download: canDownload,
          can_delete: canDelete,
          hidden_quarries: hiddenQuarriesInput,
        }], { session });

        if (Array.isArray(quarry_permissions) && normalizedQuarryPermissions.length > 0) {
          await QuarryPermissionModel.insertMany(normalizedQuarryPermissions.map((permission) => ({
            user_id: user._id,
            quarry_id: permission.quarry_id,
            can_view: permission.can_view,
            can_upload: permission.can_upload,
            can_download: permission.can_download,
            can_delete: permission.can_delete,
          })), { session, ordered: true });
        } else if (quarry_permissions === undefined && default_access_all_quarries) {
          const activeQuarries = await QuarryModel.find({ company_id: ctx.companyId, status: QuarryStatus.active })
            .select('_id').session(session).lean();
          if (activeQuarries.length > 0) {
            await QuarryPermissionModel.insertMany(activeQuarries.map((quarry) => ({
              user_id: user._id,
              quarry_id: quarry._id,
              can_view: true,
              can_upload: false,
              can_download: false,
              can_delete: false,
            })), { session, ordered: true });
          }
        }

        await auditService.record({
          action: 'employee.create',
          result: AuditResult.success,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'user',
          targetId: user._id,
          meta: { username: user.username, email: user.email },
          request: req,
          session,
          raiseOnFailure: true,
        });
      });
    } finally {
      await session.endSession();
    }

    res.status(201).json({
      id: user._id,
      username: user.username,
      email: user.email,
      full_name: user.full_name,
      status: user.status,
      role: MembershipRole.employee,
      must_change_password: user.must_change_password,
      permissions: {
        can_view: membership.can_view ?? true,
        can_upload: membership.can_upload ?? true,
        can_download: membership.can_download ?? true,
        can_delete: membership.can_delete ?? false,
      },
      hidden_quarries: membership.hidden_quarries || [],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Password resets are restricted to Platform Admins.
 * Keep this route explicit so existing company clients receive a clear denial.
 */
companiesRouter.post('/company/employees/:id/reset-password', (_req: Request, _res: Response, next) => {
  next(new ForbiddenError('Only Platform Admins can reset passwords'));
});

/**
 * POST /company/employees/:id/disable
 * Protected against disabling the last active company admin
 */
companiesRouter.post('/company/employees/:id/disable', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const targetUserId = req.params.id;

    const membership = await MembershipModel.findOne({ user_id: targetUserId, company_id: ctx.companyId });
    if (!membership) throw new NotFoundError('employee not found');

    if (membership.role === MembershipRole.company_admin) {
      const adminCount = await MembershipModel.countDocuments({
        company_id: ctx.companyId,
        role: MembershipRole.company_admin,
      });
      if (adminCount <= 1) {
        throw new ConflictError('cannot disable the last company administrator');
      }
    }

    const user = await UserModel.findByIdAndUpdate(
      targetUserId,
      { status: UserStatus.inactive, tokens_revoked_at: new Date() },
      { new: true }
    );
    if (!user) throw new NotFoundError('employee not found');

    await auditService.record({
      action: 'employee.disable',
      result: AuditResult.success,
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      targetType: 'user',
      targetId: user._id,
      request: req,
    });

    res.json({ id: user._id, status: user.status });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /company/employees/:id and /company/:company_id/employees/:id
 */
companiesRouter.patch(['/company/employees/:id', '/company/:company_id/employees/:id'], async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const targetUserId = req.params.id;
    const { username, email, full_name, fullName } = req.body;

    const membership = await MembershipModel.findOne({ user_id: targetUserId, company_id: ctx.companyId });
    if (!membership) throw new NotFoundError('employee not found');

    const user = await UserModel.findById(targetUserId);
    if (!user) throw new NotFoundError('employee not found');

    const finalFullName = full_name !== undefined ? full_name : fullName !== undefined ? fullName : undefined;
    if (finalFullName !== undefined) {
      user.full_name = finalFullName ? String(finalFullName).trim() : null;
    }

    if (username !== undefined) {
      const trimmed = username ? String(username).trim() : null;
      const normalized = trimmed ? trimmed.toLowerCase() : null;
      if (normalized) {
        const existing = await UserModel.findOne({ normalized_username: normalized, _id: { $ne: user._id } });
        if (existing) throw new ConflictError('username is already taken');
      }
      user.username = trimmed;
      user.normalized_username = normalized;
    }

    if (email !== undefined) {
      const trimmed = email ? String(email).trim().toLowerCase() : null;
      if (trimmed) {
        const existing = await UserModel.findOne({ email: trimmed, _id: { $ne: user._id } });
        if (existing) throw new ConflictError('email is already registered');
      }
      user.email = trimmed;
    }

    await user.save();

    // Handle company-wide operational permissions and quarry visibility updates
    let membershipModified = false;
    if (req.body.permissions !== undefined) {
      if (req.body.permissions.can_view !== undefined) {
        membership.can_view = Boolean(req.body.permissions.can_view);
        membershipModified = true;
      }
      if (req.body.permissions.can_upload !== undefined) {
        membership.can_upload = Boolean(req.body.permissions.can_upload);
        membershipModified = true;
      }
      if (req.body.permissions.can_download !== undefined) {
        membership.can_download = Boolean(req.body.permissions.can_download);
        membershipModified = true;
      }
      if (req.body.permissions.can_delete !== undefined) {
        membership.can_delete = Boolean(req.body.permissions.can_delete);
        membershipModified = true;
      }
    }
    if (req.body.can_view !== undefined) {
      membership.can_view = Boolean(req.body.can_view);
      membershipModified = true;
    }
    if (req.body.can_upload !== undefined) {
      membership.can_upload = Boolean(req.body.can_upload);
      membershipModified = true;
    }
    if (req.body.can_download !== undefined) {
      membership.can_download = Boolean(req.body.can_download);
      membershipModified = true;
    }
    if (req.body.can_delete !== undefined) {
      membership.can_delete = Boolean(req.body.can_delete);
      membershipModified = true;
    }
    if (req.body.hidden_quarries !== undefined && Array.isArray(req.body.hidden_quarries)) {
      membership.hidden_quarries = req.body.hidden_quarries;
      membershipModified = true;
    } else if (req.body.hiddenQuarries !== undefined && Array.isArray(req.body.hiddenQuarries)) {
      membership.hidden_quarries = req.body.hiddenQuarries;
      membershipModified = true;
    }

    if (membershipModified) {
      await membership.save();
    }

    await auditService.record({
      action: 'employee.update',
      result: AuditResult.success,
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      targetType: 'user',
      targetId: user._id,
      meta: { username: user.username, email: user.email },
      request: req,
    });

    res.json({
      id: user._id,
      username: user.username,
      email: user.email,
      full_name: user.full_name,
      status: user.status,
      role: membership.role,
      permissions: {
        can_view: membership.can_view ?? true,
        can_upload: membership.can_upload ?? true,
        can_download: membership.can_download ?? true,
        can_delete: membership.can_delete ?? false,
      },
      hidden_quarries: membership.hidden_quarries || [],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /company/employees/:id and /company/:company_id/employees/:id
 */
companiesRouter.delete(['/company/employees/:id', '/company/:company_id/employees/:id'], async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const targetUserId = req.params.id;

    if (targetUserId === ctx.userId) {
      throw new ConflictError('cannot delete your own account');
    }

    const membership = await MembershipModel.findOne({ user_id: targetUserId, company_id: ctx.companyId });
    if (!membership) throw new NotFoundError('employee not found');

    if (membership.role === MembershipRole.company_admin) {
      const adminCount = await MembershipModel.countDocuments({
        company_id: ctx.companyId,
        role: MembershipRole.company_admin,
      });
      if (adminCount <= 1) {
        throw new ConflictError('cannot delete the last company administrator');
      }
    }

    const user = await UserModel.findById(targetUserId);
    if (!user) throw new NotFoundError('employee not found');

    // Preserve company content: null creator/deleter references so documents/folders remain intact
    await DocumentModel.updateMany({ uploaded_by: targetUserId }, { uploaded_by: null });
    await DocumentModel.updateMany({ deleted_by: targetUserId }, { deleted_by: null });

    await MembershipModel.deleteOne({ _id: membership._id });
    await QuarryPermissionModel.deleteMany({ user_id: targetUserId });

    const remainingMemberships = await MembershipModel.countDocuments({ user_id: targetUserId });
    const permanent = req.query.permanent === 'true' || req.query.hard === 'true';

    if (permanent) {
      if (remainingMemberships === 0) {
        await UserModel.findByIdAndDelete(targetUserId);
      } else {
        user.tokens_revoked_at = new Date();
        user.active_session_id = null;
        await user.save();
      }

      await auditService.record({
        action: 'employee.delete',
        result: AuditResult.success,
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        targetType: 'user',
        targetId: user._id,
        meta: { username: user.username, email: user.email, permanent: true },
        request: req,
      });

      res.json({
        id: user._id,
        status: 'deleted',
        detail: 'Employee removed and deleted successfully',
      });
    } else {
      user.status = UserStatus.inactive;
      user.tokens_revoked_at = new Date();
      user.active_session_id = null;
      await user.save();

      await auditService.record({
        action: 'employee.delete',
        result: AuditResult.success,
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        targetType: 'user',
        targetId: user._id,
        meta: { username: user.username, email: user.email, permanent: false },
        request: req,
      });

      res.json({
        id: user._id,
        status: 'inactive',
        detail: 'Employee removed and deactivated successfully',
      });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /company/employees/:id/enable
 */
companiesRouter.post('/company/employees/:id/enable', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const targetUserId = req.params.id;

    const membership = await MembershipModel.findOne({ user_id: targetUserId, company_id: ctx.companyId });
    if (!membership) throw new NotFoundError('employee not found');

    const user = await UserModel.findByIdAndUpdate(
      targetUserId,
      { status: UserStatus.active },
      { new: true }
    );
    if (!user) throw new NotFoundError('employee not found');

    await auditService.record({
      action: 'employee.enable',
      result: AuditResult.success,
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      targetType: 'user',
      targetId: user._id,
      request: req,
    });

    res.json({ id: user._id, status: user.status });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /company/quarries
 */
companiesRouter.get('/company/quarries', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const quarries = await QuarryModel.find({ company_id: ctx.companyId }).lean();
    quarries.sort((a, b) => a.name.localeCompare(b.name, 'ar', { sensitivity: 'base' }));
    res.json(
      quarries.map((q) => ({
        id: q._id,
        name: q.name,
        quarry_number: q.quarry_number || null,
        quarry_type: q.quarry_type || null,
        display_name: formatQuarryDisplayName(q.name, q.quarry_number, q.quarry_type),
        status: q.status,
      }))
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /company/quarries
 */
companiesRouter.post('/company/quarries', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const name = (req.body.name || '').trim();
    const quarryNumber = (req.body.quarry_number || req.body.quarryNumber || '').trim();
    const quarryType = (req.body.quarry_type || req.body.quarryType || '').trim();

    if (!name) throw new DomainError('quarry name is required', 400);

    const quarry = await provisionQuarry({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      companyId: ctx.companyId,
      name,
      quarryNumber: quarryNumber || null,
      quarryType: quarryType || null,
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
 * PATCH /company/quarries/:id
 */
companiesRouter.patch('/company/quarries/:id', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const quarry = await QuarryModel.findOne({ _id: req.params.id, company_id: ctx.companyId });
    if (!quarry) throw new NotFoundError('quarry not found');

    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) throw new DomainError('quarry name is required', 400);
      const duplicate = await QuarryModel.findOne({
        _id: { $ne: quarry._id },
        company_id: ctx.companyId,
        name: { $regex: new RegExp(`^${name}$`, 'i') },
      });
      if (duplicate) throw new ConflictError('quarry with this name already exists');
      quarry.name = name;
    }

    if (req.body.quarry_number !== undefined) {
      const qNum = String(req.body.quarry_number || '').trim();
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

    if (req.body.quarry_type !== undefined) {
      const qType = String(req.body.quarry_type || '').trim();
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
});

/**
 * POST /company/quarries/:id/deactivate
 */
companiesRouter.post('/company/quarries/:id/deactivate', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const quarry = await QuarryModel.findOneAndUpdate(
      { _id: req.params.id, company_id: ctx.companyId },
      { status: QuarryStatus.inactive },
      { new: true }
    );
    if (!quarry) throw new NotFoundError('quarry not found');
    await auditService.record({
      action: 'quarry.deactivate',
      result: AuditResult.success,
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      targetType: 'quarry',
      targetId: quarry._id,
      meta: { name: quarry.name },
      request: req,
    });
    res.json({ id: quarry._id, name: quarry.name, status: quarry.status });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /company/quarries/:id
 * Safe soft-delete / archival of quarry without deleting documents or audit records
 */
companiesRouter.delete('/company/quarries/:id', async (req: Request, res: Response, next) => {
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

    res.json({ id: quarry._id, name: quarry.name, status: quarry.status, message: 'تم تعطيل/أرشفة المحجر بنجاح' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /company/quarries/:id/reactivate
 */
companiesRouter.post('/company/quarries/:id/reactivate', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const quarry = await QuarryModel.findOneAndUpdate(
      { _id: req.params.id, company_id: ctx.companyId },
      { status: QuarryStatus.active },
      { new: true }
    );
    if (!quarry) throw new NotFoundError('quarry not found');
    await auditService.record({
      action: 'quarry.reactivate',
      result: AuditResult.success,
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      targetType: 'quarry',
      targetId: quarry._id,
      meta: { name: quarry.name },
      request: req,
    });
    res.json({ id: quarry._id, name: quarry.name, status: quarry.status });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /company/quarries/:id/permanent
 * Permanently removes one quarry and its stored files. Platform Admin only.
 */
companiesRouter.delete('/company/quarries/:id/permanent', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    if (ctx.role !== 'platform_admin' || !req.platformAdminContext) {
      throw new ForbiddenError('Platform Admin permission is required to permanently delete a quarry');
    }

    const quarry = await QuarryModel.findOne({ _id: req.params.id, company_id: ctx.companyId }).lean();
    if (!quarry) throw new NotFoundError('quarry not found');
    if (req.body?.confirmation !== quarry.name) {
      throw new ConflictError('type the exact quarry name to confirm permanent deletion');
    }

    const suspendSession = await mongoose.startSession();
    try {
      await suspendSession.withTransaction(async () => {
        const current = await QuarryModel.findOne({ _id: quarry._id, company_id: ctx.companyId }).session(suspendSession);
        if (!current) throw new NotFoundError('quarry not found');
        current.status = QuarryStatus.inactive;
        await current.save({ session: suspendSession });
        await auditService.record({
          action: 'quarry.permanent_delete_started',
          result: AuditResult.success,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'quarry',
          targetId: quarry._id,
          meta: { name: quarry.name },
          request: req,
          session: suspendSession,
          raiseOnFailure: true,
        });
      });
    } finally {
      await suspendSession.endSession();
    }

    const [documents, versions, pendingUploads, idempotencyRecords] = await Promise.all([
      DocumentModel.find({ company_id: ctx.companyId, quarry_id: quarry._id }).select('_id storage_ref').lean(),
      DocumentVersionModel.find({ company_id: ctx.companyId, quarry_id: quarry._id }).select('storage_ref').lean(),
      UploadReconciliationModel.find({ company_id: ctx.companyId, quarry_id: quarry._id }).select('storage_ref').lean(),
      IdempotencyKeyModel.find({ company_id: ctx.companyId, quarry_id: quarry._id }).select('storage_ref').lean(),
    ]);
    const storageRefs = [...new Set([
      ...documents.map((item) => item.storage_ref),
      ...versions.map((item) => item.storage_ref),
      ...pendingUploads.map((item) => item.storage_ref),
      ...idempotencyRecords.map((item) => item.storage_ref),
    ].filter((key): key is string => typeof key === 'string' && key.length > 0))];
    const safeCompanyId = ctx.companyId.replace(/[^a-zA-Z0-9-]/g, '');
    const safeQuarryId = quarry._id.replace(/[^a-zA-Z0-9-]/g, '');
    const quarryStoragePrefix = `company/${safeCompanyId}/quarry/${safeQuarryId}/`;
    if (storageRefs.some((key) => !key.startsWith(quarryStoragePrefix))) {
      throw new ConflictError('quarry deletion stopped because a stored file reference is outside this quarry namespace');
    }

    try {
      for (const storageRef of storageRefs) await storage.delete(storageRef);
    } catch (err) {
      console.error('[PlatformQuarryDelete] Storage cleanup failed; quarry remains archived:', err);
      throw new DomainError('quarry is archived, but some files could not be removed; retry deletion', 502);
    }

    const deleteSession = await mongoose.startSession();
    try {
      await deleteSession.withTransaction(async () => {
        const current = await QuarryModel.findOne({ _id: quarry._id, company_id: ctx.companyId }).session(deleteSession);
        if (!current || current.status !== QuarryStatus.inactive) {
          throw new ConflictError('quarry changed while deletion was in progress; retry the operation');
        }

        const documentsToDelete = await DocumentModel.find({ company_id: ctx.companyId, quarry_id: quarry._id })
          .select('size_bytes status').session(deleteSession).lean();
        const versionsToDelete = await DocumentVersionModel.find({ company_id: ctx.companyId, quarry_id: quarry._id })
          .select('size_bytes').session(deleteSession).lean();
        const company = await CompanyModel.findById(ctx.companyId).session(deleteSession);
        if (!company) throw new NotFoundError('company not found');
        const freedBytes = documentsToDelete.reduce(
          (total, document) => total + (['pending', 'available'].includes(document.status) ? document.size_bytes : 0),
          0
        ) + versionsToDelete.reduce((total, version) => total + version.size_bytes, 0);

        await MembershipModel.updateMany(
          { company_id: ctx.companyId },
          { $pull: { hidden_quarries: quarry._id } },
          { session: deleteSession }
        );
        await QuarryPermissionModel.deleteMany({ quarry_id: quarry._id }, { session: deleteSession });
        await FolderModel.deleteMany({ company_id: ctx.companyId, quarry_id: quarry._id }, { session: deleteSession });
        await DocumentModel.deleteMany({ company_id: ctx.companyId, quarry_id: quarry._id }, { session: deleteSession });
        await DocumentVersionModel.deleteMany({ company_id: ctx.companyId, quarry_id: quarry._id }, { session: deleteSession });
        await IdempotencyKeyModel.deleteMany({ company_id: ctx.companyId, quarry_id: quarry._id }, { session: deleteSession });
        await UploadReconciliationModel.deleteMany({ company_id: ctx.companyId, quarry_id: quarry._id }, { session: deleteSession });
        await ChangeLogModel.deleteMany({ company_id: ctx.companyId, quarry_id: quarry._id }, { session: deleteSession });

        if (freedBytes > 0) {
          company.used_bytes = Math.max(0, (company.used_bytes || 0) - freedBytes);
          await company.save({ session: deleteSession });
        }
        await QuarryModel.deleteOne({ _id: quarry._id, company_id: ctx.companyId }, { session: deleteSession });
        await auditService.record({
          action: 'quarry.permanent_delete',
          result: AuditResult.success,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'quarry',
          targetId: quarry._id,
          meta: { name: quarry.name, document_count: documentsToDelete.length, file_count: storageRefs.length, freed_bytes: freedBytes },
          request: req,
          session: deleteSession,
          raiseOnFailure: true,
        });
      });
    } finally {
      await deleteSession.endSession();
    }

    res.json({ id: quarry._id, status: 'deleted' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /company/permissions
 */
companiesRouter.get('/company/permissions', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const [memberships, quarries, perms] = await Promise.all([
      MembershipModel.find({ company_id: ctx.companyId }).lean(),
      QuarryModel.find({ company_id: ctx.companyId }).lean(),
      QuarryPermissionModel.find({
        quarry_id: { $in: (await QuarryModel.find({ company_id: ctx.companyId }).select('_id')).map((q) => q._id) },
      }).lean(),
    ]);

    const users = await UserModel.find({ _id: { $in: memberships.map((m) => m.user_id) } }).lean();
    const userMap = new Map(users.map((u) => [u._id, u]));

    const membersOut = memberships
      .map((m) => {
        const u = userMap.get(m.user_id);
        if (!u) return null;
        return {
          id: u._id,
          username: u.username || null,
          email: u.email || null,
          full_name: u.full_name || null,
          status: u.status,
          role: m.role,
          permissions: {
            can_view: m.can_view ?? true,
            can_upload: m.can_upload ?? true,
            can_download: m.can_download ?? true,
            can_delete: m.can_delete ?? false,
          },
          hidden_quarries: m.hidden_quarries || [],
        };
      })
      .filter(Boolean);

    // Deterministic Arabic/English alphabetical sorting for members
    membersOut.sort((a: any, b: any) => {
      const nameA = a.full_name || a.username || '';
      const nameB = b.full_name || b.username || '';
      return nameA.localeCompare(nameB, ['ar', 'en'], { sensitivity: 'base', numeric: true });
    });

    const sortedQuarries = quarries.map((q) => ({ id: q._id, name: q.name, status: q.status }));
    sortedQuarries.sort((a, b) => (a.name || '').localeCompare(b.name || '', ['ar', 'en'], { sensitivity: 'base', numeric: true }));

    res.json({
      members: membersOut,
      quarries: sortedQuarries,
      permissions: perms.map((p) => ({
        user_id: p.user_id,
        quarry_id: p.quarry_id,
        can_view: Boolean(p.can_view),
        can_upload: Boolean(p.can_upload),
        can_download: Boolean(p.can_download),
        can_delete: Boolean(p.can_delete),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /company/quarries/:id/permissions/:userId
 */
companiesRouter.put('/company/quarries/:id/permissions/:userId', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const { id: quarryId, userId } = req.params;
    const { can_view, can_upload, can_download, can_delete } = req.body;

    const requestedPermissions = { can_view, can_upload, can_download, can_delete };
    for (const [field, value] of Object.entries(requestedPermissions)) {
      if (typeof value !== 'boolean') throw new DomainError(`${field} must be a boolean`, 400);
    }
    let perm: any;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const quarry = await QuarryModel.findOne({ _id: quarryId, company_id: ctx.companyId }).session(session);
        if (!quarry) throw new NotFoundError('quarry not found');

        const membership = await MembershipModel.findOne({ user_id: userId, company_id: ctx.companyId }).session(session);
        if (!membership) throw new NotFoundError('user not found in company');

        const membershipDefaults: Record<string, boolean> = {
          can_view: true,
          can_upload: true,
          can_download: true,
          can_delete: false,
        };
        for (const field of Object.keys(requestedPermissions) as Array<keyof typeof requestedPermissions>) {
          if (requestedPermissions[field] && !(membership[field] ?? membershipDefaults[field])) {
            throw new DomainError('quarry permissions cannot grant beyond company membership permissions', 400);
          }
        }

        perm = await QuarryPermissionModel.findOneAndUpdate(
          { user_id: userId, quarry_id: quarryId },
          { $set: requestedPermissions },
          { new: true, upsert: true, runValidators: true, session }
        );

        await auditService.record({
          action: 'permission.update',
          result: AuditResult.success,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'quarry_permission',
          targetId: `${quarryId}:${userId}`,
          meta: {
            can_view: perm.can_view,
            can_upload: perm.can_upload,
            can_download: perm.can_download,
            can_delete: perm.can_delete,
          },
          request: req,
          session,
          raiseOnFailure: true,
        });
      });
    } finally {
      await session.endSession();
    }

    res.json({
      user_id: perm.user_id,
      quarry_id: perm.quarry_id,
      can_view: perm.can_view,
      can_upload: perm.can_upload,
      can_download: perm.can_download,
      can_delete: perm.can_delete,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /company/permissions
 * Update company-wide operational permissions and/or quarry visibility, or toggle legacy matrix
 */
companiesRouter.post('/company/permissions', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const { user_id, quarry_id, can_view, can_upload, can_download, can_delete, permissions, hidden_quarries, hiddenQuarries, quarry_permissions } = req.body;

    if (!user_id) {
      throw new DomainError('user_id is required', 400);
    }

    const membership = await MembershipModel.findOne({ user_id, company_id: ctx.companyId });
    if (!membership) throw new NotFoundError('user not found in company');

    // Case 1: Company-wide permission or visibility update
    const hasCompanyPermissionField = permissions !== undefined ||
      hidden_quarries !== undefined || hiddenQuarries !== undefined || quarry_permissions !== undefined ||
      (quarry_id === undefined && [can_view, can_upload, can_download, can_delete].some((value) => value !== undefined));
    if (hasCompanyPermissionField) {
      if (quarry_permissions !== undefined && !Array.isArray(quarry_permissions)) {
        throw new DomainError('quarry_permissions must be an array', 400);
      }
      const seenQuarryIds = new Set<string>();
      const normalizedQuarryPermissions = (Array.isArray(quarry_permissions) ? quarry_permissions : []).map((item: any) => {
        if (!item || typeof item.quarry_id !== 'string' || !item.quarry_id.trim()) {
          throw new DomainError('each quarry permission requires a quarry_id', 400);
        }
        const quarryId = item.quarry_id.trim();
        if (seenQuarryIds.has(quarryId)) throw new DomainError('duplicate quarry permission', 400);
        seenQuarryIds.add(quarryId);
        for (const field of ['can_view', 'can_upload', 'can_download', 'can_delete']) {
          if (typeof item[field] !== 'boolean') throw new DomainError(`${field} must be a boolean`, 400);
        }
        return {
          quarry_id: quarryId,
          can_view: item.can_view,
          can_upload: item.can_upload,
          can_download: item.can_download,
          can_delete: item.can_delete,
        };
      });

      const rawHiddenQuarries = hidden_quarries ?? hiddenQuarries;
      if (rawHiddenQuarries !== undefined && (
        !Array.isArray(rawHiddenQuarries) || rawHiddenQuarries.some((id) => typeof id !== 'string' || !id.trim())
      )) {
        throw new DomainError('hidden_quarries must be an array of quarry IDs', 400);
      }
      const normalizedHiddenQuarries: string[] | undefined = rawHiddenQuarries === undefined
        ? undefined
        : [...new Set((rawHiddenQuarries as string[]).map((id) => id.trim()))];
      const referencedIds = [...new Set([
        ...(normalizedHiddenQuarries || []),
        ...normalizedQuarryPermissions.map((item) => item.quarry_id),
      ])];

      const session = await mongoose.startSession();
      let updatedMembership: any;
      try {
        await session.withTransaction(async () => {
          updatedMembership = await MembershipModel.findOne({ user_id, company_id: ctx.companyId }).session(session);
          if (!updatedMembership) throw new NotFoundError('user not found in company');

          let referencedQuarries: any[] = [];
          if (referencedIds.length) {
            try {
              referencedQuarries = await QuarryModel.find({
                _id: { $in: referencedIds },
                company_id: ctx.companyId,
              }).select('_id status').session(session).lean();
            } catch (err: any) {
              if (err?.name === 'CastError') throw new DomainError('invalid quarry ID', 400);
              throw err;
            }
          }
          if (referencedQuarries.length !== referencedIds.length) {
            throw new NotFoundError('one or more quarries do not belong to the selected company');
          }
          const setFlag = (target: any, field: string, value: unknown) => {
            if (value === undefined) return;
            if (typeof value !== 'boolean') throw new DomainError(`${field} must be a boolean`, 400);
            target[field] = value;
          };
          const membershipDefaults: Record<string, boolean> = {
            can_view: true,
            can_upload: true,
            can_download: true,
            can_delete: false,
          };
          const previousMembershipFlags = {
            can_view: updatedMembership.can_view ?? membershipDefaults.can_view,
            can_upload: updatedMembership.can_upload ?? membershipDefaults.can_upload,
            can_download: updatedMembership.can_download ?? membershipDefaults.can_download,
            can_delete: updatedMembership.can_delete ?? membershipDefaults.can_delete,
          };
          if (permissions !== undefined && (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions))) {
            throw new DomainError('permissions must be an object', 400);
          }
          setFlag(updatedMembership, 'can_view', permissions?.can_view ?? (quarry_id === undefined ? can_view : undefined));
          setFlag(updatedMembership, 'can_upload', permissions?.can_upload ?? (quarry_id === undefined ? can_upload : undefined));
          setFlag(updatedMembership, 'can_download', permissions?.can_download ?? (quarry_id === undefined ? can_download : undefined));
          setFlag(updatedMembership, 'can_delete', permissions?.can_delete ?? (quarry_id === undefined ? can_delete : undefined));
          if (normalizedQuarryPermissions.some((item) =>
            (['can_view', 'can_upload', 'can_download', 'can_delete'] as const)
              .some((field) => item[field] && !(updatedMembership[field] ?? membershipDefaults[field]))
          )) {
            throw new DomainError('quarry permissions cannot grant beyond company membership permissions', 400);
          }
          const newlyDeniedFields = (['can_view', 'can_upload', 'can_download', 'can_delete'] as const)
            .filter((field) => previousMembershipFlags[field] && !(updatedMembership[field] ?? membershipDefaults[field]));
          if (newlyDeniedFields.length > 0) {
            const targetQuarries = await QuarryModel.find({ company_id: ctx.companyId }).select('_id').session(session).lean();
            const existingQuarryPermissions = targetQuarries.length
              ? await QuarryPermissionModel.find({
                  user_id,
                  quarry_id: { $in: targetQuarries.map((quarry) => quarry._id) },
                }).session(session).lean()
              : [];
            for (const existingPermission of existingQuarryPermissions) {
              const proposed = normalizedQuarryPermissions.find((item) => item.quarry_id === String(existingPermission.quarry_id));
              if (newlyDeniedFields.some((field) => existingPermission[field] === true && proposed?.[field] !== false)) {
                throw new ConflictError('review and explicitly clear conflicting quarry permissions before applying this company-level denial');
              }
            }
          }
          if (normalizedHiddenQuarries) updatedMembership.hidden_quarries = normalizedHiddenQuarries;
          await updatedMembership.save({ session });

          for (const item of normalizedQuarryPermissions) {
            await QuarryPermissionModel.findOneAndUpdate(
              { user_id, quarry_id: item.quarry_id },
              { $set: {
                can_view: item.can_view,
                can_upload: item.can_upload,
                can_download: item.can_download,
                can_delete: item.can_delete,
              } },
              { new: true, upsert: true, runValidators: true, session }
            );
          }

          await auditService.record({
            action: 'permission.company_and_quarry_update',
            result: AuditResult.success,
            companyId: ctx.companyId,
            actorUserId: ctx.userId,
            targetType: 'membership',
            targetId: updatedMembership._id,
            meta: {
              user_id,
              can_view: updatedMembership.can_view,
              can_upload: updatedMembership.can_upload,
              can_download: updatedMembership.can_download,
              can_delete: updatedMembership.can_delete,
              hidden_quarries: updatedMembership.hidden_quarries,
              quarry_permission_count: normalizedQuarryPermissions.length,
            },
            request: req,
            session,
            raiseOnFailure: true,
          });
        });
      } finally {
        await session.endSession();
      }

      return res.json({
        user_id,
        permissions: {
          can_view: updatedMembership.can_view,
          can_upload: updatedMembership.can_upload,
          can_download: updatedMembership.can_download,
          can_delete: updatedMembership.can_delete,
        },
        hidden_quarries: updatedMembership.hidden_quarries || [],
        quarry_permissions: normalizedQuarryPermissions,
      });
    }

    // Case 2: Legacy per-quarry permission update
    if (!quarry_id) {
      throw new DomainError('quarry_id is required for per-quarry update', 400);
    }

    const quarry = await QuarryModel.findOne({ _id: quarry_id, company_id: ctx.companyId });
    if (!quarry) throw new NotFoundError('quarry not found');

    const perm = await QuarryPermissionModel.findOneAndUpdate(
      { user_id, quarry_id },
      {
        can_view: Boolean(can_view),
        can_upload: Boolean(can_upload),
        can_download: Boolean(can_download),
        can_delete: Boolean(can_delete),
      },
      { new: true, upsert: true }
    );

    await auditService.record({
      action: 'permission.quarry_update',
      result: AuditResult.success,
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      targetType: 'quarry_permission',
      targetId: `${quarry_id}:${user_id}`,
      meta: {
        can_view: perm.can_view,
        can_upload: perm.can_upload,
        can_download: perm.can_download,
        can_delete: perm.can_delete,
      },
      request: req,
    });

    res.json({
      user_id: perm.user_id,
      quarry_id: perm.quarry_id,
      can_view: perm.can_view,
      can_upload: perm.can_upload,
      can_download: perm.can_download,
      can_delete: perm.can_delete,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /company/usage
 */
companiesRouter.get('/company/usage', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const usage = await getCompanyUsage(ctx.companyId);
    res.json({
      used_bytes: usage.usedBytes,
      quota_bytes: usage.quotaBytes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /company/audit
 */
companiesRouter.get('/company/audit', async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '50'), 10), 100));

    const total = await AuditEventModel.countDocuments({ company_id: ctx.companyId });
    const items = await AuditEventModel.find({ company_id: ctx.companyId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();

    res.json({
      total,
      items: items.map((i) => ({
        id: i._id,
        created_at: i.created_at,
        actor_user_id: i.actor_user_id || null,
        action: i.action,
        target_type: i.target_type || null,
        target_id: i.target_id || null,
        result: i.result,
        ip: i.ip || null,
        meta: i.meta || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});
