import { Request } from 'express';
import { SupportGrantModel } from '../database/models/index.js';
import { SupportGrantScope } from '../types/index.js';

const DOCUMENT_METADATA_PATHS = [
  /^\/quarries\/[^/]+\/documents\/?$/,
  /^\/quarries\/[^/]+\/trash\/?$/,
  /^\/quarries\/[^/]+\/documents\/[^/]+\/versions\/?$/,
  /^\/company\/trash\/?$/,
];

export function supportScopeForTenantRequest(method: string, pathname: string): SupportGrantScope | null {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = pathname.split('?')[0].replace(/\/+$/, '') || '/';
  if (normalizedMethod === 'GET' && /^\/documents\/[^/]+\/download$/.test(normalizedPath)) {
    return SupportGrantScope.document_download;
  }
  if (normalizedMethod === 'GET' && DOCUMENT_METADATA_PATHS.some((pattern) => pattern.test(normalizedPath))) {
    return SupportGrantScope.document_metadata_read;
  }
  return null;
}

export async function findActiveSupportGrant(
  platformAdminId: string,
  companyId: string,
  scope: SupportGrantScope,
  now = new Date()
) {
  return SupportGrantModel.findOne({
    company_id: companyId,
    requested_by_platform_admin_id: platformAdminId,
    status: 'active',
    scopes: scope,
    approved_by_platform_admin_id: { $ne: platformAdminId },
    approved_at: { $ne: null },
    expires_at: { $gt: now, $lte: new Date(now.getTime() + 3600 * 1000) },
    revoked_at: null,
  }).lean();
}

export function requestPathname(req: Request): string {
  return (req.originalUrl || req.path || '').split('?')[0];
}
