import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { translations } from '../lib/i18n';
import { UserAccount, Company } from '../lib/types';
import { ApiClient } from '../lib/api';
import { sortAlphabetically } from '../lib/sorting';

interface UserDirectoryProps {
  users: UserAccount[];
  companies: Company[];
  onRefresh: () => void | Promise<void>;
}

export const UserDirectory: React.FC<UserDirectoryProps> = ({
  users,
  companies,
  onRefresh,
}) => {
  const router = useRouter();
  const t = translations;
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (router.isReady) {
      if (typeof router.query.search === 'string' && router.query.search !== search) {
        setSearch(router.query.search);
      }
      if (typeof router.query.role === 'string' && router.query.role !== roleFilter) {
        setRoleFilter(router.query.role);
      }
      if (typeof router.query.status === 'string' && router.query.status !== statusFilter) {
        setStatusFilter(router.query.status);
      }
    }
  }, [router.isReady, router.query.search, router.query.role, router.query.status]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (router.isReady) {
      const query: Record<string, any> = { ...router.query };
      if (val) query.search = val; else delete query.search;
      router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    }
  };

  const handleRoleFilterChange = (val: string) => {
    setRoleFilter(val);
    if (router.isReady) {
      const query: Record<string, any> = { ...router.query };
      if (val) query.role = val; else delete query.role;
      router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    }
  };

  const handleStatusFilterChange = (val: string) => {
    setStatusFilter(val);
    if (router.isReady) {
      const query: Record<string, any> = { ...router.query };
      if (val) query.status = val; else delete query.status;
      router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    }
  };

  // Notification Banner
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Create form state
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'platform_admin' | 'company_admin' | 'employee'>('employee');
  const [companyId, setCompanyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Edit Modal State
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState<'platform_admin' | 'company_admin' | 'employee'>('employee');
  const [editCompanyId, setEditCompanyId] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'disabled'>('active');
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState('');

  // Delete Modal State
  const [deletingUser, setDeletingUser] = useState<UserAccount | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Reset Password Modal State
  const [resetUser, setResetUser] = useState<UserAccount | null>(null);
  const [tempPassword, setTempPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState('');

  const sortedUsers = sortAlphabetically(users, (u) => u.full_name || u.username);
  const filtered = sortedUsers.filter((u) => {
    const matchesSearch =
      u.username.toLowerCase().includes(search.toLowerCase()) ||
      (u.email && u.email.toLowerCase().includes(search.toLowerCase())) ||
      (u.full_name && u.full_name.toLowerCase().includes(search.toLowerCase()));

    const matchesRole = !roleFilter || u.role === roleFilter;
    const matchesStatus = !statusFilter || u.status === statusFilter;

    return matchesSearch && matchesRole && matchesStatus;
  });

  const showToast = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');
    try {
      await ApiClient.createPlatformUser({
        username: username.trim(),
        email: email.trim(),
        password,
        role,
        company_id: role !== 'platform_admin' ? companyId : undefined,
        full_name: fullName.trim() || undefined,
      });
      setUsername('');
      setEmail('');
      setFullName('');
      setPassword('');
      setShowCreate(false);
      showToast('success', t.userUpdatedSuccess || 'تم إنشاء المستخدم بنجاح');
      await onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleStartEdit = (user: UserAccount) => {
    setEditingUser(user);
    setEditFullName(user.full_name || '');
    setEditUsername(user.username || '');
    setEditEmail(user.email || '');
    setEditRole(user.role);
    setEditCompanyId(user.company_id || '');
    setEditStatus(user.status);
    setEditError('');
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setEditLoading(true);
    setEditError('');
    try {
      await ApiClient.updatePlatformUser(editingUser.id, {
        full_name: editFullName.trim(),
        username: editUsername.trim(),
        email: editEmail.trim(),
        role: editRole,
        company_id: editRole !== 'platform_admin' ? editCompanyId : undefined,
        status: editStatus,
      });
      setEditingUser(null);
      showToast('success', t.userUpdatedSuccess);
      await onRefresh();
    } catch (err: any) {
      setEditError(err.message || 'Failed to update user');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deletingUser) return;
    setDeleteLoading(true);
    setDeleteError('');
    try {
      await ApiClient.deletePlatformUser(deletingUser.id);
      setDeletingUser(null);
      showToast('success', t.userDeletedSuccess);
      await onRefresh();
    } catch (err: any) {
      setDeleteError(err.message || 'Failed to delete user');
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetUser) return;
    if (tempPassword.length < 8) {
      setResetError('Password must be at least 8 characters');
      return;
    }
    if (tempPassword !== confirmPassword) {
      setResetError('Passwords do not match');
      return;
    }
    setResetLoading(true);
    setResetError('');
    try {
      await ApiClient.resetPlatformUserPassword(resetUser.id, tempPassword);
      setResetUser(null);
      setTempPassword('');
      setConfirmPassword('');
      showToast('success', t.userResetSuccess);
      await onRefresh();
    } catch (err: any) {
      setResetError(err.message || 'Failed to reset password');
    } finally {
      setResetLoading(false);
    }
  };

  const handleToggleStatus = async (user: UserAccount) => {
    const nextStatus = user.status === 'active' ? 'disabled' : 'active';
    if (!confirm(nextStatus === 'disabled' ? t.confirmDeactivate : 'تفعيل الحساب؟')) return;
    try {
      await ApiClient.updateUserStatus(user.id, nextStatus);
      showToast('success', nextStatus === 'disabled' ? 'تم تعطيل حساب المستخدم بنجاح.' : 'تم تفعيل حساب المستخدم بنجاح.');
      await onRefresh();
    } catch (err: any) {
      showToast('error', err.message);
    }
  };

  const handleRevokeSessions = async (user: UserAccount) => {
    if (!confirm(t.confirmRevokeSessions)) return;
    try {
      await ApiClient.revokeUserSessions(user.id);
      showToast('success', t.sessionsRevokedSuccess);
      onRefresh();
    } catch (err: any) {
      showToast('error', err.message);
    }
  };

  return (
    <div className="card">
      <div className="spread">
        <h2>{t.globalUsersTitle}</h2>
        <button
          className="button primary"
          onClick={() => setShowCreate(!showCreate)}
        >
          {showCreate ? t.cancel : `+ ${t.createEmployeeAccount}`}
        </button>
      </div>

      {/* Toast Notification */}
      {notification && (
        <div
          style={{
            marginTop: '12px',
            padding: '10px 14px',
            borderRadius: '6px',
            backgroundColor: notification.type === 'success' ? '#dcfce7' : '#fee2e2',
            color: notification.type === 'success' ? '#166534' : '#991b1b',
            border: `1px solid ${notification.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          {notification.message}
        </div>
      )}

      {showCreate && (
        <form onSubmit={handleCreate} className="card sub-card mt-16">
          <h3>{t.createEmployeeAccount}</h3>
          {errorMsg && <p style={{ color: '#b91c1c' }}>{errorMsg}</p>}
          <div className="row" style={{ marginTop: '12px', flexWrap: 'wrap', gap: '8px' }}>
            <input
              type="text"
              placeholder={t.username}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              style={{ flex: 1, minWidth: '140px' }}
            />
            <input
              type="email"
              placeholder={t.email}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ flex: 1, minWidth: '140px' }}
            />
            <input
              type="password"
              placeholder={t.initialPassword}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              style={{ flex: 1, minWidth: '140px' }}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as any)}
              style={{ flex: 1, minWidth: '140px' }}
            >
              <option value="employee">{t.roleEmployee}</option>
              <option value="company_admin">{t.roleCompanyAdmin}</option>
              <option value="platform_admin">{t.rolePlatformAdmin}</option>
            </select>
            {role !== 'platform_admin' && (
              <select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                required
                style={{ flex: 1, minWidth: '140px' }}
              >
                <option value="">-- {t.office} --</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <button type="submit" className="button primary" disabled={loading}>
              {loading ? t.loading : t.create}
            </button>
          </div>
        </form>
      )}

      <div className="row mt-16" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <input
          type="text"
          placeholder={t.searchUsers}
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          style={{ flex: 2, minWidth: '200px' }}
        />
        <select
          value={roleFilter}
          onChange={(e) => handleRoleFilterChange(e.target.value)}
          style={{ flex: 1, minWidth: '130px' }}
        >
          <option value="">{t.roleFilter}</option>
          <option value="platform_admin">{t.rolePlatformAdmin}</option>
          <option value="company_admin">{t.roleCompanyAdmin}</option>
          <option value="employee">{t.roleEmployee}</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => handleStatusFilterChange(e.target.value)}
          style={{ flex: 1, minWidth: '130px' }}
        >
          <option value="">{t.allStatuses}</option>
          <option value="active">{t.active}</option>
          <option value="disabled">{t.disabled}</option>
        </select>
      </div>

      <div className="table-responsive mt-16" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)' }}>
              <th style={{ padding: '8px' }}>{t.username}</th>
              <th style={{ padding: '8px' }}>{t.fullName}</th>
              <th style={{ padding: '8px' }}>{t.email}</th>
              <th style={{ padding: '8px' }}>{t.role}</th>
              <th style={{ padding: '8px' }}>{t.office}</th>
              <th style={{ padding: '8px' }}>{t.status}</th>
              <th style={{ padding: '8px', minWidth: '260px' }}>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: '16px', textAlign: 'center' }} className="muted">
                  {t.noUsers}
                </td>
              </tr>
            ) : (
              filtered.map((u) => (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '10px 8px', fontWeight: 600 }}>{u.username}</td>
                  <td style={{ padding: '10px 8px' }}>{u.full_name || '-'}</td>
                  <td style={{ padding: '10px 8px' }}>{u.email || '-'}</td>
                  <td style={{ padding: '10px 8px' }}>
                    <span className="badge info">
                      {u.role === 'platform_admin' ? t.rolePlatformAdmin : u.role === 'company_admin' ? t.roleCompanyAdmin : t.roleEmployee}
                    </span>
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    {u.company_name || (u.role === 'platform_admin' ? t.globalPlatform : '-')}
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    <span className={`badge ${u.status === 'active' ? 'success' : 'danger'}`}>
                      {u.status === 'active' ? t.active : t.disabled}
                    </span>
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    <div className="row" style={{ gap: '4px', flexWrap: 'wrap' }}>
                      <button
                        className="button secondary"
                        style={{ fontSize: '11px', padding: '3px 7px' }}
                        onClick={() => handleStartEdit(u)}
                      >
                        ✏️ {t.edit}
                      </button>
                      <button
                        className="button secondary"
                        style={{ fontSize: '11px', padding: '3px 7px' }}
                        onClick={() => {
                          setResetUser(u);
                          setTempPassword('');
                          setConfirmPassword('');
                          setResetError('');
                        }}
                        title={t.resetPassword}
                      >
                        🔑 {t.resetPassword}
                      </button>
                      <button
                        className={`button ${u.status === 'active' ? 'secondary' : 'primary'}`}
                        style={{ fontSize: '11px', padding: '3px 7px' }}
                        onClick={() => handleToggleStatus(u)}
                      >
                        {u.status === 'active' ? t.disable : t.enable}
                      </button>
                      <button
                        className="button secondary"
                        style={{ fontSize: '11px', padding: '3px 7px' }}
                        onClick={() => handleRevokeSessions(u)}
                        title={t.revokeSessions}
                      >
                        {t.revokeSessions}
                      </button>
                      <button
                        className="button danger"
                        style={{ fontSize: '11px', padding: '3px 7px' }}
                        onClick={() => {
                          setDeletingUser(u);
                          setDeleteError('');
                        }}
                      >
                        🗑️ {t.deleteUser}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Edit User Modal */}
      {editingUser && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
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
              maxWidth: '500px',
              width: '100%',
              backgroundColor: '#fff',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <div className="spread">
              <h3>{t.editAccount}</h3>
              <button
                className="button secondary"
                style={{ padding: '2px 8px' }}
                onClick={() => setEditingUser(null)}
              >
                ✕
              </button>
            </div>

            {editError && (
              <p style={{ color: '#b91c1c', fontSize: '13px', marginTop: '8px' }}>
                {editError}
              </p>
            )}

            <form onSubmit={handleSaveEdit} style={{ marginTop: '16px' }}>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {t.fullName}
                </label>
                <input
                  type="text"
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {t.username}
                </label>
                <input
                  type="text"
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  required
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {t.email}
                </label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  required
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {t.role}
                </label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as any)}
                  style={{ width: '100%' }}
                >
                  <option value="employee">{t.roleEmployee}</option>
                  <option value="company_admin">{t.roleCompanyAdmin}</option>
                  <option value="platform_admin">{t.rolePlatformAdmin}</option>
                </select>
                <p className="muted" style={{ fontSize: '11px', marginTop: '4px' }}>
                  {t.roleChangeWarning}
                </p>
              </div>

              {editRole !== 'platform_admin' && (
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                    {t.office}
                  </label>
                  <select
                    value={editCompanyId}
                    onChange={(e) => setEditCompanyId(e.target.value)}
                    required
                    style={{ width: '100%' }}
                  >
                    <option value="">-- {t.office} --</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {t.status}
                </label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as any)}
                  style={{ width: '100%' }}
                >
                  <option value="active">{t.active}</option>
                  <option value="disabled">{t.disabled}</option>
                </select>
              </div>

              <div className="spread" style={{ marginTop: '20px' }}>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setEditingUser(null)}
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={editLoading}
                >
                  {editLoading ? t.loading : t.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete User Modal */}
      {deletingUser && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
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
              maxWidth: '440px',
              width: '100%',
              backgroundColor: '#fff',
            }}
          >
            <h3>{t.deleteUser} — {deletingUser.username}</h3>
            <p style={{ fontSize: '13px', marginTop: '12px', color: '#4b5563', lineHeight: '1.5' }}>
              {t.confirmDeleteUser}
            </p>

            {deleteError && (
              <p style={{ color: '#b91c1c', fontSize: '13px', marginTop: '8px' }}>
                {deleteError}
              </p>
            )}

            <div className="spread" style={{ marginTop: '20px' }}>
              <button
                type="button"
                className="button secondary"
                onClick={() => setDeletingUser(null)}
                disabled={deleteLoading}
              >
                {t.cancel}
              </button>
              <button
                type="button"
                className="button danger"
                onClick={handleDeleteUser}
                disabled={deleteLoading}
              >
                {deleteLoading ? t.loading : t.deleteUser}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resetUser && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
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
              maxWidth: '440px',
              width: '100%',
              backgroundColor: '#fff',
            }}
          >
            <h3>{t.resetPassword} — {resetUser.username}</h3>
            <p className="muted" style={{ fontSize: '12px', marginTop: '4px' }}>
              {t.mustChangePasswordNotice}
            </p>

            {resetError && (
              <p style={{ color: '#b91c1c', fontSize: '13px', marginTop: '8px' }}>
                {resetError}
              </p>
            )}

            <form onSubmit={handleResetPassword} style={{ marginTop: '16px' }}>
              <div style={{ marginBottom: '12px' }}>
                <div className="spread">
                  <label style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                    {t.temporaryPassword}
                  </label>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: 'var(--primary, #2563eb)', fontSize: '11px', cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => {
                      const gen = 'Temp#' + Math.random().toString(36).substring(2, 8) + '1!';
                      setTempPassword(gen);
                      setConfirmPassword(gen);
                    }}
                  >
                    {t.generateRandomPassword}
                  </button>
                </div>
                <input
                  type="text"
                  placeholder={t.initialPasswordPlaceholder}
                  value={tempPassword}
                  onChange={(e) => setTempPassword(e.target.value)}
                  required
                  style={{ width: '100%', fontFamily: 'monospace' }}
                />
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {t.confirmPassword}
                </label>
                <input
                  type="text"
                  placeholder={t.confirmPassword}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  style={{ width: '100%', fontFamily: 'monospace' }}
                />
              </div>

              <div className="spread" style={{ marginTop: '20px' }}>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setResetUser(null)}
                  disabled={resetLoading}
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={resetLoading}
                >
                  {resetLoading ? t.loading : t.confirmReset}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
