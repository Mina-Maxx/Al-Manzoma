import { describe, it, expect } from 'vitest';
import { resolveQuarryPermission } from '../src/middleware/auth.js';
import { MembershipRole } from '../src/types/index.js';

describe('permission resolution fails closed (can_download default-deny)', () => {
  it('no membership means no access at all', () => {
    for (const p of ['can_view', 'can_upload', 'can_download', 'can_delete'] as const) {
      expect(resolveQuarryPermission(p, undefined)).toBe(false);
      expect(resolveQuarryPermission(p, null)).toBe(false);
    }
  });

  it('a membership missing the can_download flag does not grant downloads (view/upload defaults unchanged)', () => {
    const legacy = { role: MembershipRole.employee } as any;
    expect(resolveQuarryPermission('can_view', legacy)).toBe(true);
    expect(resolveQuarryPermission('can_upload', legacy)).toBe(true);
    expect(resolveQuarryPermission('can_download', legacy)).toBe(false);
    expect(resolveQuarryPermission('can_delete', legacy)).toBe(false);
  });

  it('explicit flags and the quarry-level override behave as before', () => {
    const m = { role: MembershipRole.employee, can_view: true, can_upload: true, can_download: true, can_delete: false } as any;
    expect(resolveQuarryPermission('can_download', m)).toBe(true);
    expect(resolveQuarryPermission('can_download', m, { can_download: false })).toBe(false);
    expect(resolveQuarryPermission('can_download', { ...m, can_download: false }, { can_download: true })).toBe(false);
    expect(resolveQuarryPermission('can_delete', m, { can_delete: true })).toBe(false);
    expect(resolveQuarryPermission('can_download', { role: MembershipRole.company_admin } as any)).toBe(true);
  });
});
