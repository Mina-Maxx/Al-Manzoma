import React from 'react';
import { translations as t, formatDate } from '../lib/i18n';
import { OperationalAlert } from '../lib/types';

interface AlertsViewProps {
  alerts: OperationalAlert[];
  checkedAt: string | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  const formulaSafe = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${formulaSafe.replace(/"/g, '""')}"`;
}

export const AlertsView: React.FC<AlertsViewProps> = ({ alerts, checkedAt, loading, error, onRefresh }) => {
  const counts = {
    critical: alerts.filter((alert) => alert.level === 'critical').length,
    warning: alerts.filter((alert) => alert.level === 'warning').length,
    info: alerts.filter((alert) => alert.level === 'info').length,
  };
  const exportAlerts = () => {
    const levelLabel = (level: OperationalAlert['level']) => level === 'critical' ? t.critical : level === 'warning' ? t.warning : t.info;
    const rows = alerts.map((alert) => [alert.timestamp, levelLabel(alert.level), alert.title, alert.message]);
    const content = [
      ['وقت الفحص', 'الخطورة', 'التنبيه', 'التفاصيل'],
      ...rows,
    ].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `quarryvault-alerts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
  };

  return (
    <section className="card" aria-labelledby="operational-alerts-title">
      <div className="spread" style={{ alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h2 id="operational-alerts-title">{t.operationalAlertsTitle}</h2>
          <p className="muted" style={{ marginTop: '6px' }}>{t.monitoringLastChecked}: {checkedAt ? formatDate(checkedAt) : 'لم يُجرَ فحص بعد'}</p>
        </div>
        <div className="row" style={{ gap: '8px' }}>
          <button type="button" className="button secondary" onClick={onRefresh} disabled={loading}>
            {loading ? t.loading : t.refreshMonitoring}
          </button>
          <button type="button" className="button primary" onClick={exportAlerts} disabled={loading || alerts.length === 0}>
            {t.exportAlertsCsv}
          </button>
        </div>
      </div>

      <div className="row mt-16" style={{ gap: '8px', flexWrap: 'wrap' }}>
        <span className="badge danger">{t.monitoringCriticalCount}: {counts.critical.toLocaleString('ar')}</span>
        <span className="badge warning">{t.monitoringWarningCount}: {counts.warning.toLocaleString('ar')}</span>
        <span className="badge info">{t.monitoringInfoCount}: {counts.info.toLocaleString('ar')}</span>
      </div>

      {error && (
        <div role="alert" style={{ marginTop: '16px', padding: '12px 14px', borderRadius: '6px', border: '1px solid #fca5a5', background: '#fef2f2', color: '#991b1b' }}>
          {error}
        </div>
      )}

      {loading && alerts.length === 0 ? (
        <p className="muted mt-16" style={{ textAlign: 'center', padding: '24px' }}>{t.loading}</p>
      ) : alerts.length === 0 && !error ? (
        <p className="muted mt-16" style={{ textAlign: 'center', padding: '24px' }}>{t.noAlerts}</p>
      ) : (
        <div className="mt-16" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {alerts.map((alert) => (
            <article
              key={alert.id}
              className="card sub-card"
              style={{
                borderInlineStart: `4px solid ${alert.level === 'critical' ? '#b91c1c' : alert.level === 'warning' ? '#b45309' : '#1e3a8a'}`,
              }}
            >
              <div className="spread" style={{ gap: '12px', alignItems: 'flex-start' }}>
                <span className={`badge ${alert.level === 'critical' ? 'danger' : alert.level === 'warning' ? 'warning' : 'info'}`}>
                  {alert.level === 'critical' ? t.critical : alert.level === 'warning' ? t.warning : t.info}
                </span>
                <span className="muted" style={{ fontSize: '12px' }}>{formatDate(alert.timestamp)}</span>
              </div>
              <h3 style={{ margin: '10px 0 5px', fontSize: '16px' }}>{alert.title}</h3>
              <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.7, color: '#475569' }}>{alert.message}</p>
            </article>
          ))}
        </div>
      )}

      <p className="muted" style={{ marginTop: '16px', fontSize: '12px' }}>
        تعرض هذه الشاشة نتيجة فحوص القراءة عند طلبها؛ وهي ليست خدمة تنبيه مستمرة أو بديلًا عن مراقبة الخادم.
      </p>
    </section>
  );
};
