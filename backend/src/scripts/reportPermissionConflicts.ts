import mongoose from 'mongoose';
import { MembershipModel, QuarryModel, QuarryPermissionModel } from '../database/models/index.js';
import { MembershipRole } from '../types/index.js';

const permissionFields = ['can_view', 'can_upload', 'can_download', 'can_delete'] as const;
type PermissionField = (typeof permissionFields)[number];

async function main() {
  const uri = process.env.PERMISSION_REPORT_MONGODB_URI;
  if (!uri || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) {
    throw new Error('Set PERMISSION_REPORT_MONGODB_URI to an explicitly approved read-only MongoDB URI; no default database is used.');
  }

  await mongoose.connect(uri, {
    readPreference: 'secondaryPreferred',
    readConcern: { level: 'majority' },
    serverSelectionTimeoutMS: 10000,
  });

  try {
    const [memberships, quarries, legacyPermissions] = await Promise.all([
      MembershipModel.find({ role: MembershipRole.employee })
        .select({ _id: 1, user_id: 1, company_id: 1, can_view: 1, can_upload: 1, can_download: 1, can_delete: 1 })
        .read('secondaryPreferred')
        .lean(),
      QuarryModel.find().select({ _id: 1, company_id: 1 }).read('secondaryPreferred').lean(),
      QuarryPermissionModel.find()
        .select({ _id: 1, user_id: 1, quarry_id: 1, can_view: 1, can_upload: 1, can_download: 1, can_delete: 1 })
        .read('secondaryPreferred')
        .lean(),
    ]);

    const membershipMap = new Map(memberships.map((membership) => [`${membership.user_id}\u0000${membership.company_id}`, membership]));
    const quarryMap = new Map(quarries.map((quarry) => [quarry._id, quarry]));
    const conflicts: Array<Record<string, unknown>> = [];
    const orphanLegacyRecords: Array<Record<string, unknown>> = [];
    const counts: Record<string, number> = {
      legacy_true_cannot_grant: 0,
      legacy_false_restricts_membership_allow: 0,
      legacy_permission_without_same_company_membership: 0,
      legacy_permission_with_missing_quarry: 0,
    };

    for (const permission of legacyPermissions) {
      const quarry = quarryMap.get(permission.quarry_id);
      if (!quarry) {
        counts.legacy_permission_with_missing_quarry += 1;
        orphanLegacyRecords.push({ legacy_permission_id: permission._id, user_id: permission.user_id, quarry_id: permission.quarry_id, reason: 'quarry_missing' });
        continue;
      }
      const membership = membershipMap.get(`${permission.user_id}\u0000${quarry.company_id}`);
      if (!membership) {
        counts.legacy_permission_without_same_company_membership += 1;
        orphanLegacyRecords.push({ legacy_permission_id: permission._id, user_id: permission.user_id, quarry_id: permission.quarry_id, company_id: quarry.company_id, reason: 'same_company_employee_membership_missing' });
        continue;
      }

      for (const field of permissionFields) {
        const legacyValue = permission[field];
        const rawMembershipValue = membership[field] as boolean | undefined;
        if (legacyValue === true && rawMembershipValue !== true) {
          counts.legacy_true_cannot_grant += 1;
          conflicts.push({
            membership_id: membership._id,
            legacy_permission_id: permission._id,
            user_id: permission.user_id,
            company_id: quarry.company_id,
            quarry_id: quarry._id,
            permission: field satisfies PermissionField,
            membership_value: rawMembershipValue ?? null,
            legacy_value: true,
            effect: 'legacy_true_will_not_grant_access',
          });
        } else if (legacyValue === false && rawMembershipValue === true) {
          counts.legacy_false_restricts_membership_allow += 1;
          conflicts.push({
            membership_id: membership._id,
            legacy_permission_id: permission._id,
            user_id: permission.user_id,
            company_id: quarry.company_id,
            quarry_id: quarry._id,
            permission: field satisfies PermissionField,
            membership_value: true,
            legacy_value: false,
            effect: 'legacy_explicit_deny_continues_to_restrict_access',
          });
        }
      }
    }

    console.log(JSON.stringify({
      report_type: 'permission_conflicts_dry_run',
      generated_at: new Date().toISOString(),
      read_only: true,
      records_changed: 0,
      employee_memberships_examined: memberships.length,
      quarries_examined: quarries.length,
      legacy_permission_records_examined: legacyPermissions.length,
      conflict_count: conflicts.length,
      orphan_legacy_record_count: orphanLegacyRecords.length,
      counts,
      conflicts,
      orphan_legacy_records: orphanLegacyRecords,
      note: 'This report does not apply migrations or alter existing records. Review conflicts before enabling membership-first resolution.',
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`[PermissionConflictReport] ${error instanceof Error ? error.message : 'report failed'}`);
  process.exitCode = 1;
});
