import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { AppReleaseModel } from '../../database/models/index.js';
import { NotFoundError } from '../../middleware/errors.js';
import { storage } from '../storage/index.js';
import { pipeToResponse } from '../../utils/pipeResponse.js';
import { auditService } from '../audit/service.js';
import { AuditResult } from '../../types/index.js';
import { buildContentDisposition } from '../../utils/contentDisposition.js';

export const updatesRouter = Router();

/**
 * GET /app/updates/latest
 */
updatesRouter.get('/app/updates/latest', async (req: Request, res: Response, next) => {
  try {
    const currentVersionCode = parseInt(String(req.query.current_version_code || req.headers['x-app-version-code'] || '0'), 10);
    const release = await AppReleaseModel.findOne({ is_withdrawn: false }).sort({ version_code: -1 }).lean();

    if (!release) {
      throw new NotFoundError('no releases published');
    }

    // Explicit Policy Check:
    // Only releases explicitly marked as mandatory require an update.
    // Releases without an explicit policy or legacy releases safely default to optional.
    const isExplicitMandatory = release.update_policy === 'mandatory' || release.update_required === true;

    // Minimum supported version enforcement:
    // Only enforce if minimum_supported_version_code is explicitly configured and strictly greater than 1,
    // and currentVersionCode is less than minimum_supported_version_code.
    // Guard against legacy records where minimum_supported_version_code was defaulted to release.version_code on an optional update.
    const isMinSupportedViolated = release.minimum_supported_version_code != null &&
      release.minimum_supported_version_code > 1 &&
      currentVersionCode > 0 &&
      currentVersionCode < release.minimum_supported_version_code &&
      (isExplicitMandatory || release.minimum_supported_version_code < release.version_code);

    const updateRequired = isExplicitMandatory || isMinSupportedViolated;

    res.json({
      version_code: release.version_code,
      version_name: release.version_name,
      release_notes: release.release_notes || null,
      minimum_supported_version_code: release.minimum_supported_version_code ?? 1,
      update_required: updateRequired,
      is_mandatory: updateRequired,
      update_policy: isExplicitMandatory ? 'mandatory' : 'optional',
      apk_url: `/app/updates/download/${release.version_code}`,
      apk_size_bytes: release.apk_size_bytes,
      sha256: release.sha256,
      published_at: release.created_at,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /app/updates/download/:versionCode
 */
updatesRouter.get('/app/updates/download/:versionCode', async (req: Request, res: Response, next) => {
  try {
    const identifier = String(req.params.versionCode);
    const numericVersion = parseInt(identifier, 10);

    let release;
    if (!isNaN(numericVersion)) {
      release = await AppReleaseModel.findOne({ version_code: numericVersion, is_withdrawn: false }).lean();
    }
    if (!release && mongoose.Types.ObjectId.isValid(identifier)) {
      release = await AppReleaseModel.findOne({ _id: identifier, is_withdrawn: false }).lean();
    }

    if (!release) {
      throw new NotFoundError('Release not found or withdrawn');
    }

    let file;
    try {
      file = await storage.get(release.storage_ref);
    } catch (_storageErr) {
      throw new NotFoundError('Release artifact file missing from storage');
    }

    if (!file || !file.stream) {
      throw new NotFoundError('Release artifact file missing from storage');
    }

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', buildContentDisposition(release.apk_filename));
    if (release.apk_size_bytes) {
      res.setHeader('Content-Length', release.apk_size_bytes);
    }
    res.setHeader('ETag', `"${release.sha256}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

    // Audit download without exposing credentials
    await auditService.record({
      action: 'app_release.download',
      result: AuditResult.success,
      targetId: String(release._id),
      targetType: 'app_release',
      meta: {
        version_code: release.version_code,
        sha256: release.sha256,
      },
    }).catch(() => {});

    pipeToResponse(file.stream as any, res, next);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /app/config
 */
updatesRouter.get('/app/config', async (_req: Request, res: Response, next) => {
  try {
    const latestRelease = await AppReleaseModel.findOne({ is_withdrawn: false }).sort({ version_code: -1 }).lean();

    let minSupported = 1;
    if (latestRelease) {
      const isMand = latestRelease.update_policy === 'mandatory' || latestRelease.update_required === true;
      if (isMand) {
        minSupported = latestRelease.minimum_supported_version_code || 1;
      } else if (latestRelease.minimum_supported_version_code && latestRelease.minimum_supported_version_code < latestRelease.version_code) {
        minSupported = latestRelease.minimum_supported_version_code;
      }
    }

    res.json({
      config_version: '1.0.0',
      server_time: new Date().toISOString(),
      minimum_supported_version_code: minSupported,
      latest_version_code: latestRelease ? latestRelease.version_code : 1,
      maintenance_mode: false,
      maintenance_message: null,
      features: {
        document_scanner: true,
        trash_recovery: true,
      },
      limits: {
        max_file_size_bytes: 10485760,
      },
    });
  } catch (err) {
    next(err);
  }
});
