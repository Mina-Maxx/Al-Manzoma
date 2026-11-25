import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { formatUserOut } from '../auth/router.js';
import { getCompanyUsage } from '../../services/quota.js';
import { UserModel } from '../../database/models/index.js';
import { DomainError, ForbiddenError, NotFoundError } from '../../middleware/errors.js';
import { auditService } from '../audit/service.js';
import { AuditResult, MembershipRole } from '../../types/index.js';

export const usersRouter = Router();

usersRouter.get('/me', authenticate, async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const isPlatformAdmin = (ctx.role as string) === 'platform_admin';
    const isCompanyAdmin = ctx.role === MembershipRole.company_admin || (ctx.role as string) === 'company_admin';
    const usage = ctx.companyId ? await getCompanyUsage(ctx.companyId) : null;
    const membership = ctx.membership;

    const effectivePermissions = {
      can_view: isPlatformAdmin || isCompanyAdmin || (membership?.can_view ?? true),
      can_upload: isPlatformAdmin || isCompanyAdmin || (membership?.can_upload ?? true),
      can_download: isPlatformAdmin || isCompanyAdmin || (membership?.can_download ?? false),
      can_delete: isPlatformAdmin || isCompanyAdmin || Boolean(membership?.can_delete),
    };

    res.json({
      user: formatUserOut(ctx.user, isPlatformAdmin),
      company: ctx.company
        ? {
            id: ctx.company._id,
            name: ctx.company.name,
            status: ctx.company.status,
            quota_bytes: ctx.company.quota_bytes,
            max_users: ctx.company.max_users,
            used_bytes: usage ? usage.usedBytes : 0,
          }
        : null,
      role: ctx.role,
      permissions: effectivePermissions,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /me or /users/me
 * Allows authenticated user to update their own display name (full_name).
 * Strictly forbids modifying role, company, password, status, or any elevated privileges.
 */
usersRouter.patch(['/me', '/users/me'], authenticate, async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const fullNameRaw = req.body.full_name !== undefined ? req.body.full_name : req.body.fullName;

    if (fullNameRaw === undefined) {
      throw new DomainError('اسم المستخدم الكامل مطلوب (full_name)', 400);
    }

    const trimmed = String(fullNameRaw || '').trim();
    if (trimmed.length < 2 || trimmed.length > 100) {
      throw new DomainError('يجب أن يكون الاسم بين 2 و 100 حرف', 400);
    }

    // Guard against privilege escalation attempts
    if (
      req.body.role !== undefined ||
      req.body.is_superadmin !== undefined ||
      req.body.isSuperAdmin !== undefined ||
      req.body.company_id !== undefined ||
      req.body.companyId !== undefined ||
      req.body.password !== undefined ||
      req.body.password_hash !== undefined ||
      req.body.status !== undefined
    ) {
      throw new ForbiddenError('غير مسموح بتعديل الصلاحيات أو البيانات الحساسة عبر هذا المسار');
    }

    const user = await UserModel.findById(ctx.userId);
    if (!user) {
      throw new NotFoundError('المستخدم غير موجود');
    }

    user.full_name = trimmed;
    await user.save();

    await auditService.record({
      action: 'user.update_profile',
      result: AuditResult.success,
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      targetType: 'user',
      targetId: user._id,
      meta: { full_name: trimmed },
      request: req,
    });

    const isPlatformAdmin = (ctx.role as string) === 'platform_admin';
    res.json({
      user: formatUserOut(user, isPlatformAdmin),
      message: 'تم تحديث الاسم بنجاح',
    });
  } catch (err) {
    next(err);
  }
});
