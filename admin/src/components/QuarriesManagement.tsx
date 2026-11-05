import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { translations, fmtBytes, formatDate } from '../lib/i18n';
import { Quarry, Folder, DocumentItem } from '../lib/types';
import { ApiClient } from '../lib/api';
import { sortAlphabetically } from '../lib/sorting';

interface QuarriesManagementProps {
  quarries: Quarry[];
  onRefreshQuarries: () => void | Promise<void>;
  isPlatformAdmin: boolean;
}

export const QuarriesManagement: React.FC<QuarriesManagementProps> = ({
  quarries,
  onRefreshQuarries,
  isPlatformAdmin,
}) => {
  const router = useRouter();
  const t = translations;
  const [selectedQuarryId, setSelectedQuarryId] = useState<string>(quarries.find((q) => q.status === 'active')?.id || '');
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>('');
  const [uploadSuccess, setUploadSuccess] = useState<string>('');
  const [newQuarryName, setNewQuarryName] = useState('');
  const [creatingQuarry, setCreatingQuarry] = useState(false);
  const [renamingDoc, setRenamingDoc] = useState<DocumentItem | null>(null);
  const [renameInput, setRenameInput] = useState<string>('');
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [renameError, setRenameError] = useState<string>('');
  const [renameSuccess, setRenameSuccess] = useState<string>('');

  // Office Quarry Management State
  const [newQuarryNumber, setNewQuarryNumber] = useState('');
  const [newQuarryType, setNewQuarryType] = useState('');
  const [editingQuarry, setEditingQuarry] = useState<Quarry | null>(null);
  const [editName, setEditName] = useState('');
  const [editNumber, setEditNumber] = useState('');
  const [editType, setEditType] = useState('');
  const [isEditingQuarry, setIsEditingQuarry] = useState(false);
  const [showQuarriesDirectory, setShowQuarriesDirectory] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showToast = (type: 'success' | 'error', text: string) => {
    setToastMsg({ type, text });
    setTimeout(() => setToastMsg(null), 5000);
  };

  // Restore quarryId and folderId from router.query
  useEffect(() => {
    if (router.isReady) {
      const qQuarryId = router.query.quarryId as string | undefined;
      const qFolderId = router.query.folderId as string | undefined;

      const activeQuarries = quarries.filter((q) => q.status === 'active');
      if (qQuarryId && activeQuarries.some((q) => q.id === qQuarryId)) {
        if (selectedQuarryId !== qQuarryId) {
          setSelectedQuarryId(qQuarryId);
        }
      } else if (!activeQuarries.some((q) => q.id === selectedQuarryId)) {
        setSelectedQuarryId(activeQuarries[0]?.id || '');
      }

      if (qFolderId !== undefined && qFolderId !== selectedFolderId) {
        setSelectedFolderId(qFolderId);
      }
    }
  }, [router.isReady, router.query.quarryId, router.query.folderId, quarries]);

  const handleQuarryChange = (quarryId: string) => {
    setSelectedQuarryId(quarryId);
    setSelectedFolderId('');
    if (router.isReady) {
      const query: Record<string, any> = { ...router.query, quarryId };
      delete query.folderId;
      router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    }
  };

  const handleFolderChange = (folderId: string) => {
    setSelectedFolderId(folderId);
    if (router.isReady) {
      const query: Record<string, any> = { ...router.query };
      if (folderId) {
        query.folderId = folderId;
      } else {
        delete query.folderId;
      }
      router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    }
  };

  const loadDocsAndFolders = async () => {
    if (!selectedQuarryId) {
      setDocuments([]);
      setFolders([]);
      return;
    }
    setLoadingDocs(true);
    try {
      const [docs, fldrs] = await Promise.all([
        ApiClient.getQuarryDocuments(selectedQuarryId, selectedFolderId || null),
        ApiClient.getQuarryFolders(selectedQuarryId),
      ]);
      setDocuments(docs);
      setFolders(fldrs);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoadingDocs(false);
    }
  };

  useEffect(() => {
    loadDocsAndFolders();
  }, [selectedQuarryId, selectedFolderId]);

  const handleCreateQuarry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuarryName.trim()) return;
    setCreatingQuarry(true);
    try {
      const created = await ApiClient.createCompanyQuarry({
        name: newQuarryName.trim(),
        quarry_number: newQuarryNumber.trim() || undefined,
        quarry_type: newQuarryType.trim() || undefined,
      });
      setNewQuarryName('');
      setNewQuarryNumber('');
      setNewQuarryType('');
      showToast('success', t.quarryCreatedSuccess || 'تم إنشاء المحجر بنجاح.');
      await onRefreshQuarries();
      setSelectedQuarryId(created.id);
    } catch (err: any) {
      showToast('error', err.message || 'فشل في إنشاء المحجر');
    } finally {
      setCreatingQuarry(false);
    }
  };

  const handleStartEditQuarry = (q: Quarry) => {
    setEditingQuarry(q);
    setEditName(q.name);
    setEditNumber(q.quarry_number || '');
    setEditType(q.quarry_type || '');
  };

  const handleSaveEditQuarry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingQuarry || !editName.trim()) return;
    setIsEditingQuarry(true);
    try {
      await ApiClient.updateCompanyQuarry(editingQuarry.id, {
        name: editName.trim(),
        quarry_number: editNumber.trim() || undefined,
        quarry_type: editType.trim() || undefined,
      });
      showToast('success', t.quarryUpdatedSuccess || 'تم تحديث بيانات المحجر بنجاح.');
      setEditingQuarry(null);
      onRefreshQuarries();
    } catch (err: any) {
      showToast('error', err.message || 'فشل تحديث بيانات المحجر');
    } finally {
      setIsEditingQuarry(false);
    }
  };

  const handleArchiveQuarry = async (q: Quarry) => {
    const confirmMsg = t.confirmArchiveQuarryMessage ||
      `هل أنت متأكد من رغبتك في أرشفة المحجر "${q.name}"؟ لن يتمكن الموظفون من الوصول إليه ولكن سيتم حفظ جميع المستندات وسجلات التدقيق.`;
    if (!confirm(confirmMsg)) return;

    try {
      await ApiClient.deleteCompanyQuarry(q.id);
      showToast('success', t.quarryArchivedSuccess || 'تم أرشفة المحجر بنجاح.');
      await onRefreshQuarries();
      if (selectedQuarryId === q.id) {
        const remaining = quarries.find((item) => item.id !== q.id && item.status === 'active');
        setSelectedQuarryId(remaining?.id || '');
      }
    } catch (err: any) {
      showToast('error', err.message || 'فشل أرشفة المحجر');
    }
  };

  const handleReactivateQuarry = async (q: Quarry) => {
    try {
      await ApiClient.reactivateCompanyQuarry(q.id);
      showToast('success', t.quarryRestoredSuccess || 'تم إلغاء أرشفة المحجر.');
      await onRefreshQuarries();
      if (!selectedQuarryId) setSelectedQuarryId(q.id);
    } catch (err: any) {
      showToast('error', err.message || 'فشل إلغاء أرشفة المحجر');
    }
  };

  const handlePermanentDeleteQuarry = async (q: Quarry) => {
    if (!isPlatformAdmin) return;
    const confirmation = window.prompt(`${t.confirmDeleteQuarryPrompt}\n\n${q.name}`);
    if (confirmation === null) return;
    if (confirmation !== q.name) {
      showToast('error', t.quarryDeleteNameMismatch || 'اسم المحجر غير مطابق؛ لم يتم الحذف.');
      return;
    }
    try {
      await ApiClient.permanentlyDeleteCompanyQuarry(q.id, confirmation);
      showToast('success', t.quarryDeletedSuccess || 'تم حذف المحجر نهائياً.');
      await onRefreshQuarries();
      if (selectedQuarryId === q.id) {
        const remaining = quarries.find((item) => item.id !== q.id && item.status === 'active');
        setSelectedQuarryId(remaining?.id || '');
      }
    } catch (err: any) {
      showToast('error', err.message || 'فشل حذف المحجر نهائياً');
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedQuarryId || !uploadFile) return;
    setUploading(true);
    setUploadError('');
    setUploadSuccess('');
    try {
      const doc = await ApiClient.uploadDocument(selectedQuarryId, uploadFile, selectedFolderId || null);
      setUploadFile(null);
      // Reset file input
      const fileInput = document.getElementById('doc-file-input') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
      setUploadSuccess(`File "${doc.display_name || doc.title || uploadFile.name}" uploaded successfully.`);
      setTimeout(() => setUploadSuccess(''), 5000);
      await loadDocsAndFolders();
    } catch (err: any) {
      setUploadError(err.message || 'File upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (docId: string) => {
    if (!confirm(t.confirmDelete)) return;
    try {
      await ApiClient.deleteDocument(selectedQuarryId, docId);
      await loadDocsAndFolders();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleStartRename = (doc: DocumentItem) => {
    const currentName = doc.display_name || doc.title || doc.original_filename || doc.file_name || '';
    setRenamingDoc(doc);
    setRenameInput(currentName);
    setRenameError('');
    setRenameSuccess('');
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingDoc || !selectedQuarryId) return;
    const trimmed = renameInput.trim();
    if (!trimmed) {
      setRenameError(t.emptyFilenameError || 'Filename cannot be empty');
      return;
    }

    try {
      setIsRenaming(true);
      setRenameError('');
      const updated = await ApiClient.renameDocument(selectedQuarryId, renamingDoc.id, trimmed);
      setDocuments((prev) =>
        prev.map((d) => (d.id === renamingDoc.id ? { ...d, ...updated } : d))
      );
      setRenameSuccess(t.renameSuccess || 'تمت إعادة تسمية المستند بنجاح.');
      setTimeout(() => {
        setRenameSuccess('');
        setRenamingDoc(null);
      }, 1200);
    } catch (err: any) {
      setRenameError(err.message || t.renameError || 'فشل في إعادة تسمية المستند');
    } finally {
      setIsRenaming(false);
    }
  };

  const sortedQuarries = sortAlphabetically(quarries, (q) => q.name);
  const activeQuarries = sortedQuarries.filter((q) => q.status === 'active');
  const sortedFolders = sortAlphabetically(folders, (f) => f.name);
  const sortedDocuments = sortAlphabetically(
    documents,
    (d) => d.display_name || d.title || d.original_filename || d.file_name || ''
  );

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
      {/* Office Quarry Management & Creation Card */}
      <div className="card">
        <div className="spread">
          <div>
            <h3>{t.quarriesManagement || 'إدارة محاجر المكتب'}</h3>
            <p className="muted" style={{ fontSize: '13px' }}>
              إدارة بيانات المحاجر، الأرقام التشغيلية، نوع الخام، والأرشفة الآمنة.
            </p>
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() => setShowQuarriesDirectory(!showQuarriesDirectory)}
          >
            {showQuarriesDirectory ? 'إخفاء جدول المحاجر' : '📋 عرض جدول وإدارة المحاجر'}
          </button>
        </div>

        {/* Create Quarry Form */}
        <form onSubmit={handleCreateQuarry} className="mt-16" style={{ padding: '16px', backgroundColor: 'rgba(0,0,0,0.02)', borderRadius: '8px', border: '1px solid var(--line)' }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: '14px' }}>+ {t.createQuarry}</h4>
          <div className="row" style={{ gap: '10px', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder={t.quarryNamePlaceholder || 'اسم المحجر (مثال: محجر وادي النطرون)'}
              value={newQuarryName}
              onChange={(e) => setNewQuarryName(e.target.value)}
              required
              style={{ flex: 2, minWidth: '200px' }}
            />
            <input
              type="text"
              placeholder={t.quarryNumber || 'رقم المحجر (مثال: Q-101)'}
              value={newQuarryNumber}
              onChange={(e) => setNewQuarryNumber(e.target.value)}
              style={{ flex: 1, minWidth: '140px' }}
            />
            <input
              type="text"
              placeholder={t.quarryType || 'نوع الخام (مثال: جرانيت / حجر جيري)'}
              value={newQuarryType}
              onChange={(e) => setNewQuarryType(e.target.value)}
              style={{ flex: 1, minWidth: '140px' }}
            />
            <button type="submit" className="button primary" disabled={creatingQuarry} style={{ minWidth: '140px' }}>
              {creatingQuarry ? t.loading : `+ ${t.createQuarry}`}
            </button>
          </div>
        </form>

        {/* Quarries Directory Table */}
        {showQuarriesDirectory && (
          <div className="table-responsive mt-16" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '8px' }}>اسم المحجر</th>
                  <th style={{ padding: '8px' }}>{t.quarryNumber || 'رقم المحجر'}</th>
                  <th style={{ padding: '8px' }}>{t.quarryType || 'نوع الخام'}</th>
                  <th style={{ padding: '8px' }}>الحالة</th>
                  <th style={{ padding: '8px', textAlign: 'left' }}>الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                {sortedQuarries.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: '16px', textAlign: 'center' }} className="muted">
                      لا توجد محاجر مسجلة حالياً.
                    </td>
                  </tr>
                ) : (
                  sortedQuarries.map((q) => (
                    <tr key={q.id} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '10px 8px', fontWeight: 600 }}>{q.name}</td>
                      <td style={{ padding: '10px 8px' }}>{q.quarry_number || '-'}</td>
                      <td style={{ padding: '10px 8px' }}>{q.quarry_type || '-'}</td>
                      <td style={{ padding: '10px 8px' }}>
                        <span className={`badge ${q.status === 'active' ? 'success' : 'danger'}`}>
                          {q.status === 'active' ? 'نشط' : 'مؤرشف'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'left' }}>
                        <div className="row" style={{ gap: '6px', justifyContent: 'flex-start' }}>
                          <button
                            type="button"
                            className="button secondary"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                            onClick={() => handleStartEditQuarry(q)}
                          >
                            ✏ {t.editQuarry || 'تعديل'}
                          </button>
                          {q.status === 'active' ? (
                            <button
                              type="button"
                              className="button danger"
                              style={{ fontSize: '12px', padding: '4px 8px' }}
                              onClick={() => handleArchiveQuarry(q)}
                            >
                              📦 {t.archiveQuarry || 'أرشفة'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="button secondary"
                              style={{ fontSize: '12px', padding: '4px 8px' }}
                              onClick={() => handleReactivateQuarry(q)}
                            >
                              ↩ {t.unarchiveQuarry || 'إلغاء الأرشفة'}
                            </button>
                          )}
                          {isPlatformAdmin && (
                            <button
                              type="button"
                              className="button danger"
                              style={{ fontSize: '12px', padding: '4px 8px' }}
                              onClick={() => handlePermanentDeleteQuarry(q)}
                            >
                              {t.deleteQuarryPermanently || 'حذف نهائي'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Quarry Selector & Documents */}
      <div className="card mt-16">
        <div className="spread">
          <div>
            <h3>{t.documentsArchive}</h3>
            <p className="muted">{t.selectQuarryPrompt}</p>
          </div>
          <div className="row">
            <select
              value={selectedQuarryId}
              onChange={(e) => handleQuarryChange(e.target.value)}
              style={{ minWidth: '200px' }}
            >
              <option value="" disabled>
                {activeQuarries.length ? 'اختر محجراً نشطاً' : 'لا توجد محاجر نشطة'}
              </option>
              {activeQuarries.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>

            {folders.length > 0 && (
              <select
                value={selectedFolderId}
                onChange={(e) => handleFolderChange(e.target.value)}
                style={{ minWidth: '150px' }}
              >
                <option value="">-- جميع المجلدات --</option>
                {sortedFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    📁 {f.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Upload Form */}
        <form onSubmit={handleUpload} className="card sub-card mt-16">
          <h4>{t.uploadDocument}</h4>

          {uploadError && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px 12px',
                borderRadius: '6px',
                backgroundColor: '#fee2e2',
                color: '#991b1b',
                border: '1px solid #fecaca',
                fontSize: '13px',
              }}
            >
              ⚠️ {uploadError}
            </div>
          )}

          {uploadSuccess && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px 12px',
                borderRadius: '6px',
                backgroundColor: '#dcfce7',
                color: '#166534',
                border: '1px solid #bbf7d0',
                fontSize: '13px',
              }}
            >
              ✓ {uploadSuccess}
            </div>
          )}

          <div className="row mt-12">
            <input
              id="doc-file-input"
              type="file"
              onChange={(e) => {
                setUploadError('');
                setUploadFile(e.target.files?.[0] || null);
              }}
              required
              style={{ flex: 1 }}
            />
            <button
              type="submit"
              className="button primary"
              disabled={uploading || !uploadFile || !selectedQuarryId}
            >
              {uploading ? t.loading : t.uploadBtn}
            </button>
          </div>
        </form>

        {/* Documents Table */}
        <div className="table-responsive mt-16" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: '8px' }}>{t.documentName}</th>
                <th style={{ padding: '8px' }}>{t.size}</th>
                <th style={{ padding: '8px' }}>{t.version}</th>
                <th style={{ padding: '8px' }}>{t.date}</th>
                <th style={{ padding: '8px' }}>{t.actions}</th>
              </tr>
            </thead>
            <tbody>
              {loadingDocs ? (
                <tr>
                  <td colSpan={5} style={{ padding: '16px', textAlign: 'center' }} className="muted">
                    {t.loading}
                  </td>
                </tr>
              ) : documents.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: '16px', textAlign: 'center' }} className="muted">
                    {t.noDocuments}
                  </td>
                </tr>
              ) : (
                sortedDocuments.map((doc) => {
                  const docTitle = doc.display_name || doc.title || doc.original_filename || doc.file_name || 'مستند';
                  const docSize = doc.size_bytes !== undefined ? doc.size_bytes : (doc.file_size || 0);
                  const downloadName = doc.original_filename || doc.file_name || doc.display_name || doc.title || 'download';
                  return (
                    <tr key={doc.id} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '10px 8px', fontWeight: 600 }}>{docTitle}</td>
                      <td style={{ padding: '10px 8px' }}>{fmtBytes(docSize)}</td>
                      <td style={{ padding: '10px 8px' }}>
                        <span className="badge info">v{doc.version}</span>
                      </td>
                      <td style={{ padding: '10px 8px' }}>{formatDate(doc.created_at)}</td>
                      <td style={{ padding: '10px 8px' }}>
                        <div className="row" style={{ gap: '6px' }}>
                          <button
                            type="button"
                            className="button secondary"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                            onClick={() => handleStartRename(doc)}
                          >
                            ✏ {t.rename}
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                            onClick={() => ApiClient.downloadDocument(doc.id, downloadName)}
                          >
                            ⬇ {t.download}
                          </button>
                          <button
                            className="button danger"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                            onClick={() => handleDelete(doc.id)}
                          >
                            {t.deleteDoc}
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
      </div>

      {/* Edit Quarry Modal */}
      {editingQuarry && (
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
              maxWidth: '480px',
              width: '100%',
              padding: '24px',
              backgroundColor: 'var(--surface, #ffffff)',
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.25)',
              borderRadius: '8px',
            }}
          >
            <h3 style={{ marginTop: 0 }}>{t.editQuarryTitle || 'تعديل بيانات المحجر'}</h3>
            <form onSubmit={handleSaveEditQuarry} className="mt-16">
              <div className="field">
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '13px' }}>
                  اسم المحجر
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--line)' }}
                  autoFocus
                />
              </div>

              <div className="field mt-12">
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '13px' }}>
                  {t.quarryNumber || 'رقم المحجر'}
                </label>
                <input
                  type="text"
                  value={editNumber}
                  onChange={(e) => setEditNumber(e.target.value)}
                  placeholder="مثال: Q-200"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--line)' }}
                />
              </div>

              <div className="field mt-12">
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '13px' }}>
                  {t.quarryType || 'نوع الخام'}
                </label>
                <input
                  type="text"
                  value={editType}
                  onChange={(e) => setEditType(e.target.value)}
                  placeholder="مثال: بازلت / رخام"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--line)' }}
                />
              </div>

              <div className="row mt-20" style={{ justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setEditingQuarry(null)}
                  disabled={isEditingQuarry}
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={isEditingQuarry || !editName.trim()}
                >
                  {isEditingQuarry ? t.loading : t.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Rename Document Dialog */}
      {renamingDoc && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
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
              maxWidth: '480px',
              width: '100%',
              padding: '24px',
              backgroundColor: 'var(--surface, #ffffff)',
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.2)',
              borderRadius: '8px',
            }}
          >
            <h3 style={{ marginTop: 0 }}>{t.renameDoc}</h3>
            <p className="muted" style={{ fontSize: '13px', marginBottom: '16px' }}>
              {t.renameDocHelp}
            </p>

            {renameSuccess && (
              <div
                className="alert success mb-12"
                style={{
                  padding: '8px 12px',
                  backgroundColor: '#e6f4ea',
                  color: '#137333',
                  borderRadius: '4px',
                  fontSize: '13px',
                }}
              >
                ✓ {renameSuccess}
              </div>
            )}

            {renameError && (
              <div
                className="alert danger mb-12"
                style={{
                  padding: '8px 12px',
                  backgroundColor: '#fce8e6',
                  color: '#c5221f',
                  borderRadius: '4px',
                  fontSize: '13px',
                }}
              >
                {renameError}
              </div>
            )}

            <form onSubmit={handleRenameSubmit}>
              <div className="field">
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '13px' }}>
                  {t.newFilename}
                </label>
                <input
                  type="text"
                  value={renameInput}
                  onChange={(e) => {
                    setRenameInput(e.target.value);
                    setRenameError('');
                  }}
                  disabled={isRenaming || Boolean(renameSuccess)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '4px',
                    border: '1px solid var(--line, #ccc)',
                    fontSize: '14px',
                  }}
                  autoFocus
                  required
                />
              </div>

              <div className="row mt-16" style={{ justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setRenamingDoc(null);
                    setRenameInput('');
                    setRenameError('');
                    setRenameSuccess('');
                  }}
                  disabled={isRenaming}
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={isRenaming || !renameInput.trim() || Boolean(renameSuccess)}
                >
                  {isRenaming ? t.loading : t.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
