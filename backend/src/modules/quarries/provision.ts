import mongoose from 'mongoose';
import { Request } from 'express';
import {
  CompanyModel,
  UserModel,
  MembershipModel,
  QuarryModel,
  FolderModel,
} from '../../database/models/index.js';
import {
  AuditResult,
  CompanyStatus,
  MembershipRole,
  QuarryStatus,
  STANDARD_FOLDERS,
  UserStatus,
} from '../../types/index.js';
import { resolveQuarryPermission } from '../../middleware/auth.js';
import { ConflictError, DomainError, ForbiddenError } from '../../middleware/errors.js';
import { auditService } from '../audit/service.js';

export interface ProvisionQuarryInput {
  actorUserId: string;
  actorRole: string;
  companyId: string;
  name: string;
  quarryNumber?: string | null;
  quarryType?: string | null;
  request: Request;
}

export interface ProvisionedQuarry {
  id: string;
  company_id: string;
  name: string;
  quarry_number: string | null;
  quarry_type: string | null;
  status: QuarryStatus;
  permissions: {
    can_view: boolean;
    can_upload: boolean;
    can_download: boolean;
    can_delete: boolean;
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Provisions a quarry, its standard folders, and its success audit event as one
 * MongoDB transaction. Authorization is re-read inside the transaction so the
 * selected company, active user, and membership cannot be trusted from a stale
 * request context alone.
 */
export async function provisionQuarry(input: ProvisionQuarryInput): Promise<ProvisionedQuarry> {
  const name = input.name.trim();
  const quarryNumber = input.quarryNumber?.trim() || null;
  const quarryType = input.quarryType?.trim() || null;
  if (!name) throw new DomainError('اسم المحجر مطلوب', 400);
  if (name.length > 200) throw new DomainError('اسم المحجر طويل جدًا', 400);

  let attemptedQuarryId: string | null = null;
  let provisioned: ProvisionedQuarry | null = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const user = await UserModel.findOne({ _id: input.actorUserId, status: UserStatus.active }).session(session).lean();
      const company = await CompanyModel.findOne({ _id: input.companyId, status: CompanyStatus.active }).session(session).lean();
      const membership = await MembershipModel.findOne({ user_id: input.actorUserId, company_id: input.companyId }).session(session).lean();

      if (!user || !company || !membership || membership.company_id !== input.companyId) {
        throw new ForbiddenError('active membership in the selected company is required');
      }
      if (input.actorRole === 'platform_admin') {
        throw new ForbiddenError('Platform Admins cannot create tenant quarries');
      }
      const isCompanyAdmin = membership.role === MembershipRole.company_admin;
      const isAuthorizedEmployee = membership.role === MembershipRole.employee && membership.can_upload === true;
      if (!isCompanyAdmin && !isAuthorizedEmployee) {
        throw new ForbiddenError('active same-company membership with can_upload=true is required to create a quarry');
      }

      const existingName = await QuarryModel.findOne({
        company_id: input.companyId,
        name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
      }).session(session).lean();
      if (existingName) throw new ConflictError('اسم المحجر مسجل بالفعل لهذه الشركة');

      if (quarryNumber) {
        const existingNumber = await QuarryModel.findOne({
          company_id: input.companyId,
          quarry_number: { $regex: new RegExp(`^${escapeRegex(quarryNumber)}$`, 'i') },
        }).session(session).lean();
        if (existingNumber) throw new ConflictError('رقم المحجر مسجل بالفعل لهذه الشركة');
      }

      const [quarry] = await QuarryModel.create([{
        company_id: input.companyId,
        name,
        quarry_number: quarryNumber,
        quarry_type: quarryType,
        status: QuarryStatus.active,
      }], { session });
      attemptedQuarryId = String(quarry._id);

      await FolderModel.insertMany(
        STANDARD_FOLDERS.map((folder) => ({
          company_id: input.companyId,
          quarry_id: quarry._id,
          parent_id: null,
          name: folder.name,
          is_standard: true,
          standard_order: folder.order,
          standard_key: folder.key,
          version: 1,
        })),
        { session, ordered: true },
      );

      const permissions = isCompanyAdmin
        ? { can_view: true, can_upload: true, can_download: true, can_delete: true }
        : {
            can_view: resolveQuarryPermission('can_view', membership),
            can_upload: resolveQuarryPermission('can_upload', membership),
            can_download: resolveQuarryPermission('can_download', membership),
            can_delete: resolveQuarryPermission('can_delete', membership),
          };

      await auditService.record({
        action: 'quarry.create',
        result: AuditResult.success,
        companyId: input.companyId,
        actorUserId: input.actorUserId,
        targetType: 'quarry',
        targetId: quarry._id,
        meta: { name, quarry_number: quarryNumber, quarry_type: quarryType },
        request: input.request,
        session,
        raiseOnFailure: true,
      });

      provisioned = {
        id: String(quarry._id),
        company_id: input.companyId,
        name: quarry.name,
        quarry_number: quarry.quarry_number || null,
        quarry_type: quarry.quarry_type || null,
        status: quarry.status,
        permissions,
      };
    });
  } catch (error) {
    const denied = error instanceof ForbiddenError;
    await auditService.record({
      action: 'quarry.create',
      result: denied ? AuditResult.denied : AuditResult.failure,
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      targetType: 'quarry',
      targetId: attemptedQuarryId,
      meta: { reason: error instanceof Error ? error.name : 'UnknownError' },
      request: input.request,
    });
    throw error;
  } finally {
    await session.endSession();
  }

  if (!provisioned) throw new Error('quarry provisioning transaction completed without a result');
  return provisioned;
}
