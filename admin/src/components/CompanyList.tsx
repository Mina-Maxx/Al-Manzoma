import React, { useState } from 'react';
import { translations as t, fmtBytes } from '../lib/i18n';
import { Company } from '../lib/types';
import { ApiClient } from '../lib/api';
import { sortAlphabetically } from '../lib/sorting';

interface CompanyListProps {
  companies: Company[];
  onRefresh: () => void;
  onSelectCompany: (company: Company) => void;
}

export const CompanyList: React.FC<CompanyListProps> = ({
  companies,
  onRefresh,
  onSelectCompany,
}) => {
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [quotaGb, setQuotaGb] = useState('5');
  const [maxUsers, setMaxUsers] = useState('50');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const sortedCompanies = sortAlphabetically(companies, (c) => c.name);
  const filtered = sortedCompanies.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setMsg(null);
    try {
      const quotaBytes = parseFloat(quotaGb) * 1024 * 1024 * 1024;
      await ApiClient.createCompany({
        name: name.trim(),
        quota_bytes: isNaN(quotaBytes) ? undefined : quotaBytes,
        max_users: parseInt(maxUsers, 10) || undefined,
      });
      setName('');
      setShowCreate(false);
      onRefresh();
    } catch (err: any) {
      setMsg({ text: err.message, error: true });
    } finally {
      setLoading(false);
    }
  };

  const handleToggleStatus = async (comp: Company) => {
    const nextStatus = comp.status === 'active' ? 'suspended' : 'active';
    try {
      await ApiClient.updateCompanyStatus(comp.id, nextStatus);
      onRefresh();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteCompany = async (comp: Company) => {
    const confirmation = window.prompt(`${t.confirmDeleteCompanyPrompt}\n\n${comp.name}`);
    if (confirmation === null) return;
    if (confirmation !== comp.name) {
      alert(t.companyDeleteNameMismatch);
      return;
    }
    try {
      await ApiClient.deleteCompany(comp.id, confirmation);
      onRefresh();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="card">
      <div className="spread">
        <h2>{t.companies}</h2>
        <button
          className="button primary"
          onClick={() => setShowCreate(!showCreate)}
        >
          {showCreate ? t.cancel : `+ ${t.createCompany}`}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="card sub-card mt-16">
          <h3>{t.createCompany}</h3>
          {msg && <p style={{ color: msg.error ? '#b91c1c' : '#166534' }}>{msg.text}</p>}
          <div className="row" style={{ marginTop: '12px' }}>
            <input
              type="text"
              placeholder={t.companyName}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{ flex: 2, minWidth: '200px' }}
            />
            <input
              type="number"
              placeholder="السعة (جيجابايت)"
              value={quotaGb}
              onChange={(e) => setQuotaGb(e.target.value)}
              style={{ flex: 1, minWidth: '100px' }}
            />
            <input
              type="number"
              placeholder="الحد الأقصى للمستخدمين"
              value={maxUsers}
              onChange={(e) => setMaxUsers(e.target.value)}
              style={{ flex: 1, minWidth: '100px' }}
            />
            <button type="submit" className="button primary" disabled={loading}>
              {loading ? t.loading : t.create}
            </button>
          </div>
        </form>
      )}

      <div className="row mt-16">
        <input
          type="text"
          placeholder={t.searchOffices}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
      </div>

      <div className="table-responsive mt-16" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)' }}>
              <th style={{ padding: '8px' }}>{t.name}</th>
              <th style={{ padding: '8px' }}>{t.status}</th>
              <th style={{ padding: '8px' }}>{t.users}</th>
              <th style={{ padding: '8px' }}>{t.usage}</th>
              <th style={{ padding: '8px' }}>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: '16px', textAlign: 'center' }} className="muted">
                  {t.noCompanies}
                </td>
              </tr>
            ) : (
              filtered.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '10px 8px', fontWeight: 600 }}>{c.name}</td>
                  <td style={{ padding: '10px 8px' }}>
                    <span className={`badge ${c.status === 'active' ? 'success' : 'danger'}`}>
                      {c.status === 'active' ? t.active : t.suspendedOffices || 'معلق'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    {c.user_count || 0} / {c.max_users || 50}
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    {fmtBytes(c.storage_bytes || 0)} / {fmtBytes(c.quota_bytes || 5 * 1024 * 1024 * 1024)}
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    <div className="row">
                      <button
                        className="button secondary"
                        style={{ fontSize: '12px', padding: '4px 8px' }}
                        onClick={() => onSelectCompany(c)}
                      >
                        {t.viewCompanyData}
                      </button>
                      <button
                        className={`button ${c.status === 'active' ? 'danger' : 'secondary'}`}
                        style={{ fontSize: '12px', padding: '4px 8px' }}
                        onClick={() => handleToggleStatus(c)}
                      >
                        {c.status === 'active' ? t.suspend : t.reactivate}
                      </button>
                      <button
                        className="button danger"
                        style={{ fontSize: '12px', padding: '4px 8px' }}
                        onClick={() => handleDeleteCompany(c)}
                      >
                        {t.deleteCompany}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
