import React from 'react';
import { translations as t, fmtBytes } from '../lib/i18n';
import { PlatformOverviewData } from '../lib/types';

interface PlatformOverviewProps {
  data: PlatformOverviewData | null;
  loading: boolean;
  onRefresh?: () => void;
}

export const PlatformOverview: React.FC<PlatformOverviewProps> = ({ data, loading, onRefresh }) => {
  if (loading) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '48px 16px' }}>
        <p className="muted" style={{ fontSize: '16px' }}>{t.loading}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '48px 16px' }}>
        <p style={{ color: '#b91c1c', fontSize: '16px', marginBottom: '16px', fontWeight: 600 }}>
          {t.errorLoadingStats}
        </p>
        {onRefresh && (
          <button className="button primary" onClick={onRefresh}>
            {t.retry}
          </button>
        )}
      </div>
    );
  }

  const storageUsed = data.storageUsageBytes || 0;
  const storageQuota = data.storageQuotaBytes || 5 * 1024 * 1024 * 1024;
  const storagePercent = Math.min(100, Math.round((storageUsed / (storageQuota || 1)) * 100));

  const getHealthBadge = (health: string) => {
    const norm = (health || '').toLowerCase();
    if (norm === 'healthy') return { className: 'badge success', label: 'سليم ونشط' };
    if (norm === 'degraded') return { className: 'badge warning', label: 'أداء متراجع' };
    return { className: 'badge danger', label: 'غير متصل' };
  };

  const dbHealth = getHealthBadge(data.databaseHealth);
  const stHealth = getHealthBadge(data.storageHealth);
  const apiHealth = getHealthBadge(data.backendHealth);

  return (
    <div>
      {/* KPI Cards */}
      <div className="grid-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
        <div className="card stat-card">
          <div className="muted">{t.totalOffices}</div>
          <div className="stat-val" style={{ fontSize: '28px', fontWeight: 'bold' }}>{data.totalOffices}</div>
          <div className="sub-stat" style={{ fontSize: '12px', color: '#166534' }}>{data.activeOffices} {t.active}</div>
        </div>

        <div className="card stat-card">
          <div className="muted">{t.totalUsers}</div>
          <div className="stat-val" style={{ fontSize: '28px', fontWeight: 'bold' }}>{data.totalUsers}</div>
          <div className="sub-stat" style={{ fontSize: '12px', color: '#166534' }}>{data.activeUsers} {t.active}</div>
        </div>

        <div className="card stat-card">
          <div className="muted">{t.totalQuarries}</div>
          <div className="stat-val" style={{ fontSize: '28px', fontWeight: 'bold' }}>{data.totalQuarries}</div>
        </div>

        <div className="card stat-card">
          <div className="muted">{t.activeDocs}</div>
          <div className="stat-val" style={{ fontSize: '28px', fontWeight: 'bold' }}>{data.activeDocs}</div>
          <div className="sub-stat" style={{ fontSize: '12px', color: '#b91c1c' }}>{data.trashDocs} {t.trashDocs}</div>
        </div>
      </div>

      {/* Storage Quota Card */}
      <div className="card storage-card">
        <div className="spread">
          <div>
            <h3>{t.storageUsage}</h3>
            <p className="muted">
              {fmtBytes(storageUsed)} / {fmtBytes(storageQuota)} ({storagePercent}%)
            </p>
          </div>
          <span className={`badge ${storagePercent > 90 ? 'danger' : storagePercent > 75 ? 'warning' : 'success'}`}>
            {storagePercent}%
          </span>
        </div>
        <progress
          className={`meter-bar ${storagePercent > 90 ? 'danger' : storagePercent > 75 ? 'warning' : ''}`}
          value={storageUsed}
          max={storageQuota}
        />
      </div>

      {/* System Health */}
      <div className="card">
        <h3>حالة البنية التحتية والأنظمة</h3>
        <div className="row" style={{ marginTop: '12px', gap: '20px', flexWrap: 'wrap' }}>
          <div>
            <span className="muted">{t.backendHealth}: </span>
            <span className={apiHealth.className}>{apiHealth.label}</span>
          </div>
          <div>
            <span className="muted">{t.databaseHealth}: </span>
            <span className={dbHealth.className}>{dbHealth.label}</span>
          </div>
          <div>
            <span className="muted">{t.storageHealth}: </span>
            <span className={stHealth.className}>{stHealth.label}</span>
          </div>
          <div>
            <span className="muted">{t.storageBackend}: </span>
            <span className="badge info">{data.storageBackend || 'Cloudflare R2 (S3-compatible)'}</span>
          </div>
        </div>
      </div>

      {/* Telemetry */}
      {data.telemetry && (
        <div className="card">
          <h3>{t.telemetryTitle}</h3>
          <div className="grid-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginTop: '12px' }}>
            <div className="card sub-card">
              <div className="muted">{t.uploadsCount}</div>
              <div style={{ fontSize: '20px', fontWeight: 600 }}>{data.telemetry.uploadsCount}</div>
            </div>
            <div className="card sub-card">
              <div className="muted">{t.downloadsCount}</div>
              <div style={{ fontSize: '20px', fontWeight: 600 }}>{data.telemetry.downloadsCount}</div>
            </div>
            <div className="card sub-card">
              <div className="muted">{t.deletionsCount}</div>
              <div style={{ fontSize: '20px', fontWeight: 600 }}>{data.telemetry.deletionsCount}</div>
            </div>
            <div className="card sub-card">
              <div className="muted">{t.restorationsCount}</div>
              <div style={{ fontSize: '20px', fontWeight: 600 }}>{data.telemetry.restorationsCount}</div>
            </div>
            <div className="card sub-card">
              <div className="muted">{t.failuresCount}</div>
              <div style={{ fontSize: '20px', fontWeight: 600, color: data.telemetry.failuresCount > 0 ? '#b91c1c' : 'inherit' }}>
                {data.telemetry.failuresCount}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
