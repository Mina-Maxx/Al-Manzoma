import React, { useState } from 'react';
import { translations as t, formatDate, fmtBytes } from '../lib/i18n';
import { AppRelease } from '../lib/types';
import { ApiClient } from '../lib/api';

interface AppReleasesProps {
  releases: AppRelease[];
  onRefresh: () => void;
}

export const AppReleases: React.FC<AppReleasesProps> = ({ releases, onRefresh }) => {
  const [showPublish, setShowPublish] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [versionCode, setVersionCode] = useState('');
  const [versionName, setVersionName] = useState('');
  const [minSupported, setMinSupported] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [updatePolicy, setUpdatePolicy] = useState<'optional' | 'mandatory'>('optional');
  const [loading, setLoading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setErrorMsg(t.noFileSelected);
      return;
    }
    setLoading(true);
    setErrorMsg('');
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('version_code', versionCode.trim());
      formData.append('version_name', versionName.trim());
      if (minSupported.trim()) {
        formData.append('minimum_supported_version_code', minSupported.trim());
      }
      formData.append('update_policy', updatePolicy);
      formData.append('update_required', updatePolicy === 'mandatory' ? 'true' : 'false');
      formData.append('is_mandatory', updatePolicy === 'mandatory' ? 'true' : 'false');
      if (releaseNotes.trim()) {
        formData.append('release_notes', releaseNotes.trim());
      }

      await ApiClient.uploadRelease(formData);
      setSelectedFile(null);
      setVersionCode('');
      setVersionName('');
      setMinSupported('');
      setReleaseNotes('');
      setUpdatePolicy('optional');
      setShowPublish(false);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'فشل رفع الإصدار');
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePolicy = async (rel: AppRelease) => {
    const releaseId = String(rel.id || rel._id || '');
    if (!releaseId) return;

    const currentIsMandatory = rel.update_policy === 'mandatory' || rel.update_required === true || rel.is_mandatory === true;
    const nextPolicy: 'optional' | 'mandatory' = currentIsMandatory ? 'optional' : 'mandatory';

    const confirmMsg = nextPolicy === 'mandatory'
      ? t.confirmMakeMandatory
      : t.confirmMakeOptional;

    if (!window.confirm(confirmMsg)) return;

    setTogglingId(releaseId);
    try {
      await ApiClient.updateReleasePolicy(releaseId, nextPolicy);
      onRefresh();
    } catch (err: any) {
      alert(err.message || 'فشل تحديث سياسة الإصدار');
    } finally {
      setTogglingId(null);
    }
  };

  const handleWithdraw = async (releaseId?: string) => {
    if (!releaseId) return;
    const confirmMsg =
      'هل أنت متأكد من سحب هذا الإصدار؟ سيتم حذف ملف APK فعلياً من مساحة تخزين الخادم ولن تتمكن الأجهزة من تنزيله.';
    if (!window.confirm(confirmMsg)) return;

    setWithdrawingId(releaseId);
    try {
      await ApiClient.withdrawRelease(releaseId);
      onRefresh();
    } catch (err: any) {
      alert(err.message || 'فشل سحب الإصدار');
    } finally {
      setWithdrawingId(null);
    }
  };

  const handleDeleteRelease = async (releaseId?: string, vCode?: number) => {
    if (!releaseId) return;
    const confirmMsg =
      `هل أنت متأكد من حذف الإصدار v${vCode || ''} نهائياً؟ سيتم حذف ملف APK فعلياً من مساحة تخزين الخادم وسجل الإصدار بشكل دائم.`;
    if (!window.confirm(confirmMsg)) return;

    setDeletingId(releaseId);
    try {
      await ApiClient.deleteRelease(releaseId);
      onRefresh();
    } catch (err: any) {
      alert(err.message || 'فشل حذف الإصدار');
    } finally {
      setDeletingId(null);
    }
  };

  const apiBase = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

  return (
    <div className="card">
      <div className="spread">
        <div>
          <h2>{t.releasesTitle}</h2>
          <p className="muted">{t.activeReleases}</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setShowPublish(!showPublish);
            setErrorMsg('');
          }}
        >
          {showPublish ? t.cancel : `+ ${t.publishRelease}`}
        </button>
      </div>

      {showPublish && (
        <form onSubmit={handlePublish} className="card sub-card mt-16" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <h3>{t.publishRelease}</h3>

          {errorMsg && (
            <div style={{ color: '#b91c1c', background: '#fee2e2', padding: '8px 12px', borderRadius: '6px', fontSize: '13px' }}>
              {errorMsg}
            </div>
          )}

          {/* APK File Input */}
          <div style={{ background: 'var(--surface-2, #f8fafc)', padding: '12px', borderRadius: '8px', border: '1px dashed var(--line, #cbd5e1)' }}>
            <label style={{ fontWeight: 600, display: 'block', marginBottom: '6px' }}>
              {t.uploadApkFile} <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              onChange={(e) => {
                const file = e.target.files?.[0] || null;
                if (file && !file.name.toLowerCase().endsWith('.apk')) {
                  setErrorMsg('يجب اختيار ملف ينتهي بامتداد .apk');
                  setSelectedFile(null);
                  return;
                }
                setErrorMsg('');
                setSelectedFile(file);
              }}
              required
              style={{ width: '100%' }}
            />
            {selectedFile && (
              <div style={{ fontSize: '13px', color: '#166534', marginTop: '6px', fontWeight: 500 }}>
                ✓ {selectedFile.name} ({fmtBytes(selectedFile.size)})
              </div>
            )}
          </div>

          {/* Version Metadata Row */}
          <div className="row" style={{ gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '130px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                {t.versionCode} <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input
                type="number"
                placeholder="مثال: 106"
                value={versionCode}
                onChange={(e) => setVersionCode(e.target.value)}
                required
                min="1"
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ flex: 1, minWidth: '130px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                {t.versionName} <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input
                type="text"
                placeholder="مثال: 1.6.0"
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ flex: 1, minWidth: '130px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                {t.minSupported}
              </label>
              <input
                type="number"
                placeholder="مثال: 100"
                value={minSupported}
                onChange={(e) => setMinSupported(e.target.value)}
                min="1"
                style={{ width: '100%' }}
              />
            </div>
          </div>

          {/* Update Policy Selection (Optional vs Mandatory) */}
          <div style={{ background: 'var(--surface-2, #f8fafc)', padding: '12px 14px', borderRadius: '8px', border: '1px solid var(--line, #cbd5e1)' }}>
            <label style={{ fontSize: '13px', fontWeight: 600, display: 'block', marginBottom: '8px' }}>
              {t.updatePolicy} <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontWeight: updatePolicy === 'optional' ? 600 : 400 }}>
                <input
                  type="radio"
                  name="updatePolicy"
                  value="optional"
                  checked={updatePolicy === 'optional'}
                  onChange={() => setUpdatePolicy('optional')}
                />
                <span>{t.optionalUpdate} (افتراضي)</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontWeight: updatePolicy === 'mandatory' ? 600 : 400 }}>
                <input
                  type="radio"
                  name="updatePolicy"
                  value="mandatory"
                  checked={updatePolicy === 'mandatory'}
                  onChange={() => setUpdatePolicy('mandatory')}
                />
                <span>{t.mandatoryUpdate}</span>
              </label>
            </div>

            {/* Explanatory callout for chosen policy */}
            <div style={{
              marginTop: '10px',
              padding: '8px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              lineHeight: 1.5,
              background: updatePolicy === 'mandatory' ? 'rgba(239, 68, 68, 0.08)' : 'rgba(37, 99, 235, 0.08)',
              color: updatePolicy === 'mandatory' ? '#b91c1c' : '#1d4ed8',
              border: updatePolicy === 'mandatory' ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid rgba(37, 99, 235, 0.2)'
            }}>
              <strong>{t.policyPreviewLabel} {updatePolicy === 'mandatory' ? t.mandatoryUpdate : t.optionalUpdate}</strong>
              <div style={{ marginTop: '2px' }}>
                {updatePolicy === 'mandatory' ? t.mandatoryPolicyDesc : t.optionalPolicyDesc}
              </div>
            </div>
          </div>

          {/* Release Notes */}
          <div>
            <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
              {t.releaseNotes}
            </label>
            <textarea
              placeholder="ملاحظات وتفاصيل التحديث..."
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              rows={2}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setShowPublish(false);
                setSelectedFile(null);
                setErrorMsg('');
              }}
            >
              {t.cancel}
            </button>
            <button type="submit" className="button primary" disabled={loading}>
              {loading ? t.loading : t.publish}
            </button>
          </div>
        </form>
      )}

      <div className="table-responsive mt-16" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)' }}>
              <th style={{ padding: '8px' }}>{t.versionName}</th>
              <th style={{ padding: '8px' }}>{t.versionCode}</th>
              <th style={{ padding: '8px' }}>{t.fileSize}</th>
              <th style={{ padding: '8px' }}>{t.checksum}</th>
              <th style={{ padding: '8px' }}>{t.minSupported}</th>
              <th style={{ padding: '8px' }}>{t.status}</th>
              <th style={{ padding: '8px' }}>{t.updatePolicy}</th>
              <th style={{ padding: '8px' }}>{t.date}</th>
              <th style={{ padding: '8px' }}>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {releases.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: '16px', textAlign: 'center' }} className="muted">
                  لا توجد إصدارات منشورة حتى الآن.
                </td>
              </tr>
            ) : (
              releases.map((rel) => {
                const releaseId = String(rel.id || rel._id || '');
                const rawUrl = rel.download_url || rel.apk_url || `/app/updates/download/${rel.version_code}`;
                const fullDownloadUrl = rawUrl.startsWith('http') ? rawUrl : `${apiBase}${rawUrl}`;
                const size = rel.apk_size_bytes || rel.file_size_bytes;
                const sha = rel.sha256 || rel.sha256_checksum;
                const isWithdrawn = rel.is_withdrawn === true;
                const isMand = rel.update_policy === 'mandatory' || rel.update_required === true || rel.is_mandatory === true;
                const minVer = rel.minimum_supported_version_code || rel.min_supported_version || 1;

                return (
                  <tr key={rel.version_code} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td style={{ padding: '10px 8px', fontWeight: 600 }}>v{rel.version_name}</td>
                    <td style={{ padding: '10px 8px' }}>{rel.version_code}</td>
                    <td style={{ padding: '10px 8px' }}>{fmtBytes(size)}</td>
                    <td style={{ padding: '10px 8px', fontFamily: 'monospace', fontSize: '11px' }} title={sha}>
                      {sha ? `${sha.substring(0, 10)}...` : '-'}
                    </td>
                    <td style={{ padding: '10px 8px' }}>v{minVer}</td>
                    <td style={{ padding: '10px 8px' }}>
                      <span className={`badge ${isWithdrawn ? 'danger' : 'success'}`}>
                        {isWithdrawn ? t.withdrawn : t.published}
                      </span>
                    </td>
                    <td style={{ padding: '10px 8px' }}>
                      <span className={`badge ${isMand ? 'danger' : 'info'}`}>
                        {isMand ? t.mandatoryUpdate : t.optionalUpdate}
                      </span>
                    </td>
                    <td style={{ padding: '10px 8px' }}>{formatDate(rel.published_at || rel.created_at)}</td>
                    <td style={{ padding: '10px 8px' }}>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        {!isWithdrawn && (
                          <a
                            href={fullDownloadUrl}
                            className="button secondary"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                            download
                          >
                            {t.downloadApk}
                          </a>
                        )}
                        {!isWithdrawn && releaseId && (
                          <button
                            type="button"
                            className="button secondary"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                            onClick={() => handleTogglePolicy(rel)}
                            disabled={togglingId === releaseId}
                          >
                            {togglingId === releaseId ? t.loading : (isMand ? t.makeOptional : t.makeMandatory)}
                          </button>
                        )}
                        {!isWithdrawn && releaseId && (
                          <button
                            type="button"
                            className="button danger"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                            onClick={() => handleWithdraw(releaseId)}
                            disabled={withdrawingId === releaseId}
                          >
                            {withdrawingId === releaseId ? t.loading : t.withdraw}
                          </button>
                        )}
                        {releaseId && (
                          <button
                            type="button"
                            className="button danger"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                            onClick={() => handleDeleteRelease(releaseId, rel.version_code)}
                            disabled={deletingId === releaseId}
                          >
                            {deletingId === releaseId ? t.loading : t.deleteRelease}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
