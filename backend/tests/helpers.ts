import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import {
  CompanyModel,
  UserModel,
  MembershipModel,
  QuarryModel,
  QuarryPermissionModel,
  PlatformAdminModel,
} from '../src/database/models/index.js';
import {
  CompanyStatus,
  UserStatus,
  MembershipRole,
  QuarryStatus,
} from '../src/types/index.js';
import { signAccessToken } from '../src/modules/auth/router.js';

export async function createTestCompany(overrides: Partial<any> = {}) {
  return await CompanyModel.create({
    _id: overrides._id || uuidv4(),
    name: overrides.name || `Test Company ${uuidv4().substring(0, 8)}`,
    status: overrides.status || CompanyStatus.active,
    quota_bytes: overrides.quota_bytes || 5368709120, // 5 GiB
    max_users: overrides.max_users || 10,
  });
}

export async function createTestUser(overrides: Partial<any> = {}) {
  const auth_user_id = overrides.auth_user_id || uuidv4();
  if (overrides.auth_user_id) {
    const existing = await UserModel.findOne({ auth_user_id: overrides.auth_user_id });
    if (existing) {
      if (overrides.password) {
        existing.password_hash = await bcrypt.hash(overrides.password, 8);
      }
      if (overrides.active_session_id !== undefined) existing.active_session_id = overrides.active_session_id;
      if (overrides.must_change_password !== undefined) existing.must_change_password = overrides.must_change_password;
      await existing.save();
      return existing;
    }
  }
  const password = overrides.password || 'password123';
  const password_hash = await bcrypt.hash(password, 8);
  const username = overrides.username || `user_${uuidv4().substring(0, 8)}`;

  return await UserModel.create({
    _id: overrides._id || uuidv4(),
    auth_user_id,
    username,
    normalized_username: username.toLowerCase(),
    email: overrides.email || `${username}@example.com`,
    password_hash,
    full_name: overrides.full_name || 'Test User',
    status: overrides.status || UserStatus.active,
    must_change_password: overrides.must_change_password || false,
    tokens_revoked_at: overrides.tokens_revoked_at || null,
    active_session_id: overrides.active_session_id || null,
  });
}

export async function createTestMembership(userId: string, companyId: string, role: MembershipRole = MembershipRole.employee) {
  return await MembershipModel.create({
    user_id: userId,
    company_id: companyId,
    role,
  });
}

export async function createTestQuarry(companyId: string, overrides: Partial<any> | string = {}) {
  const quarryOverrides = typeof overrides === 'string' ? { name: overrides } : overrides
  const uid = uuidv4().substring(0, 8);
  return await QuarryModel.create({
    _id: quarryOverrides._id || uuidv4(),
    company_id: companyId,
    name: quarryOverrides.name || `Quarry ${uid}`,
    quarry_number: quarryOverrides.quarry_number || `Q-${uid}`,
    quarry_type: quarryOverrides.quarry_type || 'رخام',
    status: quarryOverrides.status || QuarryStatus.active,
    ...quarryOverrides,
  });
}

export async function createTestPermission(userId: string, quarryId: string, perms: { can_view?: boolean; can_upload?: boolean; can_download?: boolean; can_delete?: boolean } = {}) {
  return await QuarryPermissionModel.create({
    user_id: userId,
    quarry_id: quarryId,
    can_view: perms.can_view ?? true,
    can_upload: perms.can_upload ?? false,
    can_download: perms.can_download ?? false,
    can_delete: perms.can_delete ?? false,
  });
}

export async function createTestPlatformAdmin(overrides: Partial<any> = {}) {
  const authUserId = overrides.auth_user_id || uuidv4();
  const email = overrides.email || `admin_${uuidv4().substring(0, 8)}@example.com`;
  const admin = await PlatformAdminModel.create({
    _id: overrides._id || uuidv4(),
    auth_user_id: authUserId,
    email,
    full_name: overrides.full_name || 'Platform Super Admin',
    status: overrides.status || UserStatus.active,
  });
  const existingUser = await UserModel.findOne({ auth_user_id: authUserId });
  if (!existingUser) {
    await createTestUser({
      auth_user_id: authUserId,
      email,
      username: `admin_${authUserId.substring(0, 8)}`,
      full_name: admin.full_name,
      status: admin.status,
    });
  }
  Object.defineProperty(admin, '__testRole', { value: 'platform_admin' });
  return admin;
}

export async function createTestPlatformAdminDashboardSession() {
  const admin = await createTestPlatformAdmin();
  const sessionId = uuidv4();
  const linkedUser = await UserModel.findOneAndUpdate(
    { auth_user_id: admin.auth_user_id },
    { $set: { active_session_id: sessionId, tokens_revoked_at: null } },
    { new: true }
  );
  if (!linkedUser) await createTestUser({ auth_user_id: admin.auth_user_id, active_session_id: sessionId });
  const token = signAccessToken({
    sub: admin.auth_user_id,
    email: admin.email,
    role: 'platform_admin',
    client_application: 'platform_admin_dashboard',
    session_id: sessionId,
  });
  return {
    admin,
    header: {
      Authorization: `Bearer ${token}`,
      'X-Client-Application': 'platform_admin_dashboard',
      'X-Session-Id': sessionId,
    },
  };
}

export function generateAuthHeader(userOrAdmin: any, role: string = 'user'): Record<string, string> & { Authorization: string } {
  const effectiveRole = role === 'user' && userOrAdmin.__testRole === 'platform_admin'
    ? 'platform_admin'
    : role;
  const clientApplication = effectiveRole === 'platform_admin'
    ? 'platform_admin_dashboard'
    : 'android';
  const sessionId = userOrAdmin.active_session_id || uuidv4();
  const token = signAccessToken({
    sub: userOrAdmin.auth_user_id || userOrAdmin._id,
    email: userOrAdmin.email,
    role: effectiveRole,
    client_application: clientApplication,
    session_id: sessionId,
  });
  return {
    Authorization: `Bearer ${token}`,
    'X-Client-Application': clientApplication,
    'X-Session-Id': sessionId,
  };
}
export async function waitForFreshJwtIat(revokedAt: Date | null | undefined): Promise<void> {
  if (!revokedAt) return;
  const firstValidIat = Math.floor(revokedAt.getTime() / 1000) + 1;
  const delayMs = Math.max(0, firstValidIat * 1000 - Date.now());
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
