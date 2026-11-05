import { Router, Request, Response } from 'express';
import { QuarryModel, QuarryPermissionModel } from '../../database/models/index.js';
import { QuarryStatus, MembershipRole } from '../../types/index.js';
import { authenticate } from '../../middleware/auth.js';
import { getSyncChanges } from '../../services/sync.js';

export const syncRouter = Router();

syncRouter.get('/sync/changes', authenticate, async (req: Request, res: Response, next) => {
  try {
    const ctx = req.authContext!;
    const cursor = (req.query.cursor as string | undefined)?.trim();
    const limit = parseInt(String(req.query.limit || '100'), 10);

    // Determine allowed quarries where user has can_view
    let allowedQuarryIds: string[] = [];
    const activeQuarries = await QuarryModel.find({
      company_id: ctx.companyId,
      status: QuarryStatus.active,
    })
      .select('_id')
      .lean();

    const activeIds = activeQuarries.map((q) => q._id);

    if (ctx.role === MembershipRole.company_admin) {
      allowedQuarryIds = activeIds;
    } else {
      const perms = await QuarryPermissionModel.find({
        user_id: ctx.userId,
        quarry_id: { $in: activeIds },
        can_view: true,
      })
        .select('quarry_id')
        .lean();

      allowedQuarryIds = perms.map((p) => p.quarry_id);
    }

    const result = await getSyncChanges(ctx.companyId, cursor, limit, allowedQuarryIds);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
