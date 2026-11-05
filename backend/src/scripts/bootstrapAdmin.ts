import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../database/connection.js';
import { UserModel, PlatformAdminModel } from '../database/models/index.js';
import { UserStatus } from '../types/index.js';

export interface BootstrapAdminOptions {
  username?: string;
  email?: string;
  fullName?: string;
  password?: string;
  resetPassword?: boolean;
}

export interface BootstrapAdminResult {
  userId: string;
  authUserId: string;
  username: string;
  email: string;
  isNewUser: boolean;
  passwordUpdated: boolean;
  mustChangePassword: boolean;
  generatedPassword?: string;
  platformAdminId: string;
}

export async function bootstrapAdmin(options: BootstrapAdminOptions = {}): Promise<BootstrapAdminResult> {
  const isCliInvocation = Boolean(
    process.argv[1] &&
    (process.argv[1].endsWith('bootstrapAdmin.ts') || process.argv[1].endsWith('bootstrapAdmin.js'))
  );

  const username = (options.username || process.env.BOOTSTRAP_ADMIN_USERNAME || 'superadmin').trim();
  const normalizedUsername = username.toLowerCase();
  const email = (options.email || process.env.BOOTSTRAP_ADMIN_EMAIL || 'superadmin@quarryvault.internal').trim().toLowerCase();
  const fullName = options.fullName || process.env.BOOTSTRAP_ADMIN_NAME || 'Platform Superadmin';
  const customPassword = options.password ?? process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const resetRequested = Boolean(
    options.resetPassword ||
    process.env.RESET_ADMIN_PASSWORD === 'true' ||
    process.argv.includes('--reset-password')
  );

  if (mongoose.connection.readyState !== 1) {
    await connectDatabase();
  }

  // 1. Locate existing User document by normalized_username, raw username, or email
  let user = await UserModel.findOne({
    $or: [
      { normalized_username: normalizedUsername },
      { username: normalizedUsername },
      { username },
      { email },
    ],
  });

  let generatedPassword: string | undefined;
  let passwordUpdated = false;
  let mustChangePassword = false;
  let isNewUser = false;

  if (!user) {
    // Branch A: New User creation
    isNewUser = true;
    let initialPassword = customPassword;
    if (initialPassword) {
      mustChangePassword = false;
    } else {
      initialPassword = `QvAdmin!${crypto.randomBytes(6).toString('hex')}`;
      generatedPassword = initialPassword;
      mustChangePassword = true;
    }

    const passwordHash = await bcrypt.hash(initialPassword, 10);
    const authUserId = `auth-${uuidv4()}`;

    user = await UserModel.create({
      _id: uuidv4(),
      auth_user_id: authUserId,
      username,
      normalized_username: normalizedUsername,
      email,
      full_name: fullName,
      password_hash: passwordHash,
      status: UserStatus.active,
      must_change_password: mustChangePassword,
    });
    passwordUpdated = true;
    console.log(`[Bootstrap] Created new User: ${username} (auth_user_id: ${user.auth_user_id})`);
  } else {
    // Branch B: Existing User
    console.log(`[Bootstrap] Found existing User: ${user.username} (ID: ${user._id}, auth_user_id: ${user.auth_user_id})`);
    user.status = UserStatus.active;
    user.normalized_username = normalizedUsername; // ensure normalization is populated

    const shouldUpdatePassword = Boolean(
      customPassword ||
      resetRequested ||
      !user.password_hash
    );

    if (shouldUpdatePassword) {
      let newPassword = customPassword;
      if (newPassword) {
        mustChangePassword = false;
      } else {
        newPassword = `QvAdmin!${crypto.randomBytes(6).toString('hex')}`;
        generatedPassword = newPassword;
        mustChangePassword = true;
      }

      user.password_hash = await bcrypt.hash(newPassword, 10);
      user.must_change_password = mustChangePassword;
      user.tokens_revoked_at = new Date(); // safely revoke any prior sessions
      passwordUpdated = true;
      console.log(`[Bootstrap] Updated password and revoked existing sessions for ${username}`);
    } else {
      mustChangePassword = Boolean(user.must_change_password);
      console.log(`[Bootstrap] Existing password preserved for ${username}. (To reset, specify BOOTSTRAP_ADMIN_PASSWORD or RESET_ADMIN_PASSWORD=true)`);
    }

    await user.save();
  }

  // 2. Locate or create PlatformAdmin authority document
  let platformAdmin = await PlatformAdminModel.findOne({ auth_user_id: user.auth_user_id });
  if (!platformAdmin) {
    platformAdmin = await PlatformAdminModel.create({
      _id: uuidv4(),
      auth_user_id: user.auth_user_id,
      email: user.email,
      full_name: user.full_name,
      status: UserStatus.active,
    });
    console.log(`[Bootstrap] Created linked PlatformAdmin authority document (ID: ${platformAdmin._id})`);
  } else {
    console.log(`[Bootstrap] PlatformAdmin authority document already exists (ID: ${platformAdmin._id})`);
    if (platformAdmin.status !== UserStatus.active) {
      platformAdmin.status = UserStatus.active;
      await platformAdmin.save();
      console.log(`[Bootstrap] Reactivated PlatformAdmin authority document`);
    }
  }

  if (isCliInvocation) {
    console.log('\n====================================================');
    console.log('Bootstrap Summary: SUCCESS');
    console.log(`Account Username : ${username}`);
    console.log(`Account Email    : ${email}`);
    console.log(`Authority Linked : auth_user_id matches between User and PlatformAdmin`);
    if (generatedPassword) {
      console.log('----------------------------------------------------');
      console.log('[SENSITIVE ONE-TIME CREDENTIAL]');
      console.log(`Temporary Password: [${generatedPassword}]`);
      console.log('Notice: must_change_password is set to true.');
      console.log('Please log in and update your password immediately.');
      console.log('----------------------------------------------------');
    } else if (passwordUpdated) {
      console.log('Password Status  : Updated to explicitly supplied password.');
    } else {
      console.log('Password Status  : Existing password preserved unchanged.');
    }
    console.log('====================================================\n');
  }

  return {
    userId: user._id,
    authUserId: user.auth_user_id,
    username: user.username || username,
    email: user.email || email,
    isNewUser,
    passwordUpdated,
    mustChangePassword,
    generatedPassword,
    platformAdminId: platformAdmin._id,
  };
}

if (process.argv[1] && (process.argv[1].endsWith('bootstrapAdmin.ts') || process.argv[1].endsWith('bootstrapAdmin.js'))) {
  bootstrapAdmin()
    .then(async () => {
      await disconnectDatabase();
    })
    .catch(async (error) => {
      console.error('[Bootstrap Error]', error);
      await disconnectDatabase().catch(() => {});
      process.exit(1);
    });
}
