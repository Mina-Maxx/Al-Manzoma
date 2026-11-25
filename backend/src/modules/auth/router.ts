import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { UserModel, PlatformAdminModel } from '../../database/models/index.js';
import { UserStatus, AuditResult } from '../../types/index.js';
import { config } from '../../config/index.js';
import { auditService } from '../audit/service.js';
import { authenticate, isTokenRevoked, verifyToken } from '../../middleware/auth.js';
import {
  DomainError,
  UnauthorizedError,
  ForbiddenError,
} from '../../middleware/errors.js';

export const authRouter = Router();

const isTest = config.env === 'test';

// Minimum 8 characters, maximum 128 characters.
// Must contain at least one letter and at least one digit or symbol.
const PASSWORD_POLICY_REGEX = /^(?=.*[A-Za-z])(?=.*[\d\W_]).{8,128}$/;

export function validatePasswordPolicy(password: string): void {
  if (typeof password !== 'string') {
    throw new DomainError('Password must be a string', 400);
  }
  if (password.length < 8) {
    throw new DomainError('Password must be at least 8 characters long', 400);
  }
  if (password.length > 128) {
    throw new DomainError('Password must not exceed 128 characters', 400);
  }
  if (!PASSWORD_POLICY_REGEX.test(password)) {
    throw new DomainError('Password must contain at least one letter and at least one number or symbol', 400);
  }
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? 1000 : 30, // 30 attempts per 15 min per IP
  message: { detail: 'too many login attempts; please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 15,
  message: { detail: 'too many password change attempts; please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 10,
  message: { detail: 'too many password recovery requests; please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export function signAccessToken(payload: { sub: string; email?: string | null; role?: string; client_application?: string; session_id?: string; sid?: string }): string {
  const clientApp = payload.client_application || (payload.role === 'platform_admin' ? 'platform_admin_dashboard' : 'android');
  const fullPayload = {
    ...payload,
    client_application: clientApp,
    token_use: 'access',
  };
  const audience = `${config.jwtAudience || 'quarryvault-dev'}:${clientApp}`;
  return jwt.sign(fullPayload, config.jwtSecret, {
    algorithm: 'HS256',
    issuer: config.jwtIssuer,
    audience,
    expiresIn: '1h',
  });
}

export function signRefreshToken(payload: { sub: string; client_application?: string; session_id?: string; sid?: string }): string {
  const clientApp = payload.client_application || 'android';
  const fullPayload = {
    ...payload,
    client_application: clientApp,
    token_use: 'refresh',
  };
  const audience = `${config.jwtAudience || 'quarryvault-dev'}:${clientApp}`;
  return jwt.sign(fullPayload, config.jwtSecret, {
    algorithm: 'HS256',
    issuer: config.jwtIssuer,
    audience,
    expiresIn: '30d',
  });
}

/**
 * Format user for public output
 */
export function formatUserOut(user: any, isPlatformAdmin: boolean = false) {
  return {
    id: user._id,
    username: user.username || null,
    email: user.email || null,
    full_name: user.full_name || null,
    status: user.status,
    must_change_password: Boolean(user.must_change_password),
    mustChangePassword: Boolean(user.must_change_password),
    role: isPlatformAdmin ? 'platform_admin' : (user.role || 'user'),
    is_superadmin: Boolean(isPlatformAdmin),
    isSuperAdmin: Boolean(isPlatformAdmin),
  };
}

/**
 * POST /auth/login
 */
authRouter.post('/login', loginLimiter, async (req: Request, res: Response, next) => {
  try {
    const bodyApplication = typeof req.body?.client_application === 'string' ? req.body.client_application.trim() : '';
    const headerApplication = typeof req.headers['x-client-application'] === 'string'
      ? req.headers['x-client-application'].trim()
      : '';
    if (bodyApplication && headerApplication && bodyApplication !== headerApplication) {
      throw new ForbiddenError('application context mismatch');
    }
    const explicitApplication = bodyApplication || headerApplication;
    if (explicitApplication && !['android', 'platform_admin_dashboard'].includes(explicitApplication)) {
      throw new DomainError('invalid client application', 400);
    }

    const ident = (req.body.username || req.body.email || '').trim();
    const password = req.body.password || '';

    if (!ident) {
      throw new DomainError('Username is required', 400);
    }
    if (!password) {
      throw new DomainError('Password is required', 400);
    }

    const normalized = ident.toLowerCase();

    // Find in UserModel
    let user = await UserModel.findOne({
      $or: [
        { normalized_username: normalized },
        { email: normalized },
      ],
    });

    if (!user) {
      // Legacy fallback: query by username if normalized_username was missing
      const escapedIdent = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      user = await UserModel.findOne({
        $or: [
          { username: ident },
          { username: normalized },
          { username: { $regex: new RegExp(`^${escapedIdent}$`, 'i') } },
        ],
      });

      // Opportunistically backfill normalized_username if missing
      if (user && !user.normalized_username && user.username) {
        user.normalized_username = user.username.toLowerCase();
        await user.save().catch(() => {});
      }
    }

    // Check PlatformAdminModel
    let isPlatformAdmin = false;
    let platformAdmin: any = null;
    if (user) {
      platformAdmin = await PlatformAdminModel.findOne({
        auth_user_id: user.auth_user_id,
        status: UserStatus.active,
      });
      if (platformAdmin) {
        isPlatformAdmin = true;
      }
    } else {
      platformAdmin = await PlatformAdminModel.findOne({
        $or: [
          { auth_user_id: ident },
          { email: normalized },
        ],
        status: UserStatus.active,
      });
      if (platformAdmin) {
        isPlatformAdmin = true;
      }
    }

    if (!user && !platformAdmin) {
      await auditService.record({
        action: 'auth.login',
        result: AuditResult.denied,
        meta: { reason: 'user_not_found', ident },
        request: req,
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    if (isPlatformAdmin && !user) {
      await auditService.record({
        action: 'auth.login',
        result: AuditResult.denied,
        targetType: 'platform_admin',
        targetId: platformAdmin?._id,
        meta: { reason: 'platform_admin_user_link_required_for_session_control' },
        request: req,
      });
      throw new ForbiddenError('Platform Admin sign-in requires a linked user account with server-managed session controls');
    }

    const account = user || platformAdmin;
    if (account.status !== UserStatus.active) {
      await auditService.record({
        action: 'auth.login',
        result: AuditResult.denied,
        targetType: user ? 'user' : 'platform_admin',
        targetId: account._id,
        meta: { reason: 'account_inactive' },
        request: req,
      });
      throw new UnauthorizedError('Account is inactive or disabled');
    }

    // Verify Password
    let passwordValid = false;
    if (account.password_hash) {
      passwordValid = await bcrypt.compare(password, account.password_hash);
    } else if (config.env === 'development') {
      // Dev fallback if user has no password set yet
      passwordValid = password === 'admin123' || password === 'password123';
    }

    if (!passwordValid) {
      await auditService.record({
        action: 'auth.login',
        result: AuditResult.denied,
        targetType: user ? 'user' : 'platform_admin',
        targetId: account._id,
        meta: { reason: 'invalid_credentials' },
        request: req,
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    const clientApplication = explicitApplication || (isPlatformAdmin ? 'platform_admin_dashboard' : 'android');
    const applicationRoleMismatch = isPlatformAdmin
      ? clientApplication !== 'platform_admin_dashboard'
      : clientApplication === 'platform_admin_dashboard';
    if (applicationRoleMismatch) {
      await auditService.record({
        action: 'auth.login',
        result: AuditResult.denied,
        targetType: user ? 'user' : 'platform_admin',
        targetId: account._id,
        meta: { reason: 'client_application_role_mismatch', client_application: clientApplication },
        request: req,
      });
      throw new ForbiddenError(
        clientApplication === 'android'
          ? 'Platform Admin accounts cannot sign in to the Android application'
          : 'Platform Admin Dashboard access requires an active Platform Admin account'
      );
    }

    let sessionId: string | null = null;
    if (user) {
      sessionId = uuidv4();
      user.active_session_id = sessionId;
      // Persist the rotated session for both tenant users and linked Platform Admins.
      // This makes the newly issued token match the server-side active-session guard.
      user.tokens_revoked_at = null;
      await user.save();
    }

    const sub = account.auth_user_id || account._id;
    const accessToken = signAccessToken({
      sub,
      email: account.email,
      role: isPlatformAdmin ? 'platform_admin' : 'user',
      client_application: clientApplication,
      ...(sessionId ? { session_id: sessionId, sid: sessionId } : {}),
    });
    const refreshToken = signRefreshToken({
      sub,
      client_application: clientApplication,
      ...(sessionId ? { session_id: sessionId, sid: sessionId } : {}),
    });

    await auditService.record({
      action: 'auth.login',
      result: AuditResult.success,
      targetType: user ? 'user' : 'platform_admin',
      targetId: account._id,
      meta: { username: account.username || account.email },
      request: req,
    });

    res.json({
      access_token: accessToken,
      token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      session_id: sessionId,
      user: formatUserOut(account, isPlatformAdmin),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/refresh
 */
authRouter.post('/refresh', async (req: Request, res: Response, next) => {
  try {
    const refreshToken = (req.body.refresh_token || '').trim();
    if (!refreshToken) {
      throw new DomainError('Refresh token is required', 400);
    }

    let decoded: any;
    try {
      decoded = await verifyToken(refreshToken, 'refresh');
    } catch (err) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    const sub = decoded.sub;
    const user = await UserModel.findOne({ auth_user_id: sub });
    const platformAdmin = await PlatformAdminModel.findOne({ auth_user_id: sub, status: UserStatus.active });

    const account = user || platformAdmin;
    if (!account) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    if (account.status !== UserStatus.active) {
      throw new UnauthorizedError('Account is inactive or disabled');
    }

    // Check token revocation
    if (isTokenRevoked(decoded.iat, user?.tokens_revoked_at)) {
      throw new UnauthorizedError('Session has been revoked');
    }

    const isPlatformAdmin = Boolean(platformAdmin);
    const requestedApplication = typeof req.body?.client_application === 'string'
      ? req.body.client_application.trim()
      : typeof req.headers['x-client-application'] === 'string'
      ? req.headers['x-client-application'].trim()
      : '';
    const clientApplication = decoded.client_application || requestedApplication || 'android';
    if (
      !['android', 'platform_admin_dashboard'].includes(clientApplication) ||
      (decoded.client_application && requestedApplication && decoded.client_application !== requestedApplication) ||
      (isPlatformAdmin ? clientApplication !== 'platform_admin_dashboard' : clientApplication === 'platform_admin_dashboard')
    ) {
      throw new ForbiddenError('refresh token is not valid for this application or account role');
    }
    let presentedSid = (
      (req.headers['x-session-id'] as string) ||
      req.body.session_id ||
      decoded.session_id ||
      decoded.sid
    );
    if (typeof presentedSid === 'string') {
      presentedSid = presentedSid.trim();
    }

    if (user && user.active_session_id) {
      if (!presentedSid || presentedSid !== user.active_session_id) {
        throw new UnauthorizedError('Session has expired or was terminated by a newer login on another device');
      }
    }

    const effectiveSessionId = user?.active_session_id || null;
    const newAccessToken = signAccessToken({
      sub,
      email: account.email,
      role: platformAdmin ? 'platform_admin' : 'user',
      client_application: clientApplication,
      ...(effectiveSessionId ? { session_id: effectiveSessionId, sid: effectiveSessionId } : {}),
    });
    const newRefreshToken = signRefreshToken({
      sub,
      client_application: clientApplication,
      ...(effectiveSessionId ? { session_id: effectiveSessionId, sid: effectiveSessionId } : {}),
    });

    res.json({
      access_token: newAccessToken,
      token: newAccessToken,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: newRefreshToken,
      session_id: effectiveSessionId,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/logout
 */
authRouter.post('/logout', authenticate, async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext;
    if (ctx && ctx.userId) {
      const user = await UserModel.findById(ctx.userId);
      if (user) {
        user.active_session_id = null;
        user.tokens_revoked_at = new Date();
        await user.save();
      }
    }

    await auditService.record({
      action: 'auth.logout',
      result: AuditResult.success,
      actorUserId: ctx?.userId,
      request: req,
    });

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/recover and POST /auth/forgot-password
 * Self-service password recovery is explicitly disabled per security policy.
 * Only Platform Administrators can initiate password resets.
 */
authRouter.post(['/recover', '/forgot-password'], recoveryLimiter, async (req: Request, res: Response, next) => {
  try {
    await auditService.record({
      action: 'auth.password_recovery_requested',
      result: AuditResult.denied,
      meta: { reason: 'self_service_recovery_disabled' },
      request: req,
    });
    res.status(403).json({
      detail: 'Self-service password recovery is disabled. Password resets can only be initiated by a Platform Administrator.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/reset-password
 * Self-service password reset token consumption is explicitly disabled per security policy.
 */
authRouter.post('/reset-password', passwordLimiter, async (req: Request, res: Response, next) => {
  try {
    await auditService.record({
      action: 'auth.password_reset',
      result: AuditResult.denied,
      meta: { reason: 'self_service_recovery_disabled' },
      request: req,
    });
    res.status(403).json({
      detail: 'Self-service password reset is disabled. Password resets can only be initiated by a Platform Administrator.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/change-password
 * Allows an authenticated user to transition from a temporary password to a permanent password,
 * or change their password while logged in.
 * Enforces current password verification and password strength policy.
 */
authRouter.post('/change-password', passwordLimiter, authenticate, async (req: Request, res: Response, next) => {
  try {
    const { new_password, confirm_password, current_password, old_password, temporary_password } = req.body;
    const password = new_password || req.body.password;
    const currentPass = current_password || old_password || temporary_password;

    if (!password) {
      throw new DomainError('New password is required', 400);
    }
    if (confirm_password && password !== confirm_password) {
      throw new DomainError('Passwords do not match', 400);
    }

    validatePasswordPolicy(password);

    const userId = req.authContext!.userId;
    let user = await UserModel.findById(userId);
    if (!user) {
      user = await UserModel.findOne({ auth_user_id: req.authContext!.authUserId });
    }
    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    // Verify current / temporary password if password_hash is set
    if (user.password_hash) {
      if (!currentPass) {
        await auditService.record({
          action: 'auth.password_change',
          result: AuditResult.denied,
          actorUserId: user._id,
          meta: { reason: 'missing_current_password' },
          request: req,
        });
        throw new DomainError('Current password is required', 400);
      }

      const isMatch = await bcrypt.compare(currentPass, user.password_hash);
      if (!isMatch) {
        await auditService.record({
          action: 'auth.password_change',
          result: AuditResult.denied,
          actorUserId: user._id,
          meta: { reason: 'invalid_current_password' },
          request: req,
        });
        throw new UnauthorizedError('Current password is incorrect');
      }

      // Disallow re-using the exact same password
      const isSame = await bcrypt.compare(password, user.password_hash);
      if (isSame) {
        throw new DomainError('New password must be different from the current password', 400);
      }
    }

    // Hash permanent password and enforce security flags
    const hash = await bcrypt.hash(password, 10);
    user.password_hash = hash;
    user.must_change_password = false;
    const isPlatformAdmin = req.authContext!.role === 'platform_admin';
    const sessionId = uuidv4();
    user.active_session_id = sessionId;
    // Session rotation is the revocation boundary. JWT iat has only second precision,
    // so setting tokens_revoked_at here could also reject the new token issued below.
    // Older tokens (including legacy tokens without a session claim) fail the active-session check.
    user.tokens_revoked_at = null;
    await user.save();

    await auditService.record({
      action: 'auth.password_change',
      result: AuditResult.success,
      actorUserId: user._id,
      companyId: req.authContext!.companyId,
      request: req,
    });

    const sub = user.auth_user_id || user._id;
    const clientApplication = req.authContext!.claims.client_application ||
      (isPlatformAdmin ? 'platform_admin_dashboard' : 'android');
    const newAccessToken = signAccessToken({
      sub,
      email: user.email,
      role: req.authContext!.role || 'user',
      client_application: clientApplication,
      ...(sessionId ? { session_id: sessionId, sid: sessionId } : {}),
    });
    const newRefreshToken = signRefreshToken({
      sub,
      client_application: clientApplication,
      ...(sessionId ? { session_id: sessionId, sid: sessionId } : {}),
    });

    res.json({
      status: 'ok',
      detail: 'Password updated successfully',
      access_token: newAccessToken,
      token: newAccessToken,
      refresh_token: newRefreshToken,
      session_id: sessionId,
    });
  } catch (err) {
    next(err);
  }
});
