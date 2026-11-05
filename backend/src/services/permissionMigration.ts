import { MembershipModel, QuarryModel, QuarryPermissionModel } from '../database/models/index.js';
import { MembershipRole, QuarryStatus } from '../types/index.js';

/**
 * Safe, idempotent migration from per-quarry operational permissions
 * to company-wide operational permissions + independent quarry visibility.
 */
export async function migrateToCompanyWidePermissions(): Promise<{ totalEmployees: number; migrated: number }> {
  const employeeMemberships = await MembershipModel.find({ role: MembershipRole.employee }).lean();
  let migrated = 0;

  for (const m of employeeMemberships) {
    // If already fully migrated with company-wide permissions, skip
    if (
      (m as any).can_view !== undefined &&
      (m as any).can_upload !== undefined &&
      (m as any).can_download !== undefined &&
      (m as any).can_delete !== undefined &&
      Array.isArray((m as any).hidden_quarries)
    ) {
      continue;
    }

    const companyQuarries = await QuarryModel.find({
      company_id: m.company_id,
      status: QuarryStatus.active,
    }).lean();

    const perms = await QuarryPermissionModel.find({
      user_id: m.user_id,
      quarry_id: { $in: companyQuarries.map((q) => q._id) },
    }).lean();

    const permMap = new Map(perms.map((p) => [p.quarry_id, p]));
    const hiddenQuarries: string[] = [];

    let hasAnyView = false;
    let hasAnyUpload = false;
    let hasAnyDownload = false;
    let hasAnyDelete = false;

    if (perms.length === 0) {
      // Default employee permissions per requirement
      hasAnyView = true;
      hasAnyUpload = true;
      hasAnyDownload = true;
      hasAnyDelete = false;
    } else {
      for (const q of companyQuarries) {
        const p = permMap.get(q._id);
        if (p) {
          if (!p.can_view) {
            hiddenQuarries.push(q._id);
          } else {
            hasAnyView = true;
            if (p.can_upload) hasAnyUpload = true;
            if (p.can_download) hasAnyDownload = true;
            if (p.can_delete) hasAnyDelete = true;
          }
        } else {
          // If no specific quarry permission record, active employee had default view/upload/download
          hasAnyView = true;
          hasAnyUpload = true;
          hasAnyDownload = true;
        }
      }
    }

    await MembershipModel.findByIdAndUpdate(m._id, {
      $set: {
        can_view: hasAnyView,
        can_upload: hasAnyUpload,
        can_download: hasAnyDownload,
        can_delete: hasAnyDelete,
        hidden_quarries: hiddenQuarries,
      },
    });
    migrated++;
  }

  if (migrated > 0) {
    console.log(`[PermissionMigration] Migrated ${migrated} of ${employeeMemberships.length} employees to company-wide permissions.`);
  }

  return { totalEmployees: employeeMemberships.length, migrated };
}
