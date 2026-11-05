import React, { useState, useEffect, useCallback } from 'react';
import { translations as t, formatDate, fmtBytes } from '../lib/i18n';
import {
  UserSession,
  PlatformBackupItem,
  PlatformRestoreItem,
  PlatformBackupOverview,
} from '../lib/types';
import { ApiClient } from '../lib/api';

interface BackupRecoveryProps {
  session?: UserSession | null;
}

export const BackupRecovery: React.FC<BackupRecoveryProps> = () => {
  const [overview, setOverview] = useState<PlatformBackupOverview | null>(null);
  const [backups, setBackups] = useState<PlatformBackupItem[]>([]);
  const [restores, setRestores] = useState<PlatformRestoreItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Modals & Target Selection
  const [manifestBackup, setManifestBackup] = useState<PlatformBackupItem | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<PlatformBackupItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PlatformBackupItem | null>(null);

  // Restore Modal State
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [createSafetyBackup, setCreateSafetyBackup] = useState(true);
  const [restoreProgress, setRestoreProgress] = useState<string | null>(null);

  // Status & Error Banners
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const [ovData, listData, histData] = await Promise.all([
        ApiClient.getPlatformBackupOverview(),
        ApiClient.getPlatformBackups(),
        ApiClient.getPlatformRestoreHistory(),
      ]);
      setOverview(ovData);
      setBackups(listData);
      setRestores(histData);
    } catch (err: any) {
      setErrorMsg(err.message || 'تعذر تحميل معلومات النسخ الاحتياطي للمنصة');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle Full Backup Creation
  const handleCreateBackup = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const newBackup = await ApiClient.createPlatformBackup();
      setSuccessMsg(`تم إنشاء الأرشيف بنجاح: ${newBackup.filename} (${newBackup.status})`);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err.message || 'فشل إنشاء النسخة الاحتياطية للمنصة');
    } finally {
      setActionLoading(false);
    }
  };

  // Handle Archive Verification
  const handleVerify = async (backup: PlatformBackupItem) => {
    setVerifyingId(backup.backupId);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      await ApiClient.verifyPlatformBackup(backup.backupId);
      setSuccessMsg(`تم التحقق بنجاح من سلامة الأرشيف ${backup.backupId} ومطابقة SHA-256.`);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err.message || `فشل التحقق من الأرشيف ${backup.backupId}`);
    } finally {
      setVerifyingId(null);
    }
  };

  // Handle Authenticated Download
  const handleDownload = async (backup: PlatformBackupItem) => {
    setDownloadingId(backup.backupId);
    setErrorMsg('');
    try {
      await ApiClient.downloadBackupArchive(backup.backupId, backup.filename);
      setSuccessMsg(`تم بدء تحميل الأرشيف: ${backup.filename}`);
    } catch (err: any) {
      setErrorMsg(err.message || `فشل تحميل الأرشيف ${backup.filename}`);
    } finally {
      setDownloadingId(null);
    }
  };

  // Handle Execute Platform Restore
  const handleExecuteRestore = async () => {
    if (!restoreTarget) return;
    if (confirmPhrase.trim() !== 'RESTORE-QUARRYVAULT') {
      setErrorMsg('العبارة التأكيدية غير صحيحة. يرجى إدخال RESTORE-QUARRYVAULT بالضبط.');
      return;
    }

    setActionLoading(true);
    setRestoreProgress('جاري أخذ نسخة أمان احتياطية واستعادة المنصة...');
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const res = await ApiClient.restorePlatformBackup(restoreTarget.backupId, {
        confirmationPhrase: confirmPhrase.trim(),
        createSafetyBackup,
      });

      setSuccessMsg(
        `تمت استعادة المنصة بنجاح من النسخة ${restoreTarget.backupId}. التحقق من المراجع: ${res.referenceVerificationStatus}.`
      );
      setRestoreTarget(null);
      setConfirmPhrase('');
      await loadData();
    } catch (err: any) {
      setErrorMsg(err.message || 'فشلت عملية استعادة المنصة');
    } finally {
      setActionLoading(false);
      setRestoreProgress(null);
    }
  };

  // Handle Execute Backup Deletion
  const handleExecuteDelete = async () => {
    if (!deleteTarget) return;
    setActionLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const res = await ApiClient.deletePlatformBackup(deleteTarget.backupId);
      setSuccessMsg(res.message || 'تم حذف النسخة الاحتياطية بنجاح');
      setDeleteTarget(null);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err.message || 'فشل حذف أرشيف النسخة الاحتياطية');
    } finally {
      setActionLoading(false);
    }
  };

  // Handle Manual Retention Pruning
  const handleRunRetention = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const res = await ApiClient.runRetentionPolicy();
      setSuccessMsg(`تم تطبيق سياسة الاحتفاظ. تم فحص ${res.evaluated} نسخة وحذف ${res.deletedCount} أرشيف منتهي.`);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err.message || 'فشل تطبيق سياسة الاحتفاظ');
    } finally {
      setActionLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'verified':
        return <span className="badge badge-success">{t.verified}</span>;
      case 'completed':
        return <span className="badge" style={{ background: '#dbeafe', color: '#1e40af' }}>{t.completed}</span>;
      case 'in_progress':
      case 'pending':
        return <span className="badge badge-warning">{t.inProgress}</span>;
      case 'failed':
      case 'corrupted':
        return <span className="badge badge-danger">{t.failed}</span>;
      default:
        return <span className="badge">{status}</span>;
    }
  };

  const getTypeBadge = (type: string, isSafety: boolean) => {
    if (isSafety || type === 'safety') {
      return <span className="badge" style={{ background: '#fef3c7', color: '#b45309' }}>{t.safetyBackup}</span>;
    }
    if (type === 'scheduled') {
      return <span className="badge" style={{ background: '#ede9fe', color: '#6d28d9' }}>{t.scheduledBackup}</span>;
    }
    return <span className="badge" style={{ background: '#e0f2fe', color: '#0369a1' }}>{t.fullBackup}</span>;
  };

  return (
    <div className="backup-recovery-container">
      {/* Header Bar */}
      <div className="spread" style={{ marginBottom: '16px' }}>
        <div>
          <h2>{t.backupTitle}</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {t.backupSubtitle}
          </p>
        </div>
        <div className="row">
          <button
            className="button"
            onClick={handleRunRetention}
            disabled={loading || actionLoading}
            style={{ fontSize: '13px' }}
          >
            {t.runRetentionNow}
          </button>
          <button
            className="button primary"
            onClick={handleCreateBackup}
            disabled={loading || actionLoading}
            style={{ fontWeight: 600 }}
          >
            {actionLoading ? t.creatingBackup : `+ ${t.createFullBackup}`}
          </button>
        </div>
      </div>

      {/* Notifications */}
      {errorMsg && (
        <div className="card" style={{ borderColor: 'var(--danger)', background: '#fef2f2', color: '#991b1b', marginBottom: '16px' }}>
          <strong>رسالة خطأ:</strong> {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="card" style={{ borderColor: 'var(--success)', background: '#f0fdf4', color: '#166534', marginBottom: '16px' }}>
          <strong>نجاح:</strong> {successMsg}
        </div>
      )}

      {/* Disaster Recovery KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '16px',
          marginBottom: '20px',
        }}
      >
        {/* RPO KPI */}
        <div className="card" style={{ margin: 0 }}>
          <div className="spread">
            <span className="muted">{t.rpoStatus}</span>
            <span
              className={`badge ${
                overview?.rpoStatus === 'compliant'
                  ? 'badge-success'
                  : overview?.rpoStatus === 'warning'
                  ? 'badge-warning'
                  : 'badge-danger'
              }`}
            >
              {overview?.rpoStatus === 'compliant'
                ? t.rpoCompliant
                : overview?.rpoStatus === 'warning'
                ? t.rpoWarning
                : t.rpoCritical}
            </span>
          </div>
          <div style={{ fontSize: '24px', fontWeight: 700, margin: '8px 0 4px' }}>
            {overview?.rpoHoursSinceLastBackup !== null && overview?.rpoHoursSinceLastBackup !== undefined
              ? `${overview.rpoHoursSinceLastBackup}h`
              : 'N/A'}
          </div>
          <span className="muted" style={{ fontSize: '12px' }}>
            الهدف الأقصى للفقد: ≤ {overview?.targetRpoHours || 4} ساعات
          </span>
        </div>

        {/* RTO KPI */}
        <div className="card" style={{ margin: 0 }}>
          <div className="spread">
            <span className="muted">{t.rtoEstimate}</span>
            <span className="badge badge-success">Target: ≤ 2h</span>
          </div>
          <div style={{ fontSize: '24px', fontWeight: 700, margin: '8px 0 4px', color: '#1e3a8a' }}>
            ~{overview?.estimatedRtoMinutes || 15} min
          </div>
          <span className="muted" style={{ fontSize: '12px' }}>
            الاستعادة الآلية المختبرة: قاعدة البيانات وتخزين الملفات
          </span>
        </div>

        {/* Archives Count KPI */}
        <div className="card" style={{ margin: 0 }}>
          <div className="spread">
            <span className="muted">{t.totalBackupsCount}</span>
            <span className="badge" style={{ background: '#e0f2fe', color: '#0369a1' }}>
              {overview?.verifiedBackups || 0} {t.verified}
            </span>
          </div>
          <div style={{ fontSize: '24px', fontWeight: 700, margin: '8px 0 4px' }}>
            {overview?.totalBackups || backups.length}
          </div>
          <span className="muted" style={{ fontSize: '12px' }}>
            {overview?.verifiedBackups || 0} أرشيف مفحوص ومطابق
          </span>
        </div>

        {/* Last Successful Backup */}
        <div className="card" style={{ margin: 0 }}>
          <div className="spread">
            <span className="muted">{t.lastSuccessfulBackup}</span>
            <span className="badge" style={{ background: '#f1f5f9' }}>
              {overview?.config?.scheduledIntervalHours || 4}h {t.scheduledBackup}
            </span>
          </div>
          <div style={{ fontSize: '15px', fontWeight: 600, margin: '10px 0 4px' }}>
            {overview?.lastBackupAt ? formatDate(overview.lastBackupAt) : 'لا يوجد بعد'}
          </div>
          <span className="muted" style={{ fontSize: '12px' }}>
            {overview?.lastSuccessfulBackup?.filename || 'بانتظار النسخة الأولى'}
          </span>
        </div>
      </div>

      {/* Retention Scheme Summary Banner */}
      <div
        className="card"
        style={{
          background: '#f8fafc',
          borderRight: '4px solid var(--accent)',
          marginTop: 0,
          marginBottom: '20px',
          padding: '14px 20px',
        }}
      >
        <div className="spread">
          <div>
            <h4 style={{ margin: '0 0 4px', fontSize: '14px' }}>{t.retentionPolicyTitle}</h4>
            <p className="muted" style={{ margin: 0, fontSize: '13px' }}>
              {t.retentionPolicyDescription}
            </p>
          </div>
          <div className="row" style={{ gap: '8px' }}>
            <span className="badge" style={{ background: '#e2e8f0', color: '#334155' }}>
              7 {t.daily}
            </span>
            <span className="badge" style={{ background: '#e2e8f0', color: '#334155' }}>
              4 {t.weekly}
            </span>
            <span className="badge" style={{ background: '#e2e8f0', color: '#334155' }}>
              3 {t.monthly}
            </span>
          </div>
        </div>
      </div>

      {/* Backups List Table */}
      <div className="card" style={{ marginTop: 0 }}>
        <div className="spread" style={{ marginBottom: '14px' }}>
          <h3>{t.backupHistory}</h3>
          <span className="muted" style={{ fontSize: '13px' }}>
            {backups.length} أرشيف متاح
          </span>
        </div>

        {backups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '36px', color: 'var(--muted)' }}>
            <p>لا توجد أي أرشيفات للنسخ الاحتياطي حتى الآن.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--line)' }}>
                  <th style={{ padding: '10px 12px' }}>{t.backupId}</th>
                  <th style={{ padding: '10px 12px' }}>{t.backupType}</th>
                  <th style={{ padding: '10px 12px' }}>تاريخ الإنشاء</th>
                  <th style={{ padding: '10px 12px' }}>{t.backupStatus}</th>
                  <th style={{ padding: '10px 12px' }}>{t.databaseStatus} / {t.storageStatus}</th>
                  <th style={{ padding: '10px 12px' }}>{t.backupSize}</th>
                  <th style={{ padding: '10px 12px' }}>{t.retentionTier}</th>
                  <th style={{ padding: '10px 12px', textAlign: 'center' }}>{t.actions}</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr
                    key={b._id || b.backupId}
                    style={{
                      borderBottom: '1px solid var(--line)',
                      background: b.isSafetyBackup ? '#fffdf7' : 'transparent',
                    }}
                  >
                    {/* Backup ID & Filename */}
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: '13px' }}>
                        {b.backupId}
                      </div>
                      <div className="muted" style={{ fontSize: '11px', marginTop: '2px' }}>
                        {b.filename}
                      </div>
                    </td>

                    {/* Type Badge */}
                    <td style={{ padding: '10px 12px' }}>
                      {getTypeBadge(b.type, b.isSafetyBackup)}
                    </td>

                    {/* Date & Duration */}
                    <td style={{ padding: '10px 12px', fontSize: '13px' }}>
                      <div>{formatDate(b.createdAt)}</div>
                      {b.durationMs ? (
                        <div className="muted" style={{ fontSize: '11px' }}>
                          {t.duration}: {(b.durationMs / 1000).toFixed(1)}s
                        </div>
                      ) : null}
                    </td>

                    {/* Overall Status */}
                    <td style={{ padding: '10px 12px' }}>
                      {getStatusBadge(b.status)}
                    </td>

                    {/* DB & Storage Components */}
                    <td style={{ padding: '10px 12px', fontSize: '12px' }}>
                      <div>
                        <strong>قاعدة البيانات:</strong>{' '}
                        <span style={{ color: b.dbStatus === 'completed' ? 'var(--success)' : 'inherit' }}>
                          {b.dbStatus === 'completed' ? t.completed : b.dbStatus === 'failed' ? t.failed : b.dbStatus}
                        </span>
                      </div>
                      <div>
                        <strong>مخزن الملفات:</strong>{' '}
                        <span style={{ color: b.storageStatus === 'completed' ? 'var(--success)' : 'inherit' }}>
                          {b.storageStatus === 'completed' ? t.completed : b.storageStatus === 'failed' ? t.failed : b.storageStatus}
                        </span>
                      </div>
                    </td>

                    {/* Size */}
                    <td style={{ padding: '10px 12px', fontSize: '13px', fontWeight: 500 }}>
                      {fmtBytes(b.archiveSizeBytes || 0)}
                    </td>

                    {/* Retention Tier */}
                    <td style={{ padding: '10px 12px' }}>
                      <span className="badge" style={{ background: '#f1f5f9', fontSize: '11px' }}>
                        {b.retentionTier}
                        {b.isRestoreLocked ? ` (${t.locked})` : ''}
                      </span>
                    </td>

                    {/* Action Buttons */}
                    <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                      <div className="row" style={{ justifyContent: 'center', gap: '6px' }}>
                        {/* Verify button */}
                        <button
                          className="button"
                          onClick={() => handleVerify(b)}
                          disabled={verifyingId === b.backupId || actionLoading}
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          title={t.verifyBackup}
                        >
                          {verifyingId === b.backupId ? '...' : 'فحص'}
                        </button>

                        {/* Download button */}
                        <button
                          className="button"
                          onClick={() => handleDownload(b)}
                          disabled={downloadingId === b.backupId || actionLoading}
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          title={t.downloadArchive}
                        >
                          {downloadingId === b.backupId ? '...' : 'تحميل'}
                        </button>

                        {/* Restore button */}
                        <button
                          className="button"
                          onClick={() => {
                            setRestoreTarget(b);
                            setConfirmPhrase('');
                            setCreateSafetyBackup(true);
                          }}
                          disabled={actionLoading}
                          style={{
                            padding: '4px 8px',
                            fontSize: '12px',
                            background: '#fee2e2',
                            borderColor: '#fca5a5',
                            color: '#b91c1c',
                            fontWeight: 600,
                          }}
                          title={t.restoreBackup}
                        >
                          استعادة
                        </button>

                        {/* Manifest / Details button */}
                        <button
                          className="button"
                          onClick={() => setManifestBackup(b)}
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          title={t.viewManifest}
                        >
                          البيان
                        </button>

                        {/* Delete button */}
                        <button
                          className="button"
                          onClick={() => setDeleteTarget(b)}
                          disabled={b.isSafetyBackup || b.isRestoreLocked || actionLoading}
                          style={{
                            padding: '4px 8px',
                            fontSize: '12px',
                            color: b.isSafetyBackup || b.isRestoreLocked ? 'var(--muted)' : 'var(--danger)',
                          }}
                          title={
                            b.isSafetyBackup
                              ? 'نسخة الأمان محمية من الحذف'
                              : b.isRestoreLocked
                              ? 'نسخة مرتبطة باستعادة نشطة'
                              : t.deleteBackup
                          }
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Restore History Table */}
      {restores.length > 0 && (
        <div className="card" style={{ marginTop: '20px' }}>
          <div className="spread" style={{ marginBottom: '14px' }}>
            <h3>{t.restoreHistory}</h3>
            <span className="muted" style={{ fontSize: '13px' }}>
              {restores.length} عملية استعادة مسجلة
            </span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--line)' }}>
                  <th style={{ padding: '8px 12px' }}>معرّف الاستعادة</th>
                  <th style={{ padding: '8px 12px' }}>معرّف النسخة</th>
                  <th style={{ padding: '8px 12px' }}>تاريخ البدء</th>
                  <th style={{ padding: '8px 12px' }}>{t.status}</th>
                  <th style={{ padding: '8px 12px' }}>حالة قاعدة البيانات</th>
                  <th style={{ padding: '8px 12px' }}>حالة التخزين</th>
                  <th style={{ padding: '8px 12px' }}>فحص المراجع</th>
                  <th style={{ padding: '8px 12px' }}>{t.duration}</th>
                </tr>
              </thead>
              <tbody>
                {restores.map((r) => (
                  <tr key={r._id || r.restoreId} style={{ borderBottom: '1px solid var(--line)', fontSize: '13px' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{r.restoreId}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{r.backupId}</td>
                    <td style={{ padding: '8px 12px' }}>{formatDate(r.startedAt)}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span className={`badge ${r.status === 'completed' ? 'badge-success' : 'badge-danger'}`}>
                        {r.status === 'completed' ? t.completed : r.status === 'failed' ? t.failed : r.status}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px' }}>{r.dbStatus === 'completed' ? t.completed : r.dbStatus === 'failed' ? t.failed : r.dbStatus}</td>
                    <td style={{ padding: '8px 12px' }}>{r.storageStatus === 'completed' ? t.completed : r.storageStatus === 'failed' ? t.failed : r.storageStatus}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span className={`badge ${r.referenceVerificationStatus === 'passed' ? 'badge-success' : 'badge-warning'}`}>
                        {r.referenceVerificationStatus === 'passed' ? 'ناجح ومطابق' : r.referenceVerificationStatus}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : 'N/A'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* RESTORE CONFIRMATION MODAL */}
      {restoreTarget && (
        <div className="modal-backdrop open">
          <div className="modal-box modal-box-lg" style={{ maxWidth: '640px', padding: '24px' }}>
            {/* Modal Warning Header */}
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#991b1b', fontWeight: 700, fontSize: '16px' }}>
                <span>⚠️</span>
                <span>{t.restoreWarningTitle}</span>
              </div>
              <p style={{ margin: '8px 0 0', color: '#7f1d1d', fontSize: '13px', lineHeight: 1.5 }}>
                {t.restoreWarningMessage}
              </p>
            </div>

            {/* Target Backup Overview Box */}
            <div
              style={{
                background: '#f8fafc',
                border: '1px solid var(--line)',
                borderRadius: '8px',
                padding: '12px 16px',
                marginBottom: '16px',
                fontSize: '13px',
              }}
            >
              <div className="spread">
                <span className="muted">{t.backupId}:</span>
                <strong style={{ fontFamily: 'monospace' }}>{restoreTarget.backupId}</strong>
              </div>
              <div className="spread" style={{ marginTop: '6px' }}>
                <span className="muted">تاريخ النسخة:</span>
                <span>{formatDate(restoreTarget.createdAt)}</span>
              </div>
              <div className="spread" style={{ marginTop: '6px' }}>
                <span className="muted">{t.backupSize}:</span>
                <span>{fmtBytes(restoreTarget.archiveSizeBytes || 0)}</span>
              </div>
              {restoreTarget.manifest && (
                <div className="spread" style={{ marginTop: '6px' }}>
                  <span className="muted">محتويات الأرشيف:</span>
                  <span>
                    {restoreTarget.manifest.database?.totalCollections || 15} جدول،{' '}
                    {restoreTarget.manifest.storage?.totalObjects || 0} ملف
                  </span>
                </div>
              )}
            </div>

            {/* Safety Backup Checkbox */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={createSafetyBackup}
                  onChange={(e) => setCreateSafetyBackup(e.target.checked)}
                />
                <span style={{ fontWeight: 600 }}>{t.createSafetyBackupBeforeRestore}</span>
              </label>
            </div>

            {/* Explicit Confirmation Input */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '13px', marginBottom: '6px' }}>
                {t.restoreConfirmPrompt}
              </label>
              <input
                type="text"
                value={confirmPhrase}
                onChange={(e) => setConfirmPhrase(e.target.value)}
                placeholder="RESTORE-QUARRYVAULT"
                style={{
                  width: '100%',
                  fontFamily: 'monospace',
                  fontSize: '14px',
                  borderColor: confirmPhrase === 'RESTORE-QUARRYVAULT' ? 'var(--success)' : 'var(--line)',
                  letterSpacing: '1px',
                }}
                disabled={actionLoading}
              />
              <span className="muted" style={{ fontSize: '12px', marginTop: '4px', display: 'block' }}>
                اكتب RESTORE-QUARRYVAULT بالأحرف الإنجليزية الكبيرة تماماً.
              </span>
            </div>

            {/* In-Progress Progress Status */}
            {restoreProgress && (
              <div style={{ padding: '12px', background: '#eff6ff', borderRadius: '8px', marginBottom: '16px', color: '#1e40af', fontSize: '13px' }}>
                <strong>{restoreProgress}</strong>
              </div>
            )}

            {/* Modal Actions */}
            <div className="spread" style={{ justifyContent: 'flex-end', gap: '12px' }}>
              <button
                className="button"
                onClick={() => {
                  setRestoreTarget(null);
                  setConfirmPhrase('');
                }}
                disabled={actionLoading}
              >
                إلغاء
              </button>
              <button
                className="button"
                onClick={handleExecuteRestore}
                disabled={confirmPhrase.trim() !== 'RESTORE-QUARRYVAULT' || actionLoading}
                style={{
                  background: confirmPhrase.trim() === 'RESTORE-QUARRYVAULT' ? 'var(--danger)' : '#cbd5e1',
                  color: '#ffffff',
                  borderColor: 'transparent',
                  fontWeight: 700,
                  padding: '8px 18px',
                }}
              >
                {actionLoading ? t.restoringBackup : t.confirmRestoreButton}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MANIFEST / ARCHIVE DETAILS MODAL */}
      {manifestBackup && (
        <div className="modal-backdrop open">
          <div className="modal-box modal-box-lg" style={{ maxWidth: '680px', padding: '24px' }}>
            <div className="spread" style={{ marginBottom: '16px' }}>
              <h3 style={{ margin: 0 }}>{t.manifestTitle}</h3>
              <button
                className="button"
                onClick={() => setManifestBackup(null)}
                style={{ padding: '2px 8px' }}
              >
                ✕
              </button>
            </div>

            {/* General Info */}
            <div
              style={{
                background: '#f8fafc',
                padding: '12px 16px',
                borderRadius: '8px',
                marginBottom: '16px',
                fontSize: '13px',
                border: '1px solid var(--line)',
              }}
            >
              <div className="spread" style={{ padding: '4px 0' }}>
                <span className="muted">{t.backupId}:</span>
                <strong style={{ fontFamily: 'monospace' }}>{manifestBackup.backupId}</strong>
              </div>
              <div className="spread" style={{ padding: '4px 0' }}>
                <span className="muted">{t.checksumSha256}:</span>
                <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{manifestBackup.sha256Checksum}</span>
              </div>
              <div className="spread" style={{ padding: '4px 0' }}>
                <span className="muted">{t.backupSize}:</span>
                <span>{fmtBytes(manifestBackup.archiveSizeBytes || 0)}</span>
              </div>
              <div className="spread" style={{ padding: '4px 0' }}>
                <span className="muted">إصدار المنصة والتطبيق:</span>
                <span>{manifestBackup.manifest?.appVersion || '1.0.13'}</span>
              </div>
              <div className="spread" style={{ padding: '4px 0' }}>
                <span className="muted">إصدار البيان:</span>
                <span>{manifestBackup.manifest?.manifestVersion || '1.0'}</span>
              </div>
            </div>

            {/* Database Collections Inventory */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '14px', borderBottom: '1px solid var(--line)', paddingBottom: '4px' }}>
                {t.databaseCollections} (
                {manifestBackup.manifest?.database?.totalCollections || Object.keys(manifestBackup.manifest?.database?.collectionCounts || {}).length || 15}
                )
              </h4>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  gap: '8px',
                  maxHeight: '160px',
                  overflowY: 'auto',
                  background: '#f8fafc',
                  padding: '10px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                }}
              >
                {manifestBackup.manifest?.database?.collectionCounts &&
                  Object.entries(manifestBackup.manifest.database.collectionCounts).map(([col, cnt]) => (
                    <div key={col} className="spread" style={{ fontSize: '12px', padding: '2px 4px' }}>
                      <span style={{ fontFamily: 'monospace' }}>{col}:</span>
                      <strong>{cnt}</strong>
                    </div>
                  ))}
              </div>
            </div>

            {/* Storage Inventory */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '14px', borderBottom: '1px solid var(--line)', paddingBottom: '4px' }}>
                {t.storageObjects}
              </h4>
              <div
                style={{
                  background: '#f8fafc',
                  padding: '10px 14px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  fontSize: '13px',
                }}
              >
                <div className="spread">
                  <span className="muted">إجمالي الملفات المخزنة:</span>
                  <strong>{manifestBackup.manifest?.storage?.totalObjects ?? 0}</strong>
                </div>
                <div className="spread" style={{ marginTop: '4px' }}>
                  <span className="muted">إجمالي حجم الملفات:</span>
                  <strong>{fmtBytes(manifestBackup.manifest?.storage?.totalBytes || 0)}</strong>
                </div>
              </div>
            </div>

            <div className="spread" style={{ justifyContent: 'flex-end' }}>
              <button className="button" onClick={() => setManifestBackup(null)}>
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {deleteTarget && (
        <div className="modal-backdrop open">
          <div className="modal-box" style={{ maxWidth: '480px', padding: '20px' }}>
            <h3 style={{ color: 'var(--danger)', marginTop: 0 }}>{t.confirmDeleteBackupTitle}</h3>
            <p style={{ fontSize: '13px', color: 'var(--text)' }}>
              {t.confirmDeleteBackupMessage}
            </p>
            <div
              style={{
                background: '#f8fafc',
                padding: '10px',
                borderRadius: '6px',
                fontSize: '13px',
                marginBottom: '14px',
                fontFamily: 'monospace',
              }}
            >
              {deleteTarget.filename} ({fmtBytes(deleteTarget.archiveSizeBytes || 0)})
            </div>
            <p className="muted" style={{ fontSize: '12px' }}>
              {t.deleteProtectionNotice}
            </p>
            <div className="spread" style={{ justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button className="button" onClick={() => setDeleteTarget(null)} disabled={actionLoading}>
                إلغاء
              </button>
              <button
                className="button btn-danger"
                onClick={handleExecuteDelete}
                disabled={actionLoading}
              >
                {actionLoading ? '...' : 'حذف نهائي'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
