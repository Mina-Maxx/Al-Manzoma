import { connectDatabase, disconnectDatabase } from '../database/connection.js';
import { UserModel, PlatformAdminModel } from '../database/models/index.js';

async function diagnose() {
  console.log('====================================================');
  console.log('QuarryVault Authentication & Identity Diagnostics');
  console.log('Mode: READ-ONLY (No changes will be made)');
  console.log('====================================================\n');

  try {
    await connectDatabase();

    // 1. Check PlatformAdmin records
    const platformAdmins = await PlatformAdminModel.find().lean();
    console.log(`[PlatformAdminModel] Total authority documents: ${platformAdmins.length}`);
    for (const pa of platformAdmins) {
      console.log(`  - ID: ${pa._id}`);
      console.log(`    auth_user_id: ${pa.auth_user_id}`);
      console.log(`    email: ${pa.email || '(none)'}`);
      console.log(`    full_name: ${pa.full_name || '(none)'}`);
      console.log(`    status: ${pa.status}`);

      // Check linked UserModel record
      const linkedUser = await UserModel.findOne({ auth_user_id: pa.auth_user_id }).lean();
      if (linkedUser) {
        console.log(`    -> Linked UserModel: FOUND (${linkedUser.username || linkedUser.email}) [ID: ${linkedUser._id}, status: ${linkedUser.status}]`);
      } else {
        console.log(`    -> Linked UserModel: MISSING (Orphaned platform admin authority!)`);
      }
    }

    console.log('');

    // 2. Check UserModel for 'superadmin' and admin accounts
    const superadminUser = await UserModel.findOne({
      $or: [{ username: 'superadmin' }, { normalized_username: 'superadmin' }],
    }).lean();

    if (superadminUser) {
      console.log(`[UserModel] 'superadmin' User document: FOUND`);
      console.log(`  - ID: ${superadminUser._id}`);
      console.log(`  - auth_user_id: ${superadminUser.auth_user_id}`);
      console.log(`  - username: ${superadminUser.username}`);
      console.log(`  - email: ${superadminUser.email}`);
      console.log(`  - status: ${superadminUser.status}`);
      console.log(`  - must_change_password: ${superadminUser.must_change_password}`);
      console.log(`  - has_password_hash: ${Boolean(superadminUser.password_hash)}`);

      // Verify whether authority document exists in PlatformAdminModel
      const authorityDoc = await PlatformAdminModel.findOne({ auth_user_id: superadminUser.auth_user_id }).lean();
      if (authorityDoc) {
        console.log(`  -> PlatformAdminModel authority document: FOUND (Properly linked)`);
      } else {
        console.log(`  -> PlatformAdminModel authority document: MISSING! (User exists but cannot access /platform/*)`);
      }
    } else {
      console.log(`[UserModel] 'superadmin' User document: NOT FOUND`);
    }

    console.log('');

    // 3. Check for Duplicate or Conflicting Records
    const duplicateAuthUserIds = await UserModel.aggregate([
      { $group: { _id: '$auth_user_id', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    if (duplicateAuthUserIds.length > 0) {
      console.log(`[ALERT] Found ${duplicateAuthUserIds.length} duplicate auth_user_id values in UserModel!`);
    } else {
      console.log(`[Integrity] No duplicate auth_user_id entries in UserModel.`);
    }

    const duplicateUsernames = await UserModel.aggregate([
      { $match: { normalized_username: { $ne: null } } },
      { $group: { _id: '$normalized_username', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    if (duplicateUsernames.length > 0) {
      console.log(`[ALERT] Found ${duplicateUsernames.length} duplicate usernames in UserModel!`);
    } else {
      console.log(`[Integrity] No duplicate usernames in UserModel.`);
    }

    console.log('\n====================================================');
    console.log('Diagnostic Summary:');
    const isSuperadminComplete = Boolean(
      superadminUser &&
      (await PlatformAdminModel.findOne({ auth_user_id: superadminUser.auth_user_id }))
    );
    if (isSuperadminComplete) {
      console.log('STATUS: READY. Platform Admin identity and authority are properly linked.');
    } else {
      console.log('STATUS: REPAIR NEEDED. Run "npm run bootstrap:admin" to establish/repair the Platform Admin.');
    }
    console.log('====================================================\n');
  } catch (error) {
    console.error('[Diagnostic Error]', error);
  } finally {
    await disconnectDatabase();
  }
}

diagnose();
