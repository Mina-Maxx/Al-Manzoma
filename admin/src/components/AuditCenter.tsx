import React, { useEffect, useState } from 'react';
import { translations as t, formatDate, fmtBytes } from '../lib/i18n';
import { AuditEvent } from '../lib/types';
import { ApiClient } from '../lib/api';

const ACTION_GROUPS = [
  { value: 'auth', label: t.categoryAuth },
  { value: 'platform', label: t.categoryPlatform },
  { value: 'company', label: t.categoryCompany },
  { value: 'quarry', label: t.categoryQuarry },
  { value: 'document', label: t.categoryDocument },
  { value: 'backup', label: t.categoryBackup },
  { value: 'app_release', label: t.categoryRelease },
];

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'تسجيل الدخول',
  'auth.logout': 'تسجيل الخروج',
  'auth.password_change': 'تغيير كلمة المرور',
  'auth.password_reset': 'إعادة تعيين كلمة المرور',
  'auth.password_reset_requested': 'طلب إعادة تعيين كلمة المرور',
  'platform.company.create': 'إنشاء شركة',
  'platform.company.suspend': 'إيقاف شركة',
  'platform.company.reactivate': 'إعادة تفعيل شركة',
  'platform.company.delete': 'حذف شركة',
  'platform.user.create': 'إنشاء حساب مستخدم',
  'platform.user.update': 'تعديل حساب مستخدم',
  'platform.user.delete': 'تعطيل/حذف حساب مستخدم',
  'platform.user.reset_password': 'إعادة تعيين كلمة مرور مستخدم',
  'document.upload': 'رفع مستند',
  'document.download': 'تنزيل مستند',
  'document.delete': 'حذف مستند',
  'document.restore': 'استعادة مستند',
  'document.rename': 'إعادة تسمية مستند',
  'app_release.create': 'نشر إصدار تطبيق',
  'app_release.update': 'تعديل إصدار تطبيق',
  'app_release.delete': 'حذف إصدار تطبيق',
  'platform.support_grant.request': 'طلب صلاحية دعم',
  'platform.support_grant.approve': 'اعتماد صلاحية دعم',
  'platform.support_grant.revoke': 'إلغاء صلاحية دعم',
  'platform.company.delete_started': 'بدء حذف شركة',
};

const ACTION_PARTS: Record<string, string> = {
  auth: 'الحساب', platform: 'المنصة', company: 'الشركة', quarry: 'المحجر', document: 'المستند',
  backup: 'النسخة الاحتياطية', restore: 'الاستعادة', app_release: 'إصدار التطبيق',
  create: 'إنشاء', created: 'إنشاء', update: 'تعديل', updated: 'تعديل', delete: 'حذف', deleted: 'حذف',
  suspend: 'إيقاف', reactivate: 'إعادة تفعيل', upload: 'رفع', download: 'تنزيل', restore_document: 'استعادة',
  rename: 'إعادة تسمية', request: 'طلب', approve: 'اعتماد', revoke: 'إلغاء', failed: 'فشل',
  password_change: 'تغيير كلمة المرور', password_reset: 'إعادة تعيين كلمة المرور',
};

const TARGET_LABELS: Record<string, string> = {
  user: 'مستخدم', company: 'شركة', quarry: 'محجر', document: 'مستند', folder: 'مجلد',
  app_release: 'إصدار تطبيق', support_grant: 'صلاحية دعم', backup: 'نسخة احتياطية',
};

const META_LABELS: Record<string, string> = {
  company_name: 'اسم الشركة', quarry_name: 'اسم المحجر', status: 'الحالة', role: 'الدور',
  scope: 'النطاق', version_code: 'رقم الإصدار', permanent: 'حذف نهائي', document_count: 'عدد المستندات',
  quarry_count: 'عدد المحاجر', user_count: 'عدد المستخدمين', quota_bytes: 'الحصة', max_users: 'حد المستخدمين',
  size_bytes: 'الحجم', reason_code: 'رمز السبب', reason: 'السبب المسجل', old_status: 'الحالة السابقة',
  new_status: 'الحالة الجديدة', expires_at: 'ينتهي في',
};

interface AuditCenterProps {
  companyId?: string;
  companyName?: string;
}

function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  return action.split('.').map((part) => ACTION_PARTS[part] || part.replace(/_/g, ' ')).join(' · ') || t.auditUnknownAction;
}

function targetLabel(targetType?: string): string {
  if (!targetType) return '—';
  return TARGET_LABELS[targetType] || targetType.replace(/_/g, ' ');
}

function resultLabel(result: string): string {
  if (result === 'success') return t.success;
  if (result === 'denied') return t.denied;
  if (result === 'failure') return t.failure;
  return 'نتيجة غير معروفة';
}

function resultClass(result: string): string {
  if (result === 'success') return 'success';
  if (result === 'denied') return 'warning';
  return 'danger';
}

function formatMetaValue(key: string, value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
  if (typeof value === 'number') {
    if (key === 'size_bytes' || key === 'quota_bytes') return fmtBytes(value);
    return value.toLocaleString('ar');
  }
  if (key === 'reason' || key === 'reason_code') return value.replace(/_/g, ' ');
  return value;
}

function localDateBoundary(value: string, nextDay = false): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (nextDay) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

const MAX_AUDIT_EXPORT_ROWS = 10000;

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  const formulaSafe = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${formulaSafe.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, headers: string[], rows: unknown[][]): void {
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
}

export const AuditCenter: React.FC<AuditCenterProps> = ({ companyId, companyName }) => {
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [resultFilter, setResultFilter] = useState('');
  const [actionGroup, setActionGroup] = useState('');
  const [fromDraft, setFromDraft] = useState('');
  const [toDraft, setToDraft] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');

  useEffect(() => {
    let current = true;
    const loadAudit = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await ApiClient.getAuditLogs({
          search: search || undefined,
          result: resultFilter || undefined,
          actionGroup: actionGroup || undefined,
          companyId,
          from: from || undefined,
          to: to || undefined,
          page,
          limit: 25,
        });
        if (!current) return;
        setEvents(response.items || []);
        setTotal(response.total || 0);
        setTotalPages(Math.max(1, response.pages || 1));
        if (response.page && response.page !== page) setPage(response.page);
      } catch {
        if (current) setError(t.auditLoadError);
      } finally {
        if (current) setLoading(false);
      }
    };
    void loadAudit();
    return () => { current = false; };
  }, [companyId, search, resultFilter, actionGroup, from, to, page, reloadToken]);

  const handleApplyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    if (fromDraft && toDraft && fromDraft > toDraft) {
      setError(t.auditDateRangeError);
      return;
    }
    setSearch(searchDraft.trim());
    setFrom(fromDraft ? localDateBoundary(fromDraft) : '');
    setTo(toDraft ? localDateBoundary(toDraft, true) : '');
    setPage(1);
    setReloadToken((value) => value + 1);
  };

  const handleClearFilters = () => {
    setSearchDraft('');
    setSearch('');
    setResultFilter('');
    setActionGroup('');
    setFromDraft('');
    setToDraft('');
    setFrom('');
    setTo('');
    setPage(1);
    setError('');
    setReloadToken((value) => value + 1);
  };

  const handleExport = async () => {
    setExporting(true);
    setExportMessage('');
    try {
      const exportTo = to || new Date().toISOString();
      const params = {
        search: search || undefined,
        result: resultFilter || undefined,
        actionGroup: actionGroup || undefined,
        companyId,
        from: from || undefined,
        to: exportTo,
        limit: 100,
        page: 1,
      };
      const firstPage = await ApiClient.getAuditLogs(params);
      const rows: AuditEvent[] = [...firstPage.items];
      const maxPages = Math.min(firstPage.pages, Math.ceil(MAX_AUDIT_EXPORT_ROWS / 100));
      for (let currentPage = 2; currentPage <= maxPages; currentPage += 1) {
        const response = await ApiClient.getAuditLogs({ ...params, page: currentPage });
        rows.push(...response.items);
      }
      const exportedRows = rows.slice(0, MAX_AUDIT_EXPORT_ROWS);
      downloadCsv(
        `quarryvault-audit-${new Date().toISOString().slice(0, 10)}.csv`,
        ['الوقت', 'الإجراء', 'النتيجة', 'الفاعل', 'معرّف الفاعل', 'الشركة', 'معرّف الشركة', 'نوع الهدف', 'معرّف الهدف', 'عنوان IP', 'تفاصيل آمنة'],
        exportedRows.map((item) => [
          item.timestamp,
          actionLabel(item.action),
          resultLabel(item.result),
          item.actor_name || (item.actor_id ? t.actorNotFound : t.systemActor),
          item.actor_id || '',
          item.company_name || item.metadata?.company_name || (item.company_id ? 'شركة غير معروفة' : t.platformScope),
          item.company_id || '',
          targetLabel(item.target_type),
          item.target_id || '',
          item.ip_address || '',
          JSON.stringify(item.metadata || {}),
        ])
      );
      setExportMessage(firstPage.total > exportedRows.length ? t.auditExportPartial : t.auditExportSuccess);
    } catch {
      setExportMessage(t.auditExportError);
    } finally {
      setExporting(false);
    }
  };

  const metadataEntries = (event: AuditEvent) => Object.entries(event.metadata || {})
    .filter(([key]) => Boolean(META_LABELS[key]));

  return (
    <section className="card" aria-labelledby="audit-center-title">
      <div className="spread" style={{ alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h2 id="audit-center-title">{t.auditCenterTitle}</h2>
          <p className="muted" style={{ marginTop: '6px' }}>{t.auditSubtitle}</p>
          <span className="badge info" style={{ display: 'inline-flex', marginTop: '8px' }}>{companyName || (companyId ? t.company : t.platformScope)}</span>
        </div>
        <div className="row" style={{ gap: '8px' }}>
          <span className="badge info">{t.totalResults}: {total.toLocaleString('ar')}</span>
          <button type="button" className="button secondary" onClick={() => setReloadToken((value) => value + 1)} disabled={loading}>
            {loading ? t.loading : t.refreshAudit}
          </button>
          <button type="button" className="button primary" onClick={() => { void handleExport(); }} disabled={exporting || loading || total === 0}>
            {exporting ? t.exportingAudit : t.exportAuditCsv}
          </button>
        </div>
      </div>

      <form onSubmit={handleApplyFilters} className="mt-16" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'end' }}>
        <label style={{ flex: '2 1 260px' }}>
          <span className="muted" style={{ display: 'block', marginBottom: '5px' }}>{t.searchAudit}</span>
          <input type="search" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} style={{ width: '100%' }} />
        </label>
        <label style={{ flex: '1 1 160px' }}>
          <span className="muted" style={{ display: 'block', marginBottom: '5px' }}>{t.actionCategory}</span>
          <select value={actionGroup} onChange={(event) => { setActionGroup(event.target.value); setPage(1); }} style={{ width: '100%' }}>
            <option value="">{t.allActions}</option>
            {ACTION_GROUPS.map((group) => <option key={group.value} value={group.value}>{group.label}</option>)}
          </select>
        </label>
        <label style={{ flex: '1 1 150px' }}>
          <span className="muted" style={{ display: 'block', marginBottom: '5px' }}>{t.result}</span>
          <select value={resultFilter} onChange={(event) => { setResultFilter(event.target.value); setPage(1); }} style={{ width: '100%' }}>
            <option value="">{t.allResults}</option>
            <option value="success">{t.success}</option>
            <option value="denied">{t.denied}</option>
            <option value="failure">{t.failure}</option>
          </select>
        </label>
        <label style={{ flex: '1 1 145px' }}>
          <span className="muted" style={{ display: 'block', marginBottom: '5px' }}>{t.dateFrom}</span>
          <input type="date" value={fromDraft} onChange={(event) => setFromDraft(event.target.value)} style={{ width: '100%' }} />
        </label>
        <label style={{ flex: '1 1 145px' }}>
          <span className="muted" style={{ display: 'block', marginBottom: '5px' }}>{t.dateTo}</span>
          <input type="date" value={toDraft} onChange={(event) => setToDraft(event.target.value)} style={{ width: '100%' }} />
        </label>
        <button type="submit" className="button primary">{t.applyFilters}</button>
        <button type="button" className="button secondary" onClick={handleClearFilters}>{t.clearFilters}</button>
      </form>
      <p className="muted" style={{ marginTop: '6px', fontSize: '12px' }}>{t.auditDateNote}</p>
      {exportMessage && <div role="status" className="muted" style={{ marginTop: '8px' }}>{exportMessage}</div>}

      {error && <div role="alert" style={{ marginTop: '14px', padding: '12px', borderRadius: '6px', border: '1px solid #fca5a5', background: '#fef2f2', color: '#991b1b' }}>{error}</div>}

      <div className="table-responsive mt-16" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '860px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'right' }}>
              <th style={{ padding: '10px 8px' }}>{t.timestamp}</th>
              <th style={{ padding: '10px 8px' }}>{t.action}</th>
              <th style={{ padding: '10px 8px' }}>{t.result}</th>
              <th style={{ padding: '10px 8px' }}>{t.actor}</th>
              <th style={{ padding: '10px 8px' }}>{t.company}</th>
              <th style={{ padding: '10px 8px' }}>{t.target}</th>
              <th style={{ padding: '10px 8px' }}>{t.auditDetails}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: '20px', textAlign: 'center' }} className="muted">{t.loading}</td></tr>
            ) : events.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: '20px', textAlign: 'center' }} className="muted">{error ? '—' : t.noAuditLogs}</td></tr>
            ) : events.map((event) => {
              const metadata = metadataEntries(event);
              return (
                <tr key={event.id} style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'top' }}>
                  <td style={{ padding: '10px 8px', fontSize: '12px', minWidth: '150px' }}>{formatDate(event.timestamp)}</td>
                  <td style={{ padding: '10px 8px', fontWeight: 600 }}>{actionLabel(event.action)}</td>
                  <td style={{ padding: '10px 8px' }}><span className={`badge ${resultClass(event.result)}`}>{resultLabel(event.result)}</span></td>
                  <td style={{ padding: '10px 8px' }}>
                    <div>{event.actor_name || (event.actor_id ? t.actorNotFound : t.systemActor)}</div>
                    {event.actor_id && <code className="muted" title={event.actor_id}>{event.actor_id.slice(0, 10)}…</code>}
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    <div>{event.company_name || event.metadata?.company_name || (event.company_id ? 'شركة غير معروفة' : t.platformScope)}</div>
                    {event.company_id && <code className="muted" title={event.company_id}>{event.company_id.slice(0, 10)}…</code>}
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    <div>{targetLabel(event.target_type)}</div>
                    {event.target_id && <code className="muted" title={event.target_id}>{event.target_id.slice(0, 12)}…</code>}
                  </td>
                  <td style={{ padding: '10px 8px', minWidth: '150px' }}>
                    <details>
                      <summary style={{ cursor: 'pointer' }}>{t.auditDetails}</summary>
                      <div style={{ marginTop: '8px', fontSize: '12px' }}>
                        {metadata.length ? metadata.map(([key, value]) => (
                          <div key={key} className="spread" style={{ gap: '12px', borderBottom: '1px solid var(--line)', padding: '4px 0' }}>
                            <span className="muted">{META_LABELS[key] || key}</span>
                            <span>{formatMetaValue(key, value as string | number | boolean)}</span>
                          </div>
                        )) : <p className="muted">{t.auditNoDetails}</p>}
                        {event.ip_address && <div style={{ marginTop: '6px' }}><span className="muted">{t.ip}: </span><code>{event.ip_address}</code></div>}
                        {event.target_id && <div style={{ marginTop: '6px', wordBreak: 'break-all' }}><span className="muted">{t.targetId}: </span><code>{event.target_id}</code></div>}
                      </div>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="spread mt-16">
        <button type="button" className="button secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t.prevPage}</button>
        <span className="muted">{t.page} {page.toLocaleString('ar')} / {totalPages.toLocaleString('ar')}</span>
        <button type="button" className="button secondary" disabled={page >= totalPages || loading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>{t.nextPage}</button>
      </div>
    </section>
  );
};
