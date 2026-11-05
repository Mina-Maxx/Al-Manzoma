import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { ApiClient, ApiError } from '../lib/api';
import { translations as t, fmtBytes } from '../lib/i18n';
import {
  UserSession,
  PlatformOverviewData,
  Company,
  UserAccount,
  Quarry,
  EmployeePermission,
  AppRelease,
  OperationalAlert,
} from '../lib/types';
import { Header } from '../components/Header';
import { Tabs } from '../components/Tabs';
import { PlatformOverview } from '../components/PlatformOverview';
import { CompanyList } from '../components/CompanyList';
import { UserDirectory } from '../components/UserDirectory';
import { QuarriesManagement } from '../components/QuarriesManagement';
import { TrashRecovery } from '../components/TrashRecovery';
import { EmployeeMatrix } from '../components/EmployeeMatrix';
import { AppReleases } from '../components/AppReleases';
import { BackupRecovery } from '../components/BackupRecovery';
import { AuditCenter } from '../components/AuditCenter';
import { AlertsView } from '../components/AlertsView';

function safeApiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'تعذر الاتصال بالخادم. تحقق من الاتصال ثم حاول مرة أخرى.';
  if (error.status === 401) return 'انتهت صلاحية الجلسة. يرجى تسجيل الدخول مرة أخرى.';
  if (error.status === 403) return 'تم التحقق من الحساب، لكن ليست لديك صلاحية لتنفيذ هذا الإجراء.';
  if (error.status === 404) return 'المورد المطلوب غير موجود أو لم يعد متاحاً.';
  if (error.status >= 500) return `تعذر إكمال الطلب بسبب خطأ في الخادم (HTTP ${error.status}).`;
  return `تعذر إكمال الطلب (HTTP ${error.status}).`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<UserSession | null>(null);
  const [currentView, setCurrentView] = useState<'platform' | 'company'>('platform');
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [activeCompany, setActiveCompany] = useState<Company | null>(null);
  const [platformError, setPlatformError] = useState('');
  const [companyError, setCompanyError] = useState('');
  const [authError, setAuthError] = useState('');

  // Platform Data
  const [platformOverview, setPlatformOverview] = useState<PlatformOverviewData | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [releases, setReleases] = useState<AppRelease[]>([]);
  const [alerts, setAlerts] = useState<OperationalAlert[]>([]);
  const [alertsCheckedAt, setAlertsCheckedAt] = useState<string | null>(null);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState('');
  const [loadingPlatform, setLoadingPlatform] = useState(false);

  // Company Data
  const [companyUsage, setCompanyUsage] = useState<{ used_bytes: number; quota_bytes: number; percent: number } | null>(null);
  const [companyQuarries, setCompanyQuarries] = useState<Quarry[]>([]);
  const [companyEmployees, setCompanyEmployees] = useState<UserAccount[]>([]);
  const [companyPermissions, setCompanyPermissions] = useState<EmployeePermission[]>([]);
  const [, setLoadingCompany] = useState(false);

  // Auth verification & route parameter restoration
  useEffect(() => {
    if (!router.isReady) return;
    const token = ApiClient.getToken();
    if (!token) {
      const returnUrl = router.asPath !== '/login' ? router.asPath : '/';
      router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
      return;
    }

    ApiClient.getMe()
      .then((me) => {
        if (me.role !== 'platform_admin') {
          ApiClient.setToken(null);
          ApiClient.setActiveCompanyId(null);
          router.replace('/login?error=dashboard_access_denied');
          return;
        }

        let restoredView: 'platform' | 'company' = 'platform';
        let restoredTab = 'overview';

        if (router.isReady) {
          const qView = router.query.view as string | undefined;
          const qTab = router.query.tab as string | undefined;
          const qCompanyId = router.query.companyId as string | undefined;

          if (qView === 'company' || qView === 'platform') {
            restoredView = qView;
          }

          if (qTab) {
            restoredTab = qTab;
          }

          if (qCompanyId) {
            ApiClient.setActiveCompanyId(qCompanyId);
          }
        }

        setSession({
          token,
          user: {
            id: me.id,
            username: me.username,
            email: me.email,
            role: 'platform',
            companyId: me.companyId,
            isSuperAdmin: true,
          },
        });
        setCurrentView(restoredView);
        setActiveTab(restoredTab);
      })
      .catch((err) => {
        console.error('Auth verification failed:', err);
        if (err instanceof ApiError && err.status === 401) {
          ApiClient.setToken(null);
          ApiClient.setActiveCompanyId(null);
          router.replace('/login?error=session_expired');
        } else if (err instanceof ApiError && err.status === 403) {
          ApiClient.setToken(null);
          ApiClient.setActiveCompanyId(null);
          router.replace('/login?error=dashboard_access_denied');
        } else {
          setAuthError(safeApiErrorMessage(err));
        }
      });
  }, [router.isReady]);

  // Sync state to URL query parameters shallowly to preserve state across page refreshes
  useEffect(() => {
    if (!session || !router.isReady) return;
    const query: Record<string, any> = { ...router.query };
    if (currentView) query.view = currentView;
    if (activeTab) query.tab = activeTab;
    const cid = activeCompany?.id || ApiClient.getActiveCompanyId();
    if (cid && currentView === 'company') {
      query.companyId = cid;
    } else if (currentView !== 'company') {
      delete query.companyId;
    }

    router.replace({ pathname: '/', query }, undefined, { shallow: true });
  }, [session, currentView, activeTab, activeCompany?.id, router.isReady]);

  const loadAlerts = async () => {
    setAlertsLoading(true);
    setAlertsError('');
    try {
      const snapshot = await ApiClient.getAlerts();
      setAlerts(snapshot.items || []);
      setAlertsCheckedAt(snapshot.checked_at || null);
    } catch {
      setAlertsError(t.monitoringLoadError);
    } finally {
      setAlertsLoading(false);
    }
  };

  // Load Platform Data
  const loadPlatformData = async () => {
    setLoadingPlatform(true);
    setPlatformError('');
    setPlatformOverview(null);
    setCompanies([]);
    setUsers([]);
    setReleases([]);
    void loadAlerts();
    try {
      const [overview, compList, userList, relList] = await Promise.all([
        ApiClient.getPlatformOverview(),
        ApiClient.getPlatformCompanies(),
        ApiClient.getPlatformUsers(),
        ApiClient.getReleases(),
      ]);
      setPlatformOverview(overview);
      setCompanies(compList);
      setUsers(userList);
      setReleases(relList);

      if (compList.length > 0 && !activeCompany) {
        const targetId = (router.query.companyId as string) || ApiClient.getActiveCompanyId();
        if (targetId) {
          const match = compList.find((c) => c.id === targetId);
          if (match) setActiveCompany(match);
        }
      }
    } catch (err) {
      console.error(err);
      setPlatformError(safeApiErrorMessage(err));
      if (err instanceof ApiError && err.status === 401) {
        ApiClient.setToken(null);
        ApiClient.setActiveCompanyId(null);
        setSession(null);
        router.replace('/login?error=session_expired');
      }
    } finally {
      setLoadingPlatform(false);
    }
  };

  // Load Company Data
  const loadCompanyData = async () => {
    setLoadingCompany(true);
    setCompanyError('');
    setCompanyUsage(null);
    setCompanyQuarries([]);
    setCompanyEmployees([]);
    setCompanyPermissions([]);
    try {
      const companyId = activeCompany?.id ||
        (typeof router.query.companyId === 'string' ? router.query.companyId : null) ||
        ApiClient.getActiveCompanyId();
      if (!companyId) {
        setCompanyError('اختر شركة من قائمة الشركات قبل فتح بياناتها.');
        return;
      }

      let selectedCompany = activeCompany?.id === companyId ? activeCompany : null;
      if (!selectedCompany) {
        const companyList = companies.length > 0 ? companies : await ApiClient.getPlatformCompanies();
        selectedCompany = companyList.find((company) => company.id === companyId) || null;
        if (!selectedCompany) throw new ApiError(404, 'Selected company was not found');
        setActiveCompany(selectedCompany);
      }
      ApiClient.setActiveCompanyId(selectedCompany.id);

      const [usage, quarries, employees, perms] = await Promise.all([
        ApiClient.getCompanyUsage(),
        ApiClient.getCompanyQuarries(),
        ApiClient.getCompanyEmployees(),
        ApiClient.getCompanyPermissions(),
      ]);
      setCompanyUsage(usage);
      setCompanyQuarries(quarries);
      setCompanyEmployees(employees);
      setCompanyPermissions(perms);
    } catch (err) {
      console.error(err);
      setCompanyError(safeApiErrorMessage(err));
      if (err instanceof ApiError && err.status === 401) {
        ApiClient.setToken(null);
        ApiClient.setActiveCompanyId(null);
        setSession(null);
        router.replace('/login?error=session_expired');
      }
    } finally {
      setLoadingCompany(false);
    }
  };

  useEffect(() => {
    if (!session) return;
    if (currentView === 'platform') {
      loadPlatformData();
    } else {
      loadCompanyData();
    }
  }, [session, currentView]);

  const handleSelectCompanyFromPlatform = (comp: Company) => {
    ApiClient.setActiveCompanyId(comp.id);
    setActiveCompany(comp);
    setCurrentView('company');
    setActiveTab('overview');
    setCompanyError('');
  };

  const handleSwitchView = (view: 'platform' | 'company') => {
    if (view === 'platform') {
      ApiClient.setActiveCompanyId(null);
      setActiveCompany(null);
    }
    setCurrentView(view);
    setActiveTab('overview');
  };

  const handleSignOut = async () => {
    try {
      await ApiClient.logout();
    } catch (err) {
      console.warn('Server-side logout did not complete. Clearing local credentials.', err);
    } finally {
      ApiClient.setToken(null);
      ApiClient.setActiveCompanyId(null);
      setSession(null);
      router.push('/login');
    }
  };

  if (!session) {
    return (
      <div className="app" style={{ textAlign: 'center', marginTop: '100px' }}>
        <p className="muted">{authError || t.loading}</p>
        {authError && <button className="button secondary" onClick={() => window.location.reload()}>إعادة المحاولة</button>}
      </div>
    );
  }

  return (
    <div dir="rtl" className="app">
      <Head>
        <title>
          {currentView === 'platform' ? 'إدارة المنصة المركزية' : 'إدارة المكتب'} — المنظومة
        </title>
      </Head>

      <Header
        session={session}
        currentView={currentView}
        activeCompanyName={activeCompany?.name}
        onSwitchView={handleSwitchView}
        onSignOut={handleSignOut}
      />

      <Tabs
        view={currentView}
        activeTab={activeTab}
        onSelectTab={(tab) => setActiveTab(tab)}
      />

      <main style={{ marginTop: '20px' }}>
        {(currentView === 'platform' ? platformError : companyError) && (
          <div role="alert" style={{ marginBottom: '16px', padding: '12px 14px', borderRadius: '6px', border: '1px solid #fca5a5', background: '#fef2f2', color: '#991b1b' }}>
            {currentView === 'platform' ? platformError : companyError}
          </div>
        )}
        {currentView === 'platform' && (
          <>
            {activeTab === 'overview' && (
              <PlatformOverview
                data={platformOverview}
                loading={loadingPlatform}
                onRefresh={loadPlatformData}
              />
            )}
            {activeTab === 'offices' && (
              <CompanyList
                companies={companies}
                onRefresh={loadPlatformData}
                onSelectCompany={handleSelectCompanyFromPlatform}
              />
            )}
            {activeTab === 'users' && (
              <UserDirectory
                users={users}
                companies={companies}
                onRefresh={loadPlatformData}
              />
            )}
            {activeTab === 'releases' && (
              <AppReleases
                releases={releases}
                onRefresh={loadPlatformData}
              />
            )}
            {activeTab === 'backup' && <BackupRecovery session={session} />}
            {activeTab === 'audit' && <AuditCenter />}
            {activeTab === 'alerts' && (
              <AlertsView
                alerts={alerts}
                checkedAt={alertsCheckedAt}
                loading={alertsLoading}
                error={alertsError}
                onRefresh={() => { void loadAlerts(); }}
              />
            )}
          </>
        )}

        {currentView === 'company' && (
          <>
            {activeTab === 'overview' && (
              <div>
                <div className="card storage-card">
                  <div className="spread">
                    <div>
                      <h3>{t.storageUsage}</h3>
                      <p className="muted">
                        {fmtBytes(companyUsage?.used_bytes || 0)} / {fmtBytes(companyUsage?.quota_bytes || 5 * 1024 * 1024 * 1024)} (
                        {companyUsage?.percent || 0}%)
                      </p>
                    </div>
                    <span
                      className={`badge ${
                        (companyUsage?.percent || 0) > 90
                          ? 'danger'
                          : (companyUsage?.percent || 0) > 75
                          ? 'warning'
                          : 'success'
                      }`}
                    >
                      {companyUsage?.percent || 0}%
                    </span>
                  </div>
                  <progress
                    className={`meter-bar ${
                      (companyUsage?.percent || 0) > 90
                        ? 'danger'
                        : (companyUsage?.percent || 0) > 75
                        ? 'warning'
                        : ''
                    }`}
                    value={companyUsage?.used_bytes || 0}
                    max={companyUsage?.quota_bytes || 5 * 1024 * 1024 * 1024}
                  />
                </div>

                <div className="card mt-16">
                  <h3>إحصائيات سريعة للمكتب</h3>
                  <div className="row mt-12" style={{ gap: '24px' }}>
                    <div>
                      <span className="muted">{t.totalQuarries}: </span>
                      <strong>{companyQuarries.length}</strong>
                    </div>
                    <div>
                      <span className="muted">{t.employees}: </span>
                      <strong>{companyEmployees.length}</strong>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'quarries' && (
              <QuarriesManagement
                quarries={companyQuarries}
                onRefreshQuarries={loadCompanyData}
                isPlatformAdmin={Boolean(session?.user.isSuperAdmin)}
              />
            )}

            {activeTab === 'trash' && (
              <TrashRecovery
                quarries={companyQuarries}
              />
            )}

            {activeTab === 'employees' && (
              <EmployeeMatrix
                employees={companyEmployees}
                quarries={companyQuarries}
                permissions={companyPermissions}
                onRefresh={loadCompanyData}
              />
            )}

            {activeTab === 'audit' && (
              <AuditCenter
                companyId={activeCompany?.id || ApiClient.getActiveCompanyId() || undefined}
                companyName={activeCompany?.name}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
