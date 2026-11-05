import React, { useState } from 'react';
import { translations } from '../lib/i18n';
import { UserAccount, Quarry, EmployeePermission } from '../lib/types';
import { ApiClient } from '../lib/api';
import { sortAlphabetically } from '../lib/sorting';

interface EmployeeMatrixProps {
  employees: UserAccount[];
  quarries: Quarry[];
  permissions: EmployeePermission[];
  onRefresh: () => void | Promise<void>;
}

type PermissionFlags = { can_view: boolean; can_upload: boolean; can_download: boolean; can_delete: boolean };

export const EmployeeMatrix: React.FC<EmployeeMatrixProps> = ({
  employees,
  quarries,
  permissions,
  onRefresh,
}) => {
  const t = translations;
  const sortedEmployees = sortAlphabetically(employees, (e) => e.full_name || e.username);
  const sortedQuarries = sortAlphabetically(quarries, (q) => q.name);
  const assignableQuarries = sortedQuarries.filter((quarry) => quarry.status === 'active');

  const [showCreate, setShowCreate] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [createCanView, setCreateCanView] = useState(true);
  const [createCanUpload, setCreateCanUpload] = useState(true);
  const [createCanDownload, setCreateCanDownload] = useState(true);
  const [createCanDelete, setCreateCanDelete] = useState(false);
  const [createHiddenQuarries, setCreateHiddenQuarries] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Edit Permissions Modal State
  const [selectedEmp, setSelectedEmp] = useState<UserAccount | null>(null);
  const [empCanView, setEmpCanView] = useState(true);
  const [empCanUpload, setEmpCanUpload] = useState(true);
  const [empCanDownload, setEmpCanDownload] = useState(true);
  const [empCanDelete, setEmpCanDelete] = useState(false);
  const [empHiddenQuarries, setEmpHiddenQuarries] = useState<string[]>([]);
  const [empQuarryPermissions, setEmpQuarryPermissions] = useState<Record<string, PermissionFlags>>({});
  const [baselineEmpQuarryPermissions, setBaselineEmpQuarryPermissions] = useState<Record<string, PermissionFlags>>({});
  const [savingPerms, setSavingPerms] = useState(false);

  // Toast Notification
  const [toastMsg, setToastMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showToast = (type: 'success' | 'error', text: string) => {
    setToastMsg({ type, text });
    setTimeout(() => setToastMsg(null), 5000);
  };

  const handleOpenEditModal = (emp: UserAccount) => {
    setSelectedEmp(emp);
    const p = emp.permissions || {
      can_view: true,
      can_upload: true,
      can_download: true,
      can_delete: false,
    };
    setEmpCanView(p.can_view ?? true);
    setEmpCanUpload(p.can_upload ?? true);
    setEmpCanDownload(p.can_download ?? true);
    setEmpCanDelete(p.can_delete ?? false);
    setEmpHiddenQuarries(Array.isArray(emp.hidden_quarries) ? [...emp.hidden_quarries] : []);
    const quarryPermissionState: Record<string, PermissionFlags> = {};
    for (const quarry of sortedQuarries) {
      const stored = permissions.find((item) => String(item.user_id) === emp.id && String(item.quarry_id) === quarry.id);
      quarryPermissionState[quarry.id] = stored
        ? {
            can_view: Boolean(stored.can_view),
            can_upload: Boolean(stored.can_upload),
            can_download: Boolean(stored.can_download),
            can_delete: Boolean(stored.can_delete),
          }
        : {
            can_view: p.can_view ?? true,
            can_upload: p.can_upload ?? true,
            can_download: p.can_download ?? true,
            can_delete: p.can_delete ?? false,
          };
    }
    setEmpQuarryPermissions(quarryPermissionState);
    setBaselineEmpQuarryPermissions(quarryPermissionState);
  };

  const handleSaveEmployeePermissions = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmp) return;
    setSavingPerms(true);
    try {
      const changedQuarryPermissions = sortedQuarries
        .filter((quarry) => {
          const current = empQuarryPermissions[quarry.id];
          const baseline = baselineEmpQuarryPermissions[quarry.id];
          return Boolean(current && baseline && (
            current.can_view !== baseline.can_view ||
            current.can_upload !== baseline.can_upload ||
            current.can_download !== baseline.can_download ||
            current.can_delete !== baseline.can_delete
          ));
        })
        .map((quarry) => ({ quarry_id: quarry.id, ...empQuarryPermissions[quarry.id] }));
      await ApiClient.updateEmployeePermissions(
        selectedEmp.id,
        {
          can_view: empCanView,
          can_upload: empCanUpload,
          can_download: empCanDownload,
          can_delete: empCanDelete,
        },
        empHiddenQuarries,
        changedQuarryPermissions
      );
      showToast('success', t.permissionsUpdatedSuccess || 'تم حفظ صلاحيات الموظف ورؤية المحاجر بنجاح.');
      setSelectedEmp(null);
      await onRefresh();
    } catch (err: any) {
      showToast('error', err.message || 'فشل حفظ الصلاحيات ورؤية المحاجر');
    } finally {
      setSavingPerms(false);
    }
  };

  const toggleHiddenQuarry = (quarryId: string) => {
    setEmpHiddenQuarries((prev) =>
      prev.includes(quarryId) ? prev.filter((id) => id !== quarryId) : [...prev, quarryId]
    );
  };

  const toggleCreateHiddenQuarry = (quarryId: string) => {
    setCreateHiddenQuarries((prev) =>
      prev.includes(quarryId) ? prev.filter((id) => id !== quarryId) : [...prev, quarryId]
    );
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');
    try {
      const assignedQuarries = assignableQuarries.filter((quarry) => !createHiddenQuarries.includes(quarry.id));
      if (assignedQuarries.length === 0) {
        throw new Error('يجب اختيار محجر نشط واحد على الأقل للموظف.');
      }
      await ApiClient.createCompanyEmployee({
        username: username.trim(),
        email: email.trim(),
        fullName: fullName.trim() || undefined,
        password,
        permissions: {
          can_view: createCanView,
          can_upload: createCanUpload,
          can_download: createCanDownload,
          can_delete: createCanDelete,
        },
        hidden_quarries: createHiddenQuarries,
        quarry_permissions: assignedQuarries.map((quarry) => ({
          quarry_id: quarry.id,
          can_view: createCanView,
          can_upload: createCanUpload,
          can_download: createCanDownload,
          can_delete: createCanDelete,
        })),
      });
      setUsername('');
      setEmail('');
      setFullName('');
      setPassword('');
      setCreateCanView(true);
      setCreateCanUpload(true);
      setCreateCanDownload(true);
      setCreateCanDelete(false);
      setCreateHiddenQuarries([]);
      setShowCreate(false);
      showToast('success', 'تم إنشاء حساب الموظف وتعيين الصلاحيات بنجاح.');
      await onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message);
      showToast('error', err.message || 'فشل إنشاء حساب الموظف');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      {/* Toast Notification */}
      {toastMsg && (
        <div
          style={{
            marginBottom: '16px',
            padding: '10px 14px',
            borderRadius: '6px',
            backgroundColor: toastMsg.type === 'success' ? '#dcfce7' : '#fee2e2',
            color: toastMsg.type === 'success' ? '#166534' : '#991b1b',
            border: `1px solid ${toastMsg.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          {toastMsg.type === 'success' ? '✓ ' : '⚠️ '}
          {toastMsg.text}
        </div>
      )}

      <div className="card">
        <div className="spread">
          <div>
            <h2>{t.employees}</h2>
            <p className="muted" style={{ fontSize: '13px' }}>
              إدارة حسابات الموظفين، الصلاحيات التشغيلية الموحدة للمكتب، وتحديد رؤية المحاجر.
            </p>
          </div>
          <button
            className="button primary"
            onClick={() => setShowCreate(!showCreate)}
          >
            {showCreate ? t.cancel : `+ ${t.createEmployeeAccount}`}
          </button>
        </div>

        {/* Create Employee Account Form */}
        {showCreate && (
          <form onSubmit={handleCreateEmployee} className="card sub-card mt-16" style={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
            <h3>{t.createEmployeeAccount}</h3>
            {errorMsg && <p style={{ color: '#b91c1c' }}>{errorMsg}</p>}
            <div className="row mt-12" style={{ gap: '10px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder={t.username}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                style={{ flex: 1, minWidth: '150px' }}
              />
              <input
                type="email"
                placeholder={t.email}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                style={{ flex: 1, minWidth: '150px' }}
              />
              <input
                type="text"
                placeholder={t.fullNamePlaceholder}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                style={{ flex: 1, minWidth: '150px' }}
              />
              <input
                type="password"
                placeholder={t.initialPasswordPlaceholder}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                style={{ flex: 1, minWidth: '150px' }}
              />
            </div>

            {/* General Operational Permissions for New Employee */}
            <div className="mt-16" style={{ padding: '12px', backgroundColor: 'var(--surface, #fff)', borderRadius: '6px', border: '1px solid var(--line)' }}>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '13px' }}>{t.generalPermissions || 'صلاحيات التشغيل العامة'}</h4>
              <div className="row" style={{ gap: '16px', flexWrap: 'wrap' }}>
                <label style={{ cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input type="checkbox" checked={createCanView} onChange={(e) => setCreateCanView(e.target.checked)} />
                  عرض المستندات
                </label>
                <label style={{ cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input type="checkbox" checked={createCanUpload} onChange={(e) => setCreateCanUpload(e.target.checked)} />
                  رفع المستندات
                </label>
                <label style={{ cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input type="checkbox" checked={createCanDownload} onChange={(e) => setCreateCanDownload(e.target.checked)} />
                  تحميل المستندات
                </label>
                <label style={{ cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input type="checkbox" checked={createCanDelete} onChange={(e) => setCreateCanDelete(e.target.checked)} />
                  حذف المستندات
                </label>
              </div>
            </div>

            {/* Quarry Visibility for New Employee */}
            {assignableQuarries.length === 0 && (
              <p className="muted mt-12">يجب إنشاء محجر نشط قبل إضافة موظف.</p>
            )}
            {assignableQuarries.length > 0 && (
              <div className="mt-12" style={{ padding: '12px', backgroundColor: 'var(--surface, #fff)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '13px' }}>{t.quarryVisibility || 'رؤية المحاجر'}</h4>
                <p className="muted" style={{ fontSize: '12px', margin: '0 0 10px 0' }}>
                  حدد المحاجر المصرح للموظف برؤيتها. المحاجر غير المحددة ستكون مخفية تماماً.
                </p>
                <div className="row" style={{ gap: '12px', flexWrap: 'wrap' }}>
                  {assignableQuarries.map((q) => {
                    const isVisible = !createHiddenQuarries.includes(q.id);
                    return (
                      <label
                        key={q.id}
                        style={{
                          cursor: 'pointer',
                          fontSize: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '6px 10px',
                          borderRadius: '4px',
                          backgroundColor: isVisible ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                          border: `1px solid ${isVisible ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isVisible}
                          onChange={() => toggleCreateHiddenQuarry(q.id)}
                        />
                        <span>{q.name}</span>
                        <span style={{ fontSize: '11px', color: isVisible ? '#15803d' : '#b91c1c' }}>
                          ({isVisible ? 'ظاهر' : 'مخفي'})
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="row mt-16" style={{ justifyContent: 'flex-end' }}>
              <button type="submit" className="button primary" disabled={loading}>
                {loading ? t.loading : t.create}
              </button>
            </div>
          </form>
        )}

        {/* Employees Table with Unified Permissions Display */}
        <div className="table-responsive mt-16" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: '8px' }}>{t.username}</th>
                <th style={{ padding: '8px' }}>{t.email}</th>
                <th style={{ padding: '8px' }}>{t.fullName}</th>
                <th style={{ padding: '8px' }}>{t.generalPermissions || 'صلاحيات التشغيل'}</th>
                <th style={{ padding: '8px' }}>{t.quarryVisibility || 'المحاجر المتاحة'}</th>
                <th style={{ padding: '8px' }}>{t.status}</th>
                <th style={{ padding: '8px', textAlign: 'left' }}>{t.actions}</th>
              </tr>
            </thead>
            <tbody>
              {sortedEmployees.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: '16px', textAlign: 'center' }} className="muted">
                    {t.noEmployees}
                  </td>
                </tr>
              ) : (
                sortedEmployees.map((emp) => {
                  const p = emp.permissions || {
                    can_view: true,
                    can_upload: true,
                    can_download: true,
                    can_delete: false,
                  };
                  const hidden = emp.hidden_quarries || [];
                  const visibleCount = sortedQuarries.filter((q) => !hidden.includes(q.id)).length;

                  return (
                    <tr key={emp.id} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '10px 8px', fontWeight: 600 }}>{emp.username}</td>
                      <td style={{ padding: '10px 8px' }}>{emp.email}</td>
                      <td style={{ padding: '10px 8px' }}>{emp.full_name || '-'}</td>
                      <td style={{ padding: '10px 8px' }}>
                        <div className="row" style={{ gap: '4px', flexWrap: 'wrap' }}>
                          <span className={`badge ${p.can_view ? 'success' : 'muted'}`} style={{ fontSize: '11px' }}>
                            عرض {p.can_view ? '✓' : '✗'}
                          </span>
                          <span className={`badge ${p.can_upload ? 'success' : 'muted'}`} style={{ fontSize: '11px' }}>
                            رفع {p.can_upload ? '✓' : '✗'}
                          </span>
                          <span className={`badge ${p.can_download ? 'success' : 'muted'}`} style={{ fontSize: '11px' }}>
                            تحميل {p.can_download ? '✓' : '✗'}
                          </span>
                          <span className={`badge ${p.can_delete ? 'danger' : 'muted'}`} style={{ fontSize: '11px' }}>
                            حذف {p.can_delete ? '✓' : '✗'}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        <span className="badge info" style={{ fontSize: '11px' }}>
                          {visibleCount} من أصل {sortedQuarries.length} محاجر
                        </span>
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        <span className={`badge ${emp.status === 'active' ? 'success' : 'danger'}`}>
                          {emp.status === 'active' ? t.active : t.disabled}
                        </span>
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'left' }}>
                        <button
                          type="button"
                          className="button secondary"
                          style={{ fontSize: '12px', padding: '4px 8px' }}
                          onClick={() => handleOpenEditModal(emp)}
                        >
                          ⚙ تعديل الصلاحيات
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Permissions & Quarry Visibility Modal */}
      {selectedEmp && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '16px',
          }}
        >
          <div
            className="card"
            style={{
              maxWidth: '560px',
              width: '100%',
              padding: '24px',
              backgroundColor: 'var(--surface, #ffffff)',
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.25)',
              borderRadius: '8px',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              صلاحيات الموظف: {selectedEmp.full_name || selectedEmp.username}
            </h3>
            <p className="muted" style={{ fontSize: '13px', marginBottom: '16px' }}>
              البريد الإلكتروني: {selectedEmp.email}
            </p>

            <form onSubmit={handleSaveEmployeePermissions}>
              {/* Section 1: General Operational Permissions */}
              <div style={{ padding: '14px', borderRadius: '6px', backgroundColor: 'rgba(0,0,0,0.02)', border: '1px solid var(--line)' }}>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '14px' }}>
                  {t.generalPermissions || 'صلاحيات التشغيل العامة'}
                </h4>
                <p className="muted" style={{ fontSize: '12px', margin: '0 0 12px 0' }}>
                  {t.generalPermissionsSubtitle || 'تُعد صلاحيات المكتب الحد الأعلى؛ ولا يمكن لصلاحية محجر أن تتجاوز أي منع على مستوى المكتب.'}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <label style={{ cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      checked={empCanView}
                      onChange={(e) => setEmpCanView(e.target.checked)}
                    />
                    <span>عرض وتصفح المستندات (can_view)</span>
                  </label>
                  <label style={{ cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      checked={empCanUpload}
                      onChange={(e) => setEmpCanUpload(e.target.checked)}
                    />
                    <span>رفع المستندات (can_upload)</span>
                  </label>
                  <label style={{ cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      checked={empCanDownload}
                      onChange={(e) => setEmpCanDownload(e.target.checked)}
                    />
                    <span>تحميل وحفظ الملفات (can_download)</span>
                  </label>
                  <label style={{ cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      checked={empCanDelete}
                      onChange={(e) => setEmpCanDelete(e.target.checked)}
                    />
                    <span style={{ color: '#dc2626' }}>حذف المستندات (can_delete)</span>
                  </label>
                </div>
              </div>

              {/* Section 2: Independent Quarry Visibility */}
              <div className="mt-16" style={{ padding: '14px', borderRadius: '6px', backgroundColor: 'rgba(0,0,0,0.02)', border: '1px solid var(--line)' }}>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '14px' }}>
                  {t.quarryVisibility || 'رؤية المحاجر (Quarry Visibility)'}
                </h4>
                <p className="muted" style={{ fontSize: '12px', margin: '0 0 12px 0' }}>
                  {t.quarryVisibilitySubtitle || 'تحديد المحاجر المتاحة أو المخفية عن الموظف. المحاجر المخفية لا تظهر نهائياً للموظف.'}
                </p>
                {sortedQuarries.length === 0 ? (
                  <p className="muted" style={{ fontSize: '13px' }}>لا توجد محاجر مسجلة في هذا المكتب.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {sortedQuarries.map((q) => {
                      const isVisible = !empHiddenQuarries.includes(q.id);
                      return (
                        <div
                          key={q.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 12px',
                            borderRadius: '4px',
                            backgroundColor: 'var(--surface, #ffffff)',
                            border: '1px solid var(--line)',
                          }}
                        >
                          <div>
                            <span style={{ fontWeight: 600, fontSize: '13px' }}>{q.name}</span>
                            {q.quarry_number && (
                              <span className="muted" style={{ fontSize: '12px', marginRight: '8px' }}>
                                ({q.quarry_number})
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => toggleHiddenQuarry(q.id)}
                            className={`button ${isVisible ? 'primary' : 'secondary'}`}
                            style={{
                              fontSize: '12px',
                              padding: '4px 10px',
                              backgroundColor: isVisible ? '#15803d' : '#f3f4f6',
                              color: isVisible ? '#ffffff' : '#374151',
                            }}
                          >
                            {isVisible ? '✓ ظاهر للموظف' : '✗ مخفي عن الموظف'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="mt-16" style={{ padding: '14px', borderRadius: '6px', backgroundColor: 'rgba(0,0,0,0.02)', border: '1px solid var(--line)' }}>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '14px' }}>الصلاحيات التشغيلية لكل محجر</h4>
                <p className="muted" style={{ fontSize: '12px', margin: '0 0 12px 0' }}>
                  تسري صلاحيات المحجر المحددة هنا عند فحص العمليات، مع بقاء المحاجر المخفية غير متاحة للموظف.
                </p>
                {sortedQuarries.length === 0 ? (
                  <p className="muted" style={{ fontSize: '13px' }}>لا توجد محاجر لتعيين الصلاحيات.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {sortedQuarries.map((quarry) => {
                      const current = empQuarryPermissions[quarry.id] || {
                        can_view: empCanView,
                        can_upload: empCanUpload,
                        can_download: empCanDownload,
                        can_delete: empCanDelete,
                      };
                      const companyPermissionAllowed: PermissionFlags = {
                        can_view: empCanView,
                        can_upload: empCanUpload,
                        can_download: empCanDownload,
                        can_delete: empCanDelete,
                      };
                      const fields: Array<[keyof PermissionFlags, string]> = [
                        ['can_view', 'عرض'],
                        ['can_upload', 'رفع'],
                        ['can_download', 'تحميل'],
                        ['can_delete', 'حذف'],
                      ];
                      const conflictFields = fields
                        .filter(([field]) => !companyPermissionAllowed[field] && current[field])
                        .map(([, label]) => label);
                      return (
                        <div key={quarry.id} style={{ padding: '10px', border: '1px solid var(--line)', borderRadius: '4px', backgroundColor: 'var(--surface, #fff)' }}>
                          <strong style={{ fontSize: '13px' }}>{quarry.name}</strong>
                          {quarry.status !== 'active' && <span className="badge muted" style={{ marginRight: '8px' }}>غير نشط</span>}
                          {conflictFields.length > 0 && (
                            <div className="badge danger" style={{ display: 'block', whiteSpace: 'normal', marginTop: '6px' }}>
                              تعارض يحتاج إلى مراجعة يدوية: {conflictFields.join('، ')}. لن تُعدّل السجلات تلقائياً.
                            </div>
                          )}
                          <div className="row mt-8" style={{ gap: '12px', flexWrap: 'wrap' }}>
                            {fields.map(([field, label]) => (
                              <label key={field} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px' }}>
                                <input
                                  type="checkbox"
                                  checked={current[field]}
                                  disabled={!companyPermissionAllowed[field] && !current[field]}
                                  onChange={(event) => setEmpQuarryPermissions((previous) => ({
                                    ...previous,
                                    [quarry.id]: { ...current, [field]: event.target.checked },
                                  }))}
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="row mt-20" style={{ justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setSelectedEmp(null)}
                  disabled={savingPerms}
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={savingPerms}
                >
                  {savingPerms ? t.loading : t.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
