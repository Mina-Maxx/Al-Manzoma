import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { translations as t } from '../lib/i18n';
import { ApiClient, ApiError } from '../lib/api';

type AuthViewMode = 'login' | 'recover' | 'reset_token' | 'change_temp_password';

export default function LoginPage() {
  const router = useRouter();

  const [mode, setMode] = useState<AuthViewMode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Recovery state
  const [recoveryIdentifier, setRecoveryIdentifier] = useState('');
  const [devResetToken, setDevResetToken] = useState<string | null>(null);

  // Token reset state
  const [resetToken, setResetToken] = useState('');

  // Password fields
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [checkingExistingSession, setCheckingExistingSession] = useState(true);

  // Check if user already has an active valid session
  useEffect(() => {
    if (!router.isReady) return;
    if (router.query.error === 'session_expired') {
      setErrorMsg('انتهت صلاحية الجلسة. يرجى تسجيل الدخول مرة أخرى.');
    } else if (router.query.error === 'dashboard_access_denied') {
      setErrorMsg('هذه اللوحة مخصصة لمسؤولي المنصة فقط.');
    }

    const token = ApiClient.getToken();
    if (!token) {
      setCheckingExistingSession(false);
      return;
    }

    ApiClient.getMe()
      .then((me) => {
        if (me.role !== 'platform_admin') {
          ApiClient.setToken(null);
          ApiClient.setActiveCompanyId(null);
          setErrorMsg('هذه اللوحة مخصصة لمسؤولي المنصة فقط.');
          setCheckingExistingSession(false);
          return;
        }

        if (me.mustChangePassword) {
          setMode('change_temp_password');
          setCheckingExistingSession(false);
          return;
        }

        const defaultDest = '/';

        const returnUrl =
          typeof router.query.returnUrl === 'string' &&
          router.query.returnUrl.startsWith('/') &&
          !router.query.returnUrl.startsWith('//') &&
          router.query.returnUrl !== '/login'
            ? router.query.returnUrl
            : defaultDest;

        router.replace(returnUrl);
      })
      .catch(() => {
        // Stored token is invalid, expired, or revoked
        ApiClient.setToken(null);
        ApiClient.setActiveCompanyId(null);
        setErrorMsg('تعذر التحقق من الجلسة الحالية. يرجى تسجيل الدخول مرة أخرى.');
        setCheckingExistingSession(false);
      });
  }, [router.isReady]);

  // Sync token from URL query ?token=...
  useEffect(() => {
    if (router.isReady && typeof router.query.token === 'string' && router.query.token.trim()) {
      setResetToken(router.query.token.trim());
      setMode('reset_token');
    }
  }, [router.isReady, router.query.token]);

  const clearMessages = () => {
    setErrorMsg('');
    setSuccessMsg('');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    clearMessages();
    try {
      const res = await ApiClient.login({
        username: username.trim(),
        password,
      });

      if (res.user.role !== 'platform_admin') {
        ApiClient.setToken(null);
        ApiClient.setActiveCompanyId(null);
        setErrorMsg('هذه اللوحة مخصصة لمسؤولي المنصة فقط.');
        return;
      }

      ApiClient.setToken(res.token);

      if (res.user.mustChangePassword) {
        setMode('change_temp_password');
        setLoading(false);
        return;
      }

      const defaultDest = '/';

      const returnUrl =
        typeof router.query.returnUrl === 'string' &&
        router.query.returnUrl.startsWith('/') &&
        !router.query.returnUrl.startsWith('//') &&
        router.query.returnUrl !== '/login'
          ? router.query.returnUrl
          : defaultDest;
      router.push(returnUrl);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) {
        setErrorMsg('اسم المستخدم أو كلمة المرور غير صحيحة، أو أن الحساب غير نشط.');
      } else if (err instanceof ApiError && err.status === 403) {
        setErrorMsg('لوحة الإدارة مخصصة لمسؤولي المنصة النشطين فقط.');
      } else {
        setErrorMsg('تعذر إكمال تسجيل الدخول. تحقق من الاتصال ثم حاول مرة أخرى.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setErrorMsg('كلمتا المرور غير متطابقتين');
      return;
    }
    setLoading(true);
    clearMessages();
    try {
      await ApiClient.changePassword({
        currentPassword: password,
        newPassword,
      });
      alert('تم تحديث كلمة المرور بنجاح. يرجى تسجيل الدخول بكلمة المرور الجديدة.');
      ApiClient.setToken(null);
      setMode('login');
      setPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccessMsg('تم حفظ كلمة المرور الدائمة. يمكنك الآن تسجيل الدخول.');
    } catch (err: any) {
      setErrorMsg(err.message || 'فشل تحديث كلمة المرور');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recoveryIdentifier.trim()) {
      setErrorMsg('البريد الإلكتروني أو اسم المستخدم مطلوب');
      return;
    }
    setLoading(true);
    clearMessages();
    setDevResetToken(null);
    try {
      const res = await ApiClient.recoverPassword(recoveryIdentifier.trim());
      setSuccessMsg(res.detail || t.recoverySent);
      if (res.reset_token) {
        setDevResetToken(res.reset_token);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'فشل طلب إعادة تعيين كلمة المرور');
    } finally {
      setLoading(false);
    }
  };

  const handleResetWithToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetToken.trim()) {
      setErrorMsg('رمز إعادة التعيين مطلوب');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg('كلمتا المرور غير متطابقتين');
      return;
    }
    setLoading(true);
    clearMessages();
    try {
      const res = await ApiClient.resetPasswordWithToken(resetToken.trim(), newPassword);
      alert(res.detail || 'تم إعادة تعيين كلمة المرور بنجاح. يرجى تسجيل الدخول بكلمة المرور الجديدة.');
      setMode('login');
      setResetToken('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccessMsg('تمت إعادة تعيين كلمة المرور بنجاح. يرجى تسجيل الدخول.');
    } catch (err: any) {
      setErrorMsg(err.message || 'فشل إعادة تعيين كلمة المرور');
    } finally {
      setLoading(false);
    }
  };

  if (checkingExistingSession) {
    return (
      <div dir="rtl" className="app" style={{ maxWidth: '420px', marginTop: '120px', textAlign: 'center' }}>
        <p className="muted" style={{ fontSize: '16px' }}>{t.loading}</p>
      </div>
    );
  }

  return (
    <div dir="rtl" className="app" style={{ maxWidth: '420px', marginTop: '60px' }}>
      <Head>
        <title>تسجيل الدخول — المنظومة</title>
      </Head>

      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <h2 style={{ margin: 0, fontSize: '26px', color: 'var(--accent)' }}>المنظومة</h2>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: '14px' }}>نظام إدارة المستندات والمحاجر</p>
      </div>

      <div className="card">
        {errorMsg && (
          <div style={{ background: '#fee2e2', border: '1px solid #f87171', color: '#b91c1c', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '16px' }}>
            {errorMsg}
          </div>
        )}

        {successMsg && (
          <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', color: '#047857', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '16px' }}>
            {successMsg}
          </div>
        )}

        {/* 1. SIGN IN FORM */}
        {mode === 'login' && (
          <form onSubmit={handleLogin}>
            <h3>تسجيل الدخول</h3>

            <div style={{ marginTop: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 600 }}>
                {t.username}
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginTop: '16px' }}>
              <div className="spread">
                <label style={{ fontSize: '12px', marginBottom: '4px', fontWeight: 600 }}>
                  كلمة المرور
                </label>
                <button
                  type="button"
                  onClick={() => {
                    clearMessages();
                    setMode('recover');
                  }}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary, #2563eb)', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  {t.forgotPassword}
                </button>
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </div>

            <button
              type="submit"
              className="button primary"
              disabled={loading}
              style={{ width: '100%', marginTop: '20px' }}
            >
              {loading ? t.loading : 'تسجيل الدخول'}
            </button>
          </form>
        )}

        {/* 2. FORGOT PASSWORD / RECOVERY FORM */}
        {mode === 'recover' && (
          <form onSubmit={handleRequestRecovery}>
            <h3>{t.resetPasswordTitle}</h3>
            <p className="muted" style={{ fontSize: '13px' }}>
              أدخل بريدك الإلكتروني أو اسم المستخدم لتلقي تعليمات إعادة تعيين كلمة المرور.
            </p>

            <div style={{ marginTop: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 600 }}>
                {t.username} / {t.email}
              </label>
              <input
                type="text"
                placeholder="مثال: employee@company.com أو اسم المستخدم"
                value={recoveryIdentifier}
                onChange={(e) => setRecoveryIdentifier(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </div>

            {devResetToken && (
              <div style={{ marginTop: '12px', padding: '8px 10px', background: '#f1f5f9', border: '1px dashed #cbd5e1', borderRadius: '4px', fontSize: '12px' }}>
                <span style={{ fontWeight: 600 }}>رمز الاختبار: </span>
                <code style={{ wordBreak: 'break-all' }}>{devResetToken}</code>
                <div style={{ marginTop: '6px' }}>
                  <button
                    type="button"
                    className="button secondary"
                    style={{ fontSize: '11px', padding: '2px 8px' }}
                    onClick={() => {
                      setResetToken(devResetToken);
                      setMode('reset_token');
                    }}
                  >
                    المتابعة باستخدام الرمز &larr;
                  </button>
                </div>
              </div>
            )}

            <button
              type="submit"
              className="button primary"
              disabled={loading}
              style={{ width: '100%', marginTop: '20px' }}
            >
              {loading ? t.loading : t.sendRecoveryLink}
            </button>

            <div style={{ textAlign: 'center', marginTop: '16px' }}>
              <button
                type="button"
                onClick={() => {
                  clearMessages();
                  setMode('login');
                }}
                style={{ background: 'none', border: 'none', color: 'var(--primary, #2563eb)', fontSize: '13px', cursor: 'pointer', textDecoration: 'underline' }}
              >
                {t.backToLogin} &rarr;
              </button>
            </div>
          </form>
        )}

        {/* 3. RESET PASSWORD WITH TOKEN */}
        {mode === 'reset_token' && (
          <form onSubmit={handleResetWithToken}>
            <h3>{t.resetPasswordTitle}</h3>
            <p className="muted" style={{ fontSize: '13px' }}>
              أدخل رمز إعادة التعيين واختر كلمة مرور جديدة وآمنة.
            </p>

            <div style={{ marginTop: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 600 }}>
                رمز إعادة التعيين
              </label>
              <input
                type="text"
                placeholder="أدخل الرمز المكون من 64 حرفاً"
                value={resetToken}
                onChange={(e) => setResetToken(e.target.value)}
                required
                style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }}
              />
            </div>

            <div style={{ marginTop: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 600 }}>
                {t.newPassword}
              </label>
              <input
                type="password"
                placeholder={t.initialPasswordPlaceholder}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                style={{ width: '100%' }}
              />
              <span className="muted" style={{ fontSize: '11px' }}>
                {t.passwordRequirements}
              </span>
            </div>

            <div style={{ marginTop: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 600 }}>
                {t.confirmPassword}
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </div>

            <button
              type="submit"
              className="button primary"
              disabled={loading}
              style={{ width: '100%', marginTop: '20px' }}
            >
              {loading ? t.loading : t.enterNewPassword}
            </button>

            <div style={{ textAlign: 'center', marginTop: '16px' }}>
              <button
                type="button"
                onClick={() => {
                  clearMessages();
                  setMode('login');
                }}
                style={{ background: 'none', border: 'none', color: 'var(--primary, #2563eb)', fontSize: '13px', cursor: 'pointer', textDecoration: 'underline' }}
              >
                {t.backToLogin} &rarr;
              </button>
            </div>
          </form>
        )}

        {/* 4. CHANGE TEMPORARY PASSWORD ON FIRST LOGIN */}
        {mode === 'change_temp_password' && (
          <form onSubmit={handlePasswordChange}>
            <h3>{t.passwordResetPending}</h3>
            <p className="muted" style={{ fontSize: '13px' }}>
              {t.mustChangePasswordNotice}
            </p>

            <div style={{ marginTop: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 600 }}>
                {t.newPassword}
              </label>
              <input
                type="password"
                placeholder={t.initialPasswordPlaceholder}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                style={{ width: '100%' }}
              />
              <span className="muted" style={{ fontSize: '11px' }}>
                {t.passwordRequirements}
              </span>
            </div>

            <div style={{ marginTop: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 600 }}>
                {t.confirmPassword}
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </div>

            <button
              type="submit"
              className="button primary"
              disabled={loading}
              style={{ width: '100%', marginTop: '20px' }}
            >
              {loading ? t.loading : t.confirmReset}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
