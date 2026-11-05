import { DocumentModel, DocumentVersionModel, CompanyModel } from '../database/models/index.js';
import { DocumentStatus } from '../types/index.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';

export interface QuotaCheckResult {
  usedBytes: number;
  quotaBytes: number;
  availableBytes: number;
}

/**
 * Calculates current company quota usage from company record and verifies with aggregate if needed.
 * Includes both latest documents (DocumentModel) and all retained historical versions (DocumentVersionModel).
 */
export async function getCompanyUsage(companyId: string): Promise<QuotaCheckResult> {
  const company = await CompanyModel.findById(companyId).lean();
  if (!company) {
    throw new NotFoundError('company not found');
  }

  // Aggregate pending/available documents and all retained historical versions
  const [docResult, verResult] = await Promise.all([
    DocumentModel.aggregate([
      {
        $match: {
          company_id: companyId,
          status: { $in: [DocumentStatus.pending, DocumentStatus.available] },
        },
      },
      {
        $group: {
          _id: null,
          totalBytes: { $sum: '$size_bytes' },
        },
      },
    ]),
    DocumentVersionModel.aggregate([
      {
        $match: {
          company_id: companyId,
        },
      },
      {
        $group: {
          _id: null,
          totalBytes: { $sum: '$size_bytes' },
        },
      },
    ]),
  ]);

  const docSum =
    (docResult.length > 0 ? docResult[0].totalBytes : 0) +
    (verResult.length > 0 ? verResult[0].totalBytes : 0);
  // Use maximum of tracked used_bytes and actual version+document sum
  const usedBytes = Math.max(company.used_bytes || 0, docSum);
  const quotaBytes = company.quota_bytes;
  const availableBytes = Math.max(0, quotaBytes - usedBytes);

  return { usedBytes, quotaBytes, availableBytes };
}

/**
 * Atomically reserves quota for a document upload using MongoDB atomic $expr condition.
 * Prevents race conditions and overselling even under concurrent requests.
 */
export async function reserveQuota(
  companyId: string,
  quarryId: string,
  sizeBytes: number,
  metadata: {
    displayName: string;
    originalFilename: string;
    mimeType: string;
    sha256?: string;
    uploadedBy?: string;
    folderId?: string | null;
  }
) {
  // First ensure company exists
  const company = await CompanyModel.findById(companyId);
  if (!company) {
    throw new NotFoundError('company not found');
  }

  // Atomically check and increment used_bytes
  const updatedCompany = await CompanyModel.findOneAndUpdate(
    {
      _id: companyId,
      $expr: {
        $lte: [{ $add: [{ $ifNull: ['$used_bytes', 0] }, sizeBytes] }, '$quota_bytes'],
      },
    },
    {
      $inc: { used_bytes: sizeBytes },
    },
    { new: true }
  );

  if (!updatedCompany) {
    throw new ConflictError('company storage quota exceeded');
  }

  try {
    const document = await DocumentModel.create({
      company_id: companyId,
      quarry_id: quarryId,
      folder_id: metadata.folderId || null,
      display_name: metadata.displayName,
      original_filename: metadata.originalFilename,
      mime_type: metadata.mimeType,
      size_bytes: sizeBytes,
      sha256: metadata.sha256 || null,
      status: DocumentStatus.pending,
      uploaded_by: metadata.uploadedBy || null,
      version: 1,
    });

    return document;
  } catch (err) {
    // Release reservation on failure
    await releaseQuota(companyId, sizeBytes);
    throw err;
  }
}

/**
 * Atomically reserves quota bytes without creating a pending document record.
 * Useful for document versioning or metadata updates.
 */
export async function reserveQuotaBytes(companyId: string, sizeBytes: number): Promise<void> {
  const company = await CompanyModel.findById(companyId);
  if (!company) {
    throw new NotFoundError('company not found');
  }

  const updatedCompany = await CompanyModel.findOneAndUpdate(
    {
      _id: companyId,
      $expr: {
        $lte: [{ $add: [{ $ifNull: ['$used_bytes', 0] }, sizeBytes] }, '$quota_bytes'],
      },
    },
    {
      $inc: { used_bytes: sizeBytes },
    },
    { new: true }
  );

  if (!updatedCompany) {
    throw new ConflictError('company storage quota exceeded');
  }
}

/**
 * Releases reserved quota (e.g. on upload failure or document deletion).
 */
export async function releaseQuota(companyId: string, sizeBytes: number): Promise<void> {
  await CompanyModel.findByIdAndUpdate(companyId, {
    $inc: { used_bytes: -Math.abs(sizeBytes) },
  });
}
