import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { translations, fmtBytes, formatDate } from '../lib/i18n';
import { Quarry, DocumentItem } from '../lib/types';
import { ApiClient } from '../lib/api';
import { sortAlphabetically } from '../lib/sorting';

interface TrashRecoveryProps {
  quarries: Quarry[];
}

export const TrashRecovery: React.FC<TrashRecoveryProps> = ({ quarries }) => {
  const router = useRouter();
  const t = translations;
  const sortedQuarries = sortAlphabetically(quarries, (q) => q.name);
  const [selectedQuarryId, setSelectedQuarryId] = useState<string>(sortedQuarries[0]?.id || '');
  const [trashItems, setTrashItems] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // Permanent Delete Modal State
  const [permanentDeleteDoc, setPermanentDeleteDoc] = useState<DocumentItem | null>(null);
  const [permanentDeleting, setPermanentDeleting] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showToast = (type: 'success' | 'error', text: string) => {
    setToastMsg({ type, text });
    setTimeout(() => setToastMsg(null), 5000);
  };

  useEffect(() => {
    if (router.isReady) {
      const qQuarryId = router.query.quarryId as string | undefined;
      if (qQuarryId && sortedQuarries.some((q) => q.id === qQuarryId)) {
        if (selectedQuarryId !== qQuarryId) {
          setSelectedQuarryId(qQuarryId);
        }
      } else if (!selectedQuarryId && sortedQuarries.length > 0) {
        setSelectedQuarryId(sortedQuarries[0].id);
      }
    }
  }, [router.isReady, router.query.quarryId, sortedQuarries]);

  const handleQuarryChange = (quarryId: string) => {
    setSelectedQuarryId(quarryId);
    if (router.isReady) {
      router.replace(
        { pathname: router.pathname, query: { ...router.query, quarryId } },
        undefined,
        { shallow: true }
      );
    }
  };

  const loadTrash = async () => {
    if (!selectedQuarryId) return;
    setLoading(true);
    try {
      const items = await ApiClient.getQuarryTrash(selectedQuarryId);
      setTrashItems(items);
    } catch (err: any) {
      console.error(err);
      showToast('error', err.message || 'حدث خطأ أثناء تحميل سلة المهملات');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTrash();
  }, [selectedQuarryId]);

  const handleRestore = async (docId: string) => {
    if (!confirm(t.confirmRestore)) return;
    setRestoringId(docId);
    try {
      await ApiClient.restoreDocument(selectedQuarryId, docId);
      showToast('success', 'تمت استعادة المستند بنجاح إلى المجلد الأصلي.');
      await loadTrash();
    } catch (err: any) {
      showToast('error', err.message || 'فشلت عملية استعادة المستند');
    } finally {
      setRestoringId(null);
    }
  };

  const handleConfirmPermanentDelete = async () => {
    if (!permanentDeleteDoc || !selectedQuarryId) return;
    setPermanentDeleting(true);
    try {
      await ApiClient.permanentlyDeleteDocument(selectedQuarryId, permanentDeleteDoc.id);
      setTrashItems((prev) => prev.filter((item) => item.id !== permanentDeleteDoc.id));
      showToast('success', t.permanentDeleteSuccess || 'تم حذف المستند وجميع نسخه وملفاته نهائياً.');
      setPermanentDeleteDoc(null);
    } catch (err: any) {
      showToast('error', err.message || 'فشل الحذف النهائي للمستند');
    } finally {
      setPermanentDeleting(false);
    }
  };

  const sortedTrashItems = sortAlphabetically(
    trashItems,
    (d) => d.display_name || d.title || d.original_filename || d.file_name || ''
  );

  return (
    <div className="card">
      <div className="spread">
        <div>
          <h2>{t.trashTitle}</h2>
          <p className="muted">{t.trashSubtitle}</p>
        </div>
        <select
          value={selectedQuarryId}
          onChange={(e) => handleQuarryChange(e.target.value)}
          style={{ minWidth: '200px' }}
        >
          {sortedQuarries.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </select>
      </div>

      {toastMsg && (
        <div
          style={{
            marginTop: '12px',
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

      <div className="table-responsive mt-16" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)' }}>
              <th style={{ padding: '8px' }}>{t.documentName}</th>
              <th style={{ padding: '8px' }}>{t.size}</th>
              <th style={{ padding: '8px' }}>{t.deletedAt}</th>
              <th style={{ padding: '8px' }}>{t.retentionExpires}</th>
              <th style={{ padding: '8px' }}>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} style={{ padding: '16px', textAlign: 'center' }} className="muted">
                  {t.loading}
                </td>
              </tr>
            ) : sortedTrashItems.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: '16px', textAlign: 'center' }} className="muted">
                  {t.noTrash}
                </td>
              </tr>
            ) : (
              sortedTrashItems.map((doc) => {
                const docTitle = doc.display_name || doc.title || doc.original_filename || doc.file_name || 'مستند';
                const docSize = doc.size_bytes !== undefined ? doc.size_bytes : (doc.file_size || 0);
                const purgeDate = doc.purge_at || doc.retention_expires_at;
                return (
                  <tr key={doc.id} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td style={{ padding: '10px 8px', fontWeight: 600 }}>{docTitle}</td>
                    <td style={{ padding: '10px 8px' }}>{fmtBytes(docSize)}</td>
                    <td style={{ padding: '10px 8px' }}>{formatDate(doc.deleted_at)}</td>
                    <td style={{ padding: '10px 8px' }}>{formatDate(purgeDate)}</td>
                    <td style={{ padding: '10px 8px' }}>
                      <div className="row" style={{ gap: '6px' }}>
                        <button
                          className="button primary"
                          style={{ fontSize: '12px', padding: '4px 8px' }}
                          onClick={() => handleRestore(doc.id)}
                          disabled={restoringId === doc.id || permanentDeleting}
                        >
                          {restoringId === doc.id ? t.restoring : `⟲ ${t.restore}`}
                        </button>
                        <button
                          className="button danger"
                          style={{ fontSize: '12px', padding: '4px 8px', backgroundColor: '#dc2626', color: '#ffffff' }}
                          onClick={() => setPermanentDeleteDoc(doc)}
                          disabled={permanentDeleting || restoringId === doc.id}
                        >
                          🗑 {t.permanentDelete || 'حذف نهائي'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Confirmation Modal for Permanent Delete */}
      {permanentDeleteDoc && (
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
              maxWidth: '520px',
              width: '100%',
              padding: '24px',
              backgroundColor: 'var(--surface, #ffffff)',
              borderRadius: '8px',
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.25)',
            }}
          >
            <h3 style={{ marginTop: 0, color: '#dc2626', display: 'flex', alignItems: 'center', gap: '8px' }}>
              ⚠️ {t.confirmPermanentDeleteTitle || 'تأكيد الحذف النهائي للمستند'}
            </h3>
            <p style={{ fontSize: '14px', lineHeight: 1.6, color: 'var(--text, #1f2937)', marginTop: '12px' }}>
              {t.confirmPermanentDeleteMessage ||
                'تحذير: هل أنت متأكد من رغبتك في حذف هذا المستند نهائياً؟ سيتم حذف جميع النسخ والملفات المرتبطة به نهائياً من مخزن الملفات وقاعدة البيانات ولن يمكن استعادته مطلقاً.'}
            </p>
            <div
              style={{
                marginTop: '12px',
                padding: '12px',
                borderRadius: '6px',
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: '13px' }}>
                📄 {permanentDeleteDoc.display_name || permanentDeleteDoc.original_filename}
              </div>
              <div className="muted" style={{ fontSize: '12px', marginTop: '4px' }}>
                الحجم: {fmtBytes(permanentDeleteDoc.size_bytes || permanentDeleteDoc.file_size)}
              </div>
            </div>

            <div className="row mt-20" style={{ justifyContent: 'flex-end', gap: '10px' }}>
              <button
                type="button"
                className="button secondary"
                onClick={() => setPermanentDeleteDoc(null)}
                disabled={permanentDeleting}
              >
                {t.cancel}
              </button>
              <button
                type="button"
                className="button danger"
                onClick={handleConfirmPermanentDelete}
                disabled={permanentDeleting}
                style={{ backgroundColor: '#dc2626', color: '#ffffff' }}
              >
                {permanentDeleting ? t.permanentlyDeleting || 'جاري الحذف...' : t.permanentDelete || 'حذف نهائي'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
