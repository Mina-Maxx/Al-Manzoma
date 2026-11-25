import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { config } from '../config/index.js';
import {
  UserModel,
  CompanyModel,
  MembershipModel,
  PlatformAdminModel,
  QuarryModel,
  QuarryPermissionModel,
  AppReleaseModel,
} from '../database/models/index.js';
import {
  AuthClaims,
  AuthContext,
  MembershipRole,
  PlatformAdminContext,
  UserStatus,
  CompanyStatus,
  QuarryStatus,
  AuditResult,
} from '../types/index.js';
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  UpgradeRequiredError,
} from './errors.js';
import { auditService } from '../modules/audit/service.js';
import { findActiveSupportGrant, requestPathname, supportScopeForTenantRequest } from '../services/supportGrants.js';

/**
 * Checks if the request path is one of the minimal permitted endpoints during mandatory password change.
 * Only /me (to read profile status) and /auth/change-password are permitted.
 */
export function isMustChangePasswordAllowedRoute(req: Request): boolean {
  const fullPath = (req.originalUrl || req.path || '')
    .split('?')[0]
    .replace(/\/+$/, '')
    .toLowerCase() || '/';
  return fullPath === '/me' || fullPath === '/auth/change-password';
}

/** JWT `iat` has one-second precision. Treat tokens issued in the revocation
 * second as revoked too, since their ordering relative to the write is unknown.
 */
export function isTokenRevoked(iat: number | undefined, revokedAt: Date | null | undefined): boolean {
  if (typeof iat !== 'number' || !revokedAt) return false;
  const revokedSecond = Math.floor(new Date(revokedAt).getTime() / 1000);
  return iat <= revokedSecond;
}

function assertClientApplicationBinding(req: Request, claims: AuthClaims): void {
  const tokenApplication = typeof claims.client_application === 'string' ? claims.client_application : null;
  const requestApplication = typeof req.headers['x-client-application'] === 'string'
    ? req.headers['x-client-application'].trim()
    : null;
  const expectedApplication = tokenApplication ||
    (claims.role === 'platform_admin' ? 'platform_admin_dashboard' : 'android');

  if (!['android', 'platform_admin_dashboard'].includes(expectedApplication)) {
    throw new UnauthorizedError('invalid client application claim');
  }
  if (tokenApplication && requestApplication && requestApplication !== tokenApplication) {
    throw new ForbiddenError('session is bound to a different application');
  }
  if (requestApplication && requestApplication !== expectedApplication) {
    throw new ForbiddenError('application context does not match the authenticated session');
  }
}

function assertActiveSession(req: Request, claims: AuthClaims, user: { active_session_id?: string | null } | null | undefined): void {
  if (!user?.active_session_id) return;
  const presentedSessionId = (
    (req.headers['x-session-id'] as string) ||
    claims.session_id ||
    claims.sid
  )?.trim();
  if (!presentedSessionId || presentedSessionId !== user.active_session_id) {
    throw new UnauthorizedError('Session has expired or was terminated by a newer login on another device');
  }
}

/**
 * Checks if the request is a self-profile inspection, password change, or direct authorized file download.
 */
export function isSelfProfileOrDirectRoute(req: Request): boolean {
  const fullPath = (req.originalUrl || req.path || '').split('?')[0];
  const relativePath = req.path || '';
  const isDownload = fullPath.includes('/download') || relativePath.includes('/download');
  const isDirectDocument = fullPath.startsWith('/documents/') || relativePath.startsWith('/documents/');
  const isLogout = fullPath === '/auth/logout' || relativePath === '/auth/logout';
  return isMustChangePasswordAllowedRoute(req) || isDownload || isDirectDocument || isLogout;
}

// Extend Express Request to hold authContext and platformAdminContext
declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
      platformAdminContext?: PlatformAdminContext;
      supportGrantId?: string;
    }
  }
}

// JWKS Client for Supabase public keys (asymmetric verification)
let jwksClientInstance: jwksRsa.JwksClient | null = null;

function getJwksClient(): jwksRsa.JwksClient | null {
  if (!config.supabaseUrl) return null;
  if (!jwksClientInstance) {
    const jwksUri = `${config.supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
    jwksClientInstance = jwksRsa({
      jwksUri,
      cache: true,
      cacheMaxAge: 3600000,
      rateLimit: true,
    });
  }
  return jwksClientInstance;
}

/**
 * Verify JWT token. Supports:
 * 1. Symmetric HS256 tokens signed with JWT_SECRET (dev auth / direct login tokens)
 * 2. Asymmetric RS256/ES256 Supabase tokens via JWKS
 */
export type TokenUse = 'access' | 'refresh';
const ACCESS_TOKEN_MAX_LIFETIME_SECONDS = 3600;

/**
 * Tokens issued before `token_use` existed are classified by lifetime (access = 1h, refresh = 30d),
 * so deploying this check does not log everyone out. Remove the inference after 30 days.
 */
function resolveTokenUse(claims: AuthClaims): TokenUse {
  if (claims.token_use === 'access' || claims.token_use === 'refresh') return claims.token_use;
  if (claims.client_application && typeof claims.exp === 'number' && typeof claims.iat === 'number') {
    return claims.exp - claims.iat > ACCESS_TOKEN_MAX_LIFETIME_SECONDS ? 'refresh' : 'access';
  }
  return 'access';
}

/** Verifies signature/issuer/audience and, when `expectedUse` is given, that the token is of that type. */
export async function verifyToken(token: string, expectedUse?: TokenUse): Promise<AuthClaims> {
  const claims = await verifyTokenClaims(token);
  if (expectedUse && resolveTokenUse(claims) !== expectedUse) {
    throw new UnauthorizedError('Invalid token type');
  }
  return claims;
}

async function verifyTokenClaims(token: string): Promise<AuthClaims> {
  const decodedUnverified = jwt.decode(token, { complete: true });
  if (!decodedUnverified || !decodedUnverified.header) {
    throw new UnauthorizedError('Malformed token');
  }

  const alg = decodedUnverified.header.alg;

  // Accept Supabase, legacy local, and application-specific local token audiences.
  const localAudience = config.jwtAudience || 'quarryvault-dev';
  const validAudiences: [string, ...string[]] = [
    config.supabaseJwtAudience || 'authenticated',
    'authenticated',
    localAudience,
    `${localAudience}:android`,
    `${localAudience}:platform_admin_dashboard`,
    ...(config.env === 'production' ? [] : ['quarryvault-dev']),
  ];
  const supabaseIssuer = config.supabaseUrl ? `${config.supabaseUrl.replace(/\/+$/, '')}/auth/v1` : null;
  const acceptedIssuers: [string, ...string[]] = [config.jwtIssuer, ...(supabaseIssuer ? [supabaseIssuer] : [])];

  const resolveLocalClaims = (decoded: any, resolve: any, reject: any) => {
    if (decoded?.client_application) {
      const expectedAudience = `${localAudience}:${decoded.client_application}`;
      if (
        !['android', 'platform_admin_dashboard'].includes(decoded.client_application) ||
        decoded.aud !== expectedAudience
      ) {
        reject(new UnauthorizedError('Invalid application audience'));
        return;
      }
    }
    resolve(decoded as AuthClaims);
  };

  // 1. Local HS256 token verification (signature + issuer + audience, no fallbacks)
  if (alg === 'HS256') {
    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        config.jwtSecret,
        { algorithms: ['HS256'], audience: validAudiences, issuer: acceptedIssuers },
        (err: any, decoded: any) => {
          if (err) return reject(new UnauthorizedError('Invalid token signature'));
          resolveLocalClaims(decoded, resolve, reject);
        }
      );
    });
  }

  // 2. Supabase RS256/ES256 verification via JWKS
  const client = getJwksClient();
  if (!client) {
    throw new UnauthorizedError('JWKS verification not configured');
  }

  const kid = decodedUnverified.header.kid;
  if (!kid) {
    throw new UnauthorizedError('Missing token kid');
  }

  const key = await client.getSigningKey(kid);
  const signingKey = key.getPublicKey();

  const allowedAlgorithms = (
    config.jwtAlgorithms && config.jwtAlgorithms.length > 0
      ? config.jwtAlgorithms
      : ['RS256', 'ES256', 'HS256']
  ) as jwt.Algorithm[];

  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      signingKey,
      {
        algorithms: allowedAlgorithms,
        audience: validAudiences,
      },
      (err: any, decoded: any) => {
        if (err) return reject(new UnauthorizedError(`Token verification failed: ${err.message}`));
        if (decoded?.client_application) {
          const expectedAudience = `${localAudience}:${decoded.client_application}`;
          if (
            !['android', 'platform_admin_dashboard'].includes(decoded.client_application) ||
            decoded.aud !== expectedAudience
          ) {
            return reject(new UnauthorizedError('Invalid application audience'));
          }
        }
        resolve(decoded as AuthClaims);
      }
    );
  });
}

/**
 * Extracts Bearer token from Authorization header
 */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header) {
    const parts = header.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      return parts[1].trim();
    }
  }

  // Support direct browser downloads via query param ?token=...
  if (req.query && typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }

  return null;
}

/**
 * Authenticates request, derives user identity, tenant context, and verifies status.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      throw new UnauthorizedError('missing credentials');
    }

    let claims: AuthClaims;
    try {
      claims = await verifyToken(token, 'access');
    } catch (err: any) {
      await auditService.record({
        action: 'auth.verify',
        result: AuditResult.denied,
        meta: { error: err.message },
        request: req,
      });
      throw new UnauthorizedError('invalid credentials');
    }

    const sub = claims.sub;
    if (!sub) {
      throw new UnauthorizedError('missing sub claim');
    }
    assertClientApplicationBinding(req, claims);

    // Check minimum supported app version header if present
    const versionHeader = req.headers['x-app-version-code'];
    if (versionHeader) {
      const versionCode = parseInt(String(versionHeader), 10);
      if (!isNaN(versionCode)) {
        const latestRelease = await AppReleaseModel.findOne({ is_withdrawn: false }).sort({ version_code: -1 }).lean();
        if (latestRelease) {
          const isMandatory = latestRelease.update_policy === 'mandatory' || latestRelease.update_required === true;
          // An optional update NEVER blocks existing users via header checks.
          // Only enforce if the release is explicitly mandatory or has an explicit minimum supported version below version_code.
          let effectiveMinCode = 1;
          if (isMandatory) {
            effectiveMinCode = latestRelease.minimum_supported_version_code || 1;
          } else if (latestRelease.minimum_supported_version_code && latestRelease.minimum_supported_version_code < latestRelease.version_code) {
            effectiveMinCode = latestRelease.minimum_supported_version_code;
          }

          if (effectiveMinCode > 1 && versionCode < effectiveMinCode) {
            throw new UpgradeRequiredError({
              code: 'UPGRADE_REQUIRED',
              message: 'Application update required. Please update to continue using QuarryVault.',
              minimum_supported_version_code: effectiveMinCode,
              current_version_code: versionCode,
            });
          }
        }
      }
    }

    // Cross-company access for Platform Admin (X-Company-Id header or body/query company_id)
    let xCompanyId = (req.headers['x-company-id'] || req.body?.company_id || req.query?.company_id) as string | undefined;

    if (xCompanyId) {
      let platformAdmin = await PlatformAdminModel.findOne({
        auth_user_id: String(sub),
        status: UserStatus.active,
      });

      if (platformAdmin) {
        if (claims.client_application !== 'platform_admin_dashboard') {
          throw new ForbiddenError('Platform Admin cross-company access is available only through the Dashboard session');
        }
        const linkedUser = await UserModel.findOne({ auth_user_id: String(sub) }).lean();
        if (!linkedUser) {
          throw new ForbiddenError('Platform Admin account requires a linked user session record');
        }
        if (linkedUser && linkedUser.status !== UserStatus.active) {
          await auditService.record({
            action: 'platform_admin.cross_office_access_denied',
            result: AuditResult.denied,
            targetType: 'platform_admin',
            targetId: platformAdmin._id,
            meta: { reason: 'linked_user_inactive' },
            request: req,
          });
          throw new ForbiddenError('administrator account is disabled');
        }

        if (isTokenRevoked(claims.iat, linkedUser?.tokens_revoked_at)) {
          throw new UnauthorizedError('token has been revoked; please sign in again');
        }
        assertActiveSession(req, claims, linkedUser);

        if (linkedUser?.must_change_password && !isMustChangePasswordAllowedRoute(req)) {
          throw new ForbiddenError('password change required');
        }

        const targetCompany = await CompanyModel.findById(xCompanyId).lean();
        if (!targetCompany) {
          throw new NotFoundError('company not found');
        }

        // Tenant document content/metadata needs an approved, unexpired, in-scope support grant.
        const requiredScope = supportScopeForTenantRequest(req.method, requestPathname(req));
        if (requiredScope) {
          const activeGrant = await findActiveSupportGrant(platformAdmin._id, targetCompany._id, requiredScope);
          if (!activeGrant) {
            const enforced = config.supportGrantMode === 'enforce';
            await auditService.record({
              action: 'platform_admin.support_grant_missing',
              result: enforced ? AuditResult.denied : AuditResult.success,
              companyId: targetCompany._id,
              targetType: 'platform_admin',
              targetId: platformAdmin._id,
              meta: { scope: requiredScope, mode: config.supportGrantMode, path: requestPathname(req) },
              request: req,
            });
            if (enforced) {
              throw new ForbiddenError('an approved support grant is required for this tenant data');
            }
          }
        }

        const syntheticUser = linkedUser || {
          _id: platformAdmin._id,
          auth_user_id: platformAdmin.auth_user_id,
          email: platformAdmin.email,
          full_name: platformAdmin.full_name,
          status: UserStatus.active,
          must_change_password: false,
          createdAt: platformAdmin.createdAt,
          updatedAt: platformAdmin.updatedAt,
        };

        req.platformAdminContext = {
          admin: platformAdmin as any,
          claims,
          adminId: platformAdmin._id,
          authUserId: String(sub),
        };
        req.authContext = {
          user: syntheticUser as any,
          company: targetCompany as any,
          membership: null as any,
          claims,
          userId: syntheticUser._id,
          companyId: targetCompany._id,
          role: 'platform_admin',
          authUserId: String(sub),
          platformAdminId: platformAdmin._id,
        };
        return next();
      }
    }

    // Standard Tenant User resolution (strictly based on immutable auth_user_id)
    const userDoc = await UserModel.findOne({ auth_user_id: String(sub) });
    const platformAdmin = await PlatformAdminModel.findOne({
      auth_user_id: String(sub),
    });

    if (platformAdmin && claims.client_application !== 'platform_admin_dashboard') {
      throw new ForbiddenError('Platform Admin access is available only through the Dashboard session');
    }
    if (!platformAdmin && claims.client_application === 'platform_admin_dashboard') {
      throw new ForbiddenError('Platform Admin Dashboard sessions are not valid for tenant user accounts');
    }

    if (platformAdmin && platformAdmin.status !== UserStatus.active) {
      await auditService.record({
        action: 'platform_admin.inactive',
        result: AuditResult.denied,
        targetType: 'platform_admin',
        targetId: platformAdmin._id,
        request: req,
      });
      throw new ForbiddenError('administrator account is disabled');
    }

    if (!userDoc && !platformAdmin) {
      await auditService.record({
        action: 'auth.user_lookup',
        result: AuditResult.denied,
        meta: { auth_user_id: String(sub), email: claims.email },
        request: req,
      });
      throw new ForbiddenError('user not provisioned');
    }

    if (platformAdmin && !userDoc) {
      throw new ForbiddenError('Platform Admin account requires a linked user session record');
    }

    const resolvedUser = userDoc || {
      _id: platformAdmin!._id,
      auth_user_id: platformAdmin!.auth_user_id,
      email: platformAdmin!.email,
      full_name: platformAdmin!.full_name,
      status: UserStatus.active,
      must_change_password: false,
      createdAt: platformAdmin!.createdAt,
      updatedAt: platformAdmin!.updatedAt,
      tokens_revoked_at: null,
    };

    if (resolvedUser.status !== UserStatus.active) {
      await auditService.record({
        action: 'auth.inactive_user',
        result: AuditResult.denied,
        actorUserId: resolvedUser._id,
        request: req,
      });
      throw new ForbiddenError('user is not active');
    }

    // Session revocation check
    if (isTokenRevoked(claims.iat, resolvedUser.tokens_revoked_at)) {
      await auditService.record({
        action: 'auth.revoked_token',
        result: AuditResult.denied,
        actorUserId: resolvedUser._id,
        request: req,
      });
      throw new UnauthorizedError('token has been revoked; please sign in again');
    }

    // Enforce the linked User's active session consistently for tenant users and Platform Admins.
    if (userDoc && userDoc.active_session_id) {
      const presentedSid = (
        (req.headers['x-session-id'] as string) ||
        (claims as any).session_id ||
        (claims as any).sid
      )?.trim();

      if (!presentedSid || presentedSid !== userDoc.active_session_id) {
        await auditService.record({
          action: 'auth.single_session_violation',
          result: AuditResult.denied,
          actorUserId: resolvedUser._id,
          meta: {
            reason: 'session_terminated_by_new_login',
            presented_sid: presentedSid || null,
            active_session_id: userDoc.active_session_id,
          },
          request: req,
        });
        throw new UnauthorizedError('Session has expired or was terminated by a newer login on another device');
      }
    }

    // Mandatory password change enforcement
    if (resolvedUser.must_change_password && !isMustChangePasswordAllowedRoute(req)) {
      await auditService.record({
        action: 'auth.password_change_required',
        result: AuditResult.denied,
        actorUserId: resolvedUser._id,
        meta: { path: (req.originalUrl || req.path || '').split('?')[0] },
        request: req,
      });
      throw new ForbiddenError('password change required');
    }

    if (platformAdmin) {
      req.platformAdminContext = {
        admin: platformAdmin as any,
        claims,
        adminId: platformAdmin._id,
        authUserId: String(sub),
      };
      if (isSelfProfileOrDirectRoute(req)) {
        req.authContext = {
          user: resolvedUser as any,
          company: null as any,
          membership: null as any,
          claims,
          userId: resolvedUser._id,
          companyId: '' as any,
          role: 'platform_admin',
          authUserId: String(sub),
          platformAdminId: platformAdmin._id,
        };
        return next();
      }
      throw new ForbiddenError('company context required; specify X-Company-Id');
    }

    const selectedTenantCompanyId = typeof req.headers['x-company-id'] === 'string'
      ? req.headers['x-company-id'].trim()
      : '';
    const membershipQuery: Record<string, unknown> = { user_id: resolvedUser._id };
    if (selectedTenantCompanyId) membershipQuery.company_id = selectedTenantCompanyId;
    const membership = await MembershipModel.findOne(membershipQuery).lean();
    if (!membership) {
      await auditService.record({
        action: 'auth.membership_lookup',
        result: AuditResult.denied,
        actorUserId: resolvedUser._id,
        meta: selectedTenantCompanyId ? { reason: 'no_membership_in_selected_company' } : undefined,
        request: req,
      });
      throw new ForbiddenError(selectedTenantCompanyId ? 'no membership in selected company' : 'no company membership');
    }

    const company = await CompanyModel.findById(membership.company_id).lean();
    if (!company || company.status !== CompanyStatus.active) {
      await auditService.record({
        action: 'auth.suspended_company',
        result: AuditResult.denied,
        companyId: membership.company_id,
        actorUserId: resolvedUser._id,
        request: req,
      });
      throw new ForbiddenError('company is not active');
    }

    req.authContext = {
      user: resolvedUser as any,
      company: company as any,
      membership: membership as any,
      claims,
      userId: resolvedUser._id,
      companyId: company._id,
      role: membership.role,
      authUserId: String(sub),
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Authenticate Platform Administrator
 */
export async function authenticatePlatformAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (!token) throw new UnauthorizedError('missing credentials');

    let claims: AuthClaims;
    try {
      claims = await verifyToken(token, 'access');
    } catch (err: any) {
      throw new UnauthorizedError('invalid credentials');
    }

    const sub = claims.sub;
    if (!sub) throw new UnauthorizedError('missing sub claim');
    assertClientApplicationBinding(req, claims);

    const admin = await PlatformAdminModel.findOne({
      auth_user_id: String(sub),
      status: UserStatus.active,
    });

    if (!admin) {
      await auditService.record({
        action: 'platform_admin.lookup',
        result: AuditResult.denied,
        targetType: 'platform_admin',
        request: req,
      });
      throw new ForbiddenError('not a platform administrator');
    }

    if (claims.client_application !== 'platform_admin_dashboard') {
      throw new ForbiddenError('Platform Admin APIs require a Dashboard session');
    }

    const linkedUser = await UserModel.findOne({ auth_user_id: String(sub) }).lean();
    if (!linkedUser) {
      throw new ForbiddenError('Platform Admin account requires a linked user session record');
    }
    if (linkedUser && linkedUser.status !== UserStatus.active) {
      throw new ForbiddenError('administrator account is disabled');
    }

    if (isTokenRevoked(claims.iat, linkedUser?.tokens_revoked_at)) {
      throw new UnauthorizedError('token has been revoked');
    }
    assertActiveSession(req, claims, linkedUser);

    if (linkedUser?.must_change_password && !isMustChangePasswordAllowedRoute(req)) {
      throw new ForbiddenError('password change required');
    }

    req.platformAdminContext = {
      admin: admin as any,
      claims,
      adminId: admin._id,
      authUserId: admin.auth_user_id,
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require Company Admin role
 */
export function requireCompanyAdmin(req: Request, _res: Response, next: NextFunction): void {
  const context = req.authContext;
  const verifiedPlatformAdmin = Boolean(
    context?.role === 'platform_admin' &&
      context.companyId &&
      context.platformAdminId &&
      req.platformAdminContext &&
      context.platformAdminId === req.platformAdminContext.adminId &&
      context.authUserId === req.platformAdminContext.authUserId
  );
  if (!context || (context.role !== MembershipRole.company_admin && !verifiedPlatformAdmin)) {
    return next(new ForbiddenError('company administrator role required'));
  }
  next();
}

/**
 * Factory for quarry permission dependency: can_view, can_upload, can_download, can_delete
 */
export function requireQuarryPermission(permission: 'can_view' | 'can_upload' | 'can_download' | 'can_delete') {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const ctx = req.authContext;
      if (!ctx) return next(new UnauthorizedError());

      const quarryId = req.params.quarry_id || req.params.id;
      if (!quarryId) return next(new NotFoundError('quarry not found'));

      const quarry = await QuarryModel.findOne({
        _id: quarryId,
        company_id: ctx.companyId,
        status: QuarryStatus.active,
      }).lean();

      if (!quarry) {
        return next(new NotFoundError('quarry not found'));
      }

      // Platform Admin access is handled by its Dashboard-only context. Company Admin
      // operational permissions remain configurable in the company permission matrix.
      if ((ctx.role as string) === 'platform_admin') {
        return next();
      }

      // Fetch employee's company membership
      const membership = await MembershipModel.findOne({
        user_id: ctx.userId,
        company_id: ctx.companyId,
      }).lean();

      const hiddenQuarries = membership?.hidden_quarries || [];

      // Check legacy QuarryPermissionModel for compatibility
      const legacyPerm = await QuarryPermissionModel.findOne({
        user_id: ctx.userId,
        quarry_id: quarry._id,
      }).lean();

      // Step 1: Check Quarry Visibility (hidden quarries are strictly inaccessible)
      const isHidden = hiddenQuarries.includes(quarry._id);
      if (isHidden) {
        await auditService.record({
          action: `quarry.${permission}`,
          result: AuditResult.denied,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'quarry',
          targetId: quarry._id,
          meta: { reason: 'quarry_hidden' },
          request: req,
        });
        return next(new NotFoundError('quarry not found'));
      }

      // Company-wide grants are the ceiling; a quarry-level setting can further
      // restrict access but cannot grant beyond that ceiling.
      const allowed = resolveQuarryPermission(permission, membership, legacyPerm);

      if (!allowed) {
        await auditService.record({
          action: `quarry.${permission}`,
          result: AuditResult.denied,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          targetType: 'quarry',
          targetId: quarry._id,
          request: req,
        });
        return next(new ForbiddenError('permission denied'));
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export type QuarryOperationalPermission = 'can_view' | 'can_upload' | 'can_download' | 'can_delete';

export function resolveQuarryPermission(
  permission: QuarryOperationalPermission,
  membership?: (Partial<Record<QuarryOperationalPermission, boolean>> & { role?: string }) | null,
  quarryPermission?: Partial<Record<QuarryOperationalPermission, boolean>> | null
): boolean {
  if (membership?.role === MembershipRole.company_admin || (membership?.role as string) === 'company_admin') {
    return true;
  }
  // Fail closed: no membership, or a membership that never recorded the flag, grants nothing beyond view/upload.
  if (!membership) return false;
  const defaultAllowed = permission === 'can_view' || permission === 'can_upload';
  const companyAllowed = membership?.[permission] ?? defaultAllowed;
  const quarryAllowed = quarryPermission?.[permission] ?? true;
  return Boolean(companyAllowed && quarryAllowed);
}
