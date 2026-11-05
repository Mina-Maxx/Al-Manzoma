import fs from 'fs';

// 1. Patch src/middleware/auth.ts
const authPath = 'C:/Users/Mina Max/Downloads/0xAnub1sX/quarryvault/backend/src/middleware/auth.ts';
let authCode = fs.readFileSync(authPath, 'utf8').replace(/\r\n/g, '\n');

const oldResolve = `export function resolveQuarryPermission(
  permission: QuarryOperationalPermission,
  membership?: Partial<Record<QuarryOperationalPermission, boolean>> | null,
  quarryPermission?: Partial<Record<QuarryOperationalPermission, boolean>> | null
): boolean {
  const defaultAllowed = permission !== 'can_delete';
  const companyAllowed = membership?.[permission] ?? defaultAllowed;
  const quarryAllowed = quarryPermission?.[permission] ?? true;
  return Boolean(companyAllowed && quarryAllowed);
}`;

const newResolve = `export function resolveQuarryPermission(
  permission: QuarryOperationalPermission,
  membership?: (Partial<Record<QuarryOperationalPermission, boolean>> & { role?: string }) | null,
  quarryPermission?: Partial<Record<QuarryOperationalPermission, boolean>> | null
): boolean {
  if (membership?.role === MembershipRole.company_admin || (membership?.role as string) === 'company_admin') {
    return true;
  }
  const defaultAllowed = permission !== 'can_delete';
  const companyAllowed = membership?.[permission] ?? defaultAllowed;
  const quarryAllowed = quarryPermission?.[permission] ?? true;
  return Boolean(companyAllowed && quarryAllowed);
}`;

if (!authCode.includes(oldResolve)) {
  console.error('oldResolve not found in auth.ts');
  process.exit(1);
}
authCode = authCode.replace(oldResolve, newResolve);
fs.writeFileSync(authPath, authCode.replace(/\n/g, '\r\n'), 'utf8');
console.log('auth.ts patched successfully!');

// 2. Patch src/modules/users/router.ts
const usersPath = 'C:/Users/Mina Max/Downloads/0xAnub1sX/quarryvault/backend/src/modules/users/router.ts';
let usersCode = fs.readFileSync(usersPath, 'utf8').replace(/\r\n/g, '\n');

const oldUsersPerm = `    const isPlatformAdmin = (ctx.role as string) === 'platform_admin';
    const usage = ctx.companyId ? await getCompanyUsage(ctx.companyId) : null;

    const effectivePermissions = {
      can_view: true,
      can_upload: true,
      can_download: true,
      can_delete: ctx.role === MembershipRole.company_admin || isPlatformAdmin,
    };`;

const newUsersPerm = `    const isPlatformAdmin = (ctx.role as string) === 'platform_admin';
    const isCompanyAdmin = ctx.role === MembershipRole.company_admin || (ctx.role as string) === 'company_admin';
    const usage = ctx.companyId ? await getCompanyUsage(ctx.companyId) : null;
    const membership = ctx.membership;

    const effectivePermissions = {
      can_view: isPlatformAdmin || isCompanyAdmin || (membership?.can_view ?? true),
      can_upload: isPlatformAdmin || isCompanyAdmin || (membership?.can_upload ?? true),
      can_download: isPlatformAdmin || isCompanyAdmin || (membership?.can_download ?? true),
      can_delete: isPlatformAdmin || isCompanyAdmin || Boolean(membership?.can_delete),
    };`;

if (!usersCode.includes(oldUsersPerm)) {
  console.error('oldUsersPerm not found in users/router.ts');
  process.exit(1);
}
usersCode = usersCode.replace(oldUsersPerm, newUsersPerm);
fs.writeFileSync(usersPath, usersCode.replace(/\n/g, '\r\n'), 'utf8');
console.log('users/router.ts patched successfully!');
