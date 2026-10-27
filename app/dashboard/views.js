// Pure, DOM-free view helpers for the dashboard.
//
// Everything that renders user-supplied data (company / quarry / employee names
// and emails, document names) goes through `esc()` and is inserted with
// textContent-equivalent strict escaping — never as raw HTML. Keeping these
// functions pure lets the test suite prove the escaping without a browser or jsdom.

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(n);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const I18N = {
  en: {
    platformTitle: "Platform Administration",
    platformSubtitle: "Global multi-tenant governance, telemetry & operations",
    companyTitle: "Office Administration",
    signedInAs: "Signed in as",
    signOut: "Sign Out",
    switchLang: "العربية",
    switchToCompany: "Office View",
    switchToPlatform: "Platform Admin",
    viewCompanyData: "Access Office Data",
    viewingAsSuperAdmin: "Viewing office: {name} with Platform Admin authority.",
    returnToPlatform: "Exit to Platform Admin",

    // Tabs
    tabOverview: "Overview",
    tabOffices: "Offices & Tenants",
    tabUsers: "User Directory",
    tabQuarries: "Quarries & Documents",
    tabTrash: "Trash & Recovery",
    tabEmployees: "Employees & Matrix",
    tabAudit: "Audit Center",
    tabAlerts: "Operational Alerts",
    tabExport: "Data Export",

    // Platform Overview KPIs
    totalOffices: "Total Offices",
    activeOffices: "Active Offices",
    suspendedOffices: "Suspended Offices",
    totalUsers: "Total Users",
    activeUsers: "Active Users",
    totalQuarries: "Total Quarries",
    activeDocs: "Active Documents",
    trashDocs: "In Trash",
    storageUsage: "Storage Usage & Quota",
    storageUtilization: "Storage Utilization",
    backendHealth: "Backend API",
    databaseHealth: "Database",
    storageHealth: "Document Storage",
    storageBackend: "Storage Provider",
    telemetryTitle: "30-Day Activity Telemetry",
    uploadsCount: "Uploads",
    downloadsCount: "Downloads",
    deletionsCount: "Deletions",
    restorationsCount: "Restorations",
    failuresCount: "Failures / Denials",

    // Office Management
    createCompany: "Create Office / Company",
    companyName: "Office / Company Name",
    quotaBytes: "Storage Quota (bytes)",
    maxUsers: "Max Users",
    create: "Create",
    companies: "Offices & Companies",
    name: "Name",
    status: "Status",
    users: "Users",
    usage: "Usage",
    suspend: "Suspend",
    reactivate: "Reactivate",
    noCompanies: "No offices registered yet.",
    searchOffices: "Filter offices by name...",

    // Global Users
    globalUsersTitle: "Global User Accounts",
    searchUsers: "Search users by email or name...",
    allStatuses: "All Statuses",
    active: "Active",
    disabled: "Disabled",
    office: "Office / Company",
    role: "Role",
    noUsers: "No user accounts found.",

    // Audit Center
    auditCenterTitle: "Security & Operations Audit Trail",
    allActions: "All Actions",
    allResults: "All Results",
    success: "Success",
    failure: "Failure",
    searchAudit: "Search action, target, actor, or office...",
    timestamp: "Timestamp",
    action: "Action",
    result: "Result",
    actor: "Actor",
    target: "Target",
    ip: "IP Address",
    prevPage: "Previous",
    nextPage: "Next",
    page: "Page",
    noAuditLogs: "No audit events found.",

    // Alerts
    operationalAlertsTitle: "Active Operational Alerts",
    noAlerts: "All systems healthy. No active alerts.",
    critical: "Critical",
    warning: "Warning",
    info: "Info",

    // Export
    exportTitle: "Data Export Center",
    exportDesc: "Download RFC-4180 CSV exports. All exports are formula-injection sanitized for spreadsheet security.",
    exportOffices: "Export Offices (CSV)",
    exportUsers: "Export Global Users (CSV)",
    exportAudit: "Export Audit Trail (CSV)",
    exportEmployees: "Export Employees (CSV)",
    exportQuarries: "Export Quarries (CSV)",
    exportDocuments: "Export Documents (CSV)",

    // Company Admin
    inviteEmployee: "Invite Employee",
    emailPlaceholder: "employee@example.com",
    fullNamePlaceholder: "Full name (optional)",
    sendInvite: "Send Invitation",
    createQuarry: "Create Quarry",
    quarryNamePlaceholder: "e.g. North Granite Pit",
    employees: "Employees",
    email: "Email",
    fullName: "Full Name",
    actions: "Actions",
    disable: "Disable",
    enable: "Enable",
    noEmployees: "No employees added yet.",
    quarries: "Quarries",
    rename: "Rename",
    deactivate: "Deactivate",
    noQuarries: "No quarries created yet.",
    permissionsMatrix: "Permissions Matrix",
    permissionsDesc: "Manage View, Upload, and Download access per employee and quarry.",
    savePermission: "Save Permission",
    view: "View",
    upload: "Upload",
    download: "Download",
    viewDocs: "Browse Documents",
    documentsArchive: "Quarry Documents Archive",
    selectQuarryPrompt: "Select a quarry to browse its documents:",
    noDocuments: "No documents uploaded to this quarry yet.",
    documentName: "Document Name",
    size: "Size",
    version: "Version",
    date: "Date",
    uploadDocument: "Upload Document to Quarry",
    selectFile: "Choose file",
    uploadBtn: "Upload File",
    deleteDoc: "Move to Trash",
    confirmDelete: "Move this document to trash?",

    // Trash & Recovery
    trashTitle: "Soft-Deleted Documents (Trash)",
    trashSubtitle: "Deleted documents are retained for 30 days before permanent purging. You can restore them below.",
    restore: "Restore",
    restoring: "Restoring...",
    noTrash: "Trash is empty. No deleted documents.",
    deletedAt: "Deleted At",
    retentionExpires: "Purge Date",
    confirmRestore: "Restore this document back to active status?"
  },
  ar: {
    platformTitle: "إدارة المنصة المركزية",
    platformSubtitle: "إدارة المكاتب المتعددة، المراقبة التشغيلية، وسجل الأمان الشامل",
    companyTitle: "إدارة المكتب",
    signedInAs: "مسجل الدخول كـ",
    signOut: "تسجيل الخروج",
    switchLang: "English",
    switchToCompany: "لوحة تحكم المكتب",
    switchToPlatform: "لوحة تحكم المنصة",
    viewCompanyData: "دخول وتصفح بيانات المكتب",
    viewingAsSuperAdmin: "أنت تتصفح حالياً مكتب: {name} بصلاحيات مدير المنصة.",
    returnToPlatform: "العودة إلى إدارة المنصة",

    // Tabs
    tabOverview: "نظرة عامة",
    tabOffices: "المكاتب والشركات",
    tabUsers: "دليل المستخدمين",
    tabQuarries: "المحاجر والمستندات",
    tabTrash: "سلة المهملات والاستعادة",
    tabEmployees: "الموظفون والصلاحيات",
    tabAudit: "سجل العمليات والرقابة",
    tabAlerts: "التنبيهات التشغيلية",
    tabExport: "تصدير البيانات",

    // Platform Overview KPIs
    totalOffices: "إجمالي المكاتب",
    activeOffices: "المكاتب النشطة",
    suspendedOffices: "المكاتب المعلقة",
    totalUsers: "إجمالي الحسابات",
    activeUsers: "المستخدمين النشطين",
    totalQuarries: "إجمالي المحاجر",
    activeDocs: "المستندات النشطة",
    trashDocs: "في سلة المهملات",
    storageUsage: "سعة واستهلاك التخزين",
    storageUtilization: "نسبة استهلاك السعة",
    backendHealth: "خادم الـ Backend",
    databaseHealth: "قاعدة البيانات PostgreSQL",
    storageHealth: "تخزين الملفات",
    storageBackend: "مزود التخزين النشط",
    telemetryTitle: "إحصائيات العمليات (آخر 30 يوماً)",
    uploadsCount: "عمليات الرفع",
    downloadsCount: "عمليات التحميل",
    deletionsCount: "عمليات الحذف",
    restorationsCount: "عمليات الاستعادة",
    failuresCount: "العمليات المرفوضة/الفاشلة",

    // Office Management
    createCompany: "إنشاء مكتب / شركة جديدة",
    companyName: "اسم المكتب / الشركة",
    quotaBytes: "سعة التخزين (بايت)",
    maxUsers: "الحد الأقصى للمستخدمين",
    create: "إنشاء",
    companies: "المكاتب والشركات",
    name: "الاسم",
    status: "الحالة",
    users: "المستخدمين",
    usage: "الاستهلاك",
    suspend: "تعليق المكتب",
    reactivate: "إعادة التفعيل",
    noCompanies: "لا توجد مكاتب مسجلة حتى الآن.",
    searchOffices: "بحث بالاسم...",

    // Global Users
    globalUsersTitle: "جميع حسابات المستخدمين بالمنصة",
    searchUsers: "بحث بالبريد الإلكتروني أو الاسم...",
    allStatuses: "جميع الحالات",
    active: "نشط",
    disabled: "معطل",
    office: "المكتب / الشركة",
    role: "الدور",
    noUsers: "لا توجد حسابات مستخدمين مطابقة.",

    // Audit Center
    auditCenterTitle: "مركز الرقابة وسجلات الأمان الشاملة",
    allActions: "جميع الإجراءات",
    allResults: "جميع النتائج",
    success: "ناجحة",
    failure: "فاشلة / مرفوضة",
    searchAudit: "بحث في الإجراء، الفاعل، الهدف، أو المكتب...",
    timestamp: "الوقت والتاريخ",
    action: "الإجراء",
    result: "النتيجة",
    actor: "الفاعل",
    target: "الهدف",
    ip: "عنوان IP",
    prevPage: "السابق",
    nextPage: "التالي",
    page: "صفحة",
    noAuditLogs: "لا توجد سجلات مطابقة.",

    // Alerts
    operationalAlertsTitle: "التنبيهات التشغيلية النشطة",
    noAlerts: "جميع الأنظمة تعمل بكفاءة تامة. لا توجد تنبيهات.",
    critical: "حرج",
    warning: "تحذير",
    info: "معلومة",

    // Export
    exportTitle: "مركز تصدير التقارير والبيانات",
    exportDesc: "تنزيل ملفات CSV متوافقة مع معايير الأمان ومحمية من ثغرات حقن المعادلات.",
    exportOffices: "تصدير المكاتب (CSV)",
    exportUsers: "تصدير جميع المستخدمين (CSV)",
    exportAudit: "تصدير سجل العمليات (CSV)",
    exportEmployees: "تصدير موظفي المكتب (CSV)",
    exportQuarries: "تصدير المحاجر (CSV)",
    exportDocuments: "تصدير أرشيف المستندات (CSV)",

    // Company Admin
    inviteEmployee: "دعوة موظف جديد",
    emailPlaceholder: "employee@example.com",
    fullNamePlaceholder: "الاسم الكامل (اختياري)",
    sendInvite: "إرسال الدعوة",
    createQuarry: "إنشاء محجر جديد",
    quarryNamePlaceholder: "مثال: محجر الجرانيت الشمالي",
    employees: "الموظفون",
    email: "البريد الإلكتروني",
    fullName: "الاسم الكامل",
    actions: "الإجراءات",
    disable: "تعطيل",
    enable: "تفعيل",
    noEmployees: "لا يوجد موظفون مضافون بعد.",
    quarries: "المحاجر",
    rename: "إعادة تسمية",
    deactivate: "إلغاء التفعيل",
    noQuarries: "لا توجد محاجر مسجلة بعد.",
    permissionsMatrix: "مصفوفة صلاحيات الوصول",
    permissionsDesc: "إدارة صلاحيات العرض والرفع والتحميل لكل موظف على كل محجر.",
    savePermission: "حفظ الصلاحية",
    view: "عرض",
    upload: "رفع",
    download: "تحميل",
    viewDocs: "تصفح المستندات",
    documentsArchive: "أرشيف مستندات المحجر",
    selectQuarryPrompt: "اختر محجراً لتصفح مستنداته:",
    noDocuments: "لا توجد مستندات مرفوعة في هذا المحجر بعد.",
    documentName: "اسم المستند",
    size: "الحجم",
    version: "الإصدار",
    date: "التاريخ",
    uploadDocument: "رفع مستند جديد إلى المحجر",
    selectFile: "اختر ملفاً",
    uploadBtn: "رفع المستند",
    deleteDoc: "نقل إلى السلة",
    confirmDelete: "هل أنت متأكد من نقل هذا المستند إلى سلة المهملات؟",

    // Trash & Recovery
    trashTitle: "سلة المهملات واستعادة المستندات",
    trashSubtitle: "يتم الاحتفاظ بالمستندات المحذوفة لمدة 30 يوماً قبل الحذف التلقائي النهائي. يمكنك استعادتها هنا.",
    restore: "استعادة",
    restoring: "جارٍ الاستعادة...",
    noTrash: "سلة المهملات فارغة. لا توجد مستندات محذوفة.",
    deletedAt: "تاريخ الحذف",
    retentionExpires: "تاريخ الحذف النهائي",
    confirmRestore: "هل تريد استعادة هذا المستند وإعادته إلى قائمة المستندات النشطة؟"
  }
};

function layout(title, subtitle, body, lang = "en", extraHeader = "", banner = "") {
  const isAr = lang === "ar";
  const t = I18N[lang] || I18N.en;
  return `
    <div class="dashboard-shell" dir="${isAr ? "rtl" : "ltr"}">
      ${banner}
      <header class="spread header-bar">
        <div>
          <h1>${esc(title)}</h1>
          <div class="muted">${esc(subtitle || "")}</div>
        </div>
        <div class="row">
          ${extraHeader}
          <button class="secondary" id="lang-toggle" type="button">${esc(t.switchLang)}</button>
          <button class="secondary" id="signout" type="button">${esc(t.signOut)}</button>
        </div>
      </header>
      <main class="dashboard-content">
        ${body}
      </main>
    </div>
  `;
}

function renderTabs(tabs, activeTab) {
  return `
    <nav class="nav-tabs">
      ${tabs
        .map(
          (t) => `
        <button class="tab-btn ${t.id === activeTab ? "active" : ""}" data-tab="${esc(t.id)}" type="button">
          ${esc(t.label)}
        </button>`
        )
        .join("")}
    </nav>
  `;
}

export function platformView(data, opts = {}) {
  const lang = opts.lang || "en";
  const t = I18N[lang] || I18N.en;
  const activeTab = opts.activeTab || "overview";
  const companies = data.companies || [];
  const overview = data.overview || {};
  const users = data.users || [];
  const audit = data.audit || { total: 0, items: [] };
  const alerts = data.alerts || [];

  const switchBtn = opts.canSwitchRole
    ? `<button class="secondary" id="view-toggle" type="button">${esc(t.switchToCompany)}</button>`
    : "";

  const tabs = [
    { id: "overview", label: t.tabOverview },
    { id: "offices", label: t.tabOffices },
    { id: "users", label: t.tabUsers },
    { id: "audit", label: t.tabAudit },
    { id: "alerts", label: `${t.tabAlerts}${alerts.length > 0 ? ` (${alerts.length})` : ""}` },
    { id: "export", label: t.tabExport }
  ];

  let tabContent = "";

  // 1. OVERVIEW TAB
  if (activeTab === "overview") {
    const usedBytes = overview.total_used_bytes || 0;
    const quotaBytes = overview.total_quota_bytes || 1;
    const utilPct = overview.storage_utilization_pct || 0;

    tabContent = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-title">${esc(t.totalOffices)}</div>
          <div class="kpi-value">${Number(overview.total_offices || 0)}</div>
          <div class="kpi-sub">${Number(overview.active_offices || 0)} ${esc(t.active)} / ${Number(overview.suspended_offices || 0)} ${esc(t.suspended)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">${esc(t.totalUsers)}</div>
          <div class="kpi-value">${Number(overview.total_users || 0)}</div>
          <div class="kpi-sub">${Number(overview.active_users || 0)} ${esc(t.active)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">${esc(t.totalQuarries)}</div>
          <div class="kpi-value">${Number(overview.total_quarries || 0)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">${esc(t.activeDocs)}</div>
          <div class="kpi-value">${Number(overview.active_documents || 0)}</div>
          <div class="kpi-sub">${Number(overview.trash_documents || 0)} ${esc(t.trashDocs)}</div>
        </div>
      </div>

      <!-- Platform Storage Card -->
      <div class="card storage-card">
        <div class="spread">
          <div>
            <h3>${esc(t.totalStorage)}</h3>
            <div class="muted">${esc(fmtBytes(usedBytes))} / ${esc(fmtBytes(quotaBytes))} (${utilPct}%)</div>
          </div>
        </div>
        <progress class="meter-bar ${utilPct > 90 ? "danger" : utilPct > 75 ? "warning" : ""}" value="${utilPct}" max="100"></progress>
      </div>

      <!-- System Health Grid -->
      <div class="health-grid">
        <div class="health-card">
          <div>
            <div class="kpi-title">${esc(t.backendHealth)}</div>
            <div class="health-status-ok">● ${esc(overview.backend_health || "healthy")}</div>
          </div>
        </div>
        <div class="health-card">
          <div>
            <div class="kpi-title">${esc(t.databaseHealth)}</div>
            <div class="health-status-ok">● ${esc(overview.database_health || "healthy")}</div>
          </div>
        </div>
        <div class="health-card">
          <div>
            <div class="kpi-title">${esc(t.storageHealth)}</div>
            <div class="health-status-ok">● ${esc(overview.storage_health || "healthy")}</div>
          </div>
          <div class="badge-role">${esc(overview.storage_backend || "local")}</div>
        </div>
      </div>

      <!-- Telemetry Card -->
      <div class="card">
        <h2>${esc(t.telemetryTitle)}</h2>
        <div class="kpi-grid mt-12">
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.uploadsCount)}</div>
            <div class="kpi-value">${Number(overview.uploads_count || 0)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.downloadsCount)}</div>
            <div class="kpi-value">${Number(overview.downloads_count || 0)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.deletionsCount)}</div>
            <div class="kpi-value">${Number(overview.deletions_count || 0)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.restorationsCount)}</div>
            <div class="kpi-value">${Number(overview.restorations_count || 0)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.failuresCount)}</div>
            <div class="kpi-value text-danger">${Number(overview.failed_operations_count || 0)}</div>
          </div>
        </div>
      </div>
    `;
  }

  // 2. OFFICES TAB
  else if (activeTab === "offices") {
    const rows = companies
      .map(
        (c) => `
        <tr>
          <td><strong>${esc(c.name)}</strong></td>
          <td><span class="tag ${esc(c.status)}">${esc(c.status)}</span></td>
          <td>${Number(c.user_count)} / ${Number(c.max_users)}</td>
          <td>${esc(fmtBytes(c.used_bytes))} / ${esc(fmtBytes(c.quota_bytes))}</td>
          <td class="row">
            <button class="secondary btn-sm" data-view-company="${esc(c.id)}" data-company-name="${esc(c.name)}">${esc(t.viewCompanyData)}</button>
            ${
              c.status === "active"
                ? `<button class="danger btn-sm" data-suspend="${esc(c.id)}">${esc(t.suspend)}</button>`
                : `<button class="btn-sm" data-reactivate="${esc(c.id)}">${esc(t.reactivate)}</button>`
            }
          </td>
        </tr>`
      )
      .join("");

    tabContent = `
      <div class="card">
        <h2>${esc(t.createCompany)}</h2>
        <form id="create-form" class="row">
          <input name="name" placeholder="${esc(t.companyName)}" required />
          <input name="quota_bytes" type="number" min="1" placeholder="${esc(t.quotaBytes)}" value="5368709120" />
          <input name="max_users" type="number" min="1" placeholder="${esc(t.maxUsers)}" value="10" />
          <button type="submit">${esc(t.create)}</button>
        </form>
        <p class="msg"></p>
      </div>

      <div class="card">
        <div class="spread">
          <h2>${esc(t.companies)}</h2>
          <input id="office-search" type="search" placeholder="${esc(t.searchOffices)}" style="max-width:240px" />
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>${esc(t.name)}</th>
                <th>${esc(t.status)}</th>
                <th>${esc(t.users)}</th>
                <th>${esc(t.usage)}</th>
                <th>${esc(t.actions)}</th>
              </tr>
            </thead>
            <tbody id="offices-table-body">
              ${rows || `<tr><td colspan="5" class="muted">${esc(t.noCompanies)}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // 3. USERS TAB
  else if (activeTab === "users") {
    const userRows = users
      .map(
        (u) => `
        <tr>
          <td><strong>${esc(u.email || "-")}</strong></td>
          <td>${esc(u.full_name || "-")}</td>
          <td><span class="badge-role">${esc(u.role)}</span></td>
          <td>${esc(u.company_name || "-")}</td>
          <td><span class="tag ${esc(u.status)}">${esc(u.status)}</span></td>
          <td>${esc(u.created_at ? u.created_at.substring(0, 10) : "-")}</td>
          <td>
            ${
              u.status === "active"
                ? `<button class="danger btn-sm" data-user-status="${esc(u.id)}" data-target-status="disabled">${esc(t.disable)}</button>`
                : `<button class="btn-sm" data-user-status="${esc(u.id)}" data-target-status="active">${esc(t.enable)}</button>`
            }
          </td>
        </tr>`
      )
      .join("");

    tabContent = `
      <div class="card">
        <div class="spread">
          <h2>${esc(t.globalUsersTitle)}</h2>
          <div class="row">
            <input id="user-search" type="search" placeholder="${esc(t.searchUsers)}" style="max-width:260px" />
            <select id="user-status-filter">
              <option value="">${esc(t.allStatuses)}</option>
              <option value="active">${esc(t.active)}</option>
              <option value="disabled">${esc(t.disabled)}</option>
            </select>
          </div>
        </div>
        <div class="table-responsive mt-12">
          <table>
            <thead>
              <tr>
                <th>${esc(t.email)}</th>
                <th>${esc(t.fullName)}</th>
                <th>${esc(t.role)}</th>
                <th>${esc(t.office)}</th>
                <th>${esc(t.status)}</th>
                <th>${esc(t.date)}</th>
                <th>${esc(t.actions)}</th>
              </tr>
            </thead>
            <tbody>
              ${userRows || `<tr><td colspan="7" class="muted">${esc(t.noUsers)}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // 4. AUDIT TAB
  else if (activeTab === "audit") {
    const auditRows = (audit.items || [])
      .map(
        (e) => `
        <tr>
          <td>${esc(e.created_at ? e.created_at.replace("T", " ").substring(0, 19) : "-")}</td>
          <td><code>${esc(e.action)}</code></td>
          <td><span class="tag ${e.result === "success" ? "active" : "inactive"}">${esc(e.result)}</span></td>
          <td>${esc(e.company_name || "-")}</td>
          <td>${esc(e.actor_email || "-")}</td>
          <td><small>${esc(e.target_type || "-")}: ${esc(e.target_id || "-")}</small></td>
          <td><small class="muted">${esc(e.ip || "-")}</small></td>
        </tr>`
      )
      .join("");

    tabContent = `
      <div class="card">
        <div class="spread">
          <h2>${esc(t.auditCenterTitle)}</h2>
          <div class="row">
            <input id="audit-search" type="search" placeholder="${esc(t.searchAudit)}" style="max-width:260px" />
            <select id="audit-result-filter">
              <option value="">${esc(t.allResults)}</option>
              <option value="success">${esc(t.success)}</option>
              <option value="failure">${esc(t.failure)}</option>
            </select>
          </div>
        </div>
        <div class="table-responsive mt-12">
          <table>
            <thead>
              <tr>
                <th>${esc(t.timestamp)}</th>
                <th>${esc(t.action)}</th>
                <th>${esc(t.result)}</th>
                <th>${esc(t.office)}</th>
                <th>${esc(t.actor)}</th>
                <th>${esc(t.target)}</th>
                <th>${esc(t.ip)}</th>
              </tr>
            </thead>
            <tbody>
              ${auditRows || `<tr><td colspan="7" class="muted">${esc(t.noAuditLogs)}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // 5. ALERTS TAB
  else if (activeTab === "alerts") {
    const alertItems = alerts
      .map(
        (a) => `
        <div class="alert-item ${esc(a.severity)}">
          <div>
            <div class="alert-title">${esc(a.title)}</div>
            <div class="alert-desc">${esc(a.description)}</div>
          </div>
          <span class="tag ${a.severity === "critical" ? "inactive" : "warning"}">${esc(a.severity)}</span>
        </div>`
      )
      .join("");

    tabContent = `
      <div class="card">
        <h2>${esc(t.operationalAlertsTitle)}</h2>
        <div class="alerts-list mt-12">
          ${alertItems || `<p class="muted">${esc(t.noAlerts)}</p>`}
        </div>
      </div>
    `;
  }

  // 6. EXPORT TAB
  else if (activeTab === "export") {
    tabContent = `
      <div class="card">
        <h2>${esc(t.exportTitle)}</h2>
        <p class="muted">${esc(t.exportDesc)}</p>
        <div class="row mt-16">
          <button class="secondary" data-export-platform="companies">${esc(t.exportOffices)}</button>
          <button class="secondary" data-export-platform="users">${esc(t.exportUsers)}</button>
          <button class="secondary" data-export-platform="audit">${esc(t.exportAudit)}</button>
        </div>
      </div>
    `;
  }

  return layout(
    t.platformTitle,
    t.platformSubtitle,
    `${renderTabs(tabs, activeTab)}${tabContent}`,
    lang,
    switchBtn
  );
}

export function companyView(me, employees, quarries, usage, opts = {}) {
  const lang = opts.lang || "en";
  const t = I18N[lang] || I18N.en;
  const activeTab = opts.activeTab || "overview";
  const permissionsList = opts.permissions || [];
  const selectedQuarryId = opts.selectedQuarryId || (quarries.length > 0 ? quarries[0].id : null);
  const selectedDocuments = opts.documents || [];
  const trashDocuments = opts.trashDocuments || [];
  const officeOverview = opts.officeOverview || {};
  const officeAlerts = officeOverview.alerts || opts.alerts || [];

  const isSuperAdminViewing = !!opts.isSuperAdminViewingOffice;
  const banner = isSuperAdminViewing
    ? `<div class="platform-banner">
        <span>${esc(t.viewingAsSuperAdmin.replace("{name}", opts.activeCompanyName || me?.company?.name || ""))}</span>
        <button class="secondary btn-sm" id="exit-office-view" type="button">${esc(t.returnToPlatform)}</button>
       </div>`
    : "";

  const switchBtn = opts.canSwitchRole && !isSuperAdminViewing
    ? `<button class="secondary" id="view-toggle" type="button">${esc(t.switchToPlatform)}</button>`
    : "";

  const tabs = [
    { id: "overview", label: t.tabOverview },
    { id: "quarries", label: t.tabQuarries },
    { id: "trash", label: `${t.tabTrash}${trashDocuments.length > 0 ? ` (${trashDocuments.length})` : ""}` },
    { id: "employees", label: t.tabEmployees },
    { id: "audit", label: t.tabAudit },
    { id: "export", label: t.tabExport }
  ];

  let tabContent = "";

  // 1. COMPANY OVERVIEW TAB
  if (activeTab === "overview") {
    const used = Number(usage.used_bytes || officeOverview.used_bytes || 0);
    const quota = Number(usage.quota_bytes || officeOverview.quota_bytes || 1);
    const pct = Math.min(100, Math.round((used / quota) * 100));
    const usageClass = pct > 90 ? "danger" : pct > 75 ? "warning" : "normal";

    const alertRows = officeAlerts
      .map(
        (a) => `
        <div class="alert-item ${esc(a.severity)}">
          <div>
            <div class="alert-title">${esc(a.title)}</div>
            <div class="alert-desc">${esc(a.description)}</div>
          </div>
          <span class="tag ${a.severity === "critical" ? "inactive" : "warning"}">${esc(a.severity)}</span>
        </div>`
      )
      .join("");

    tabContent = `
      <!-- Storage & Quota Bar -->
      <div class="card storage-card">
        <div class="spread">
          <div>
            <h3>${esc(t.storageUsage)}</h3>
            <div class="muted">${esc(fmtBytes(used))} / ${esc(fmtBytes(quota))} (${pct}%)</div>
          </div>
        </div>
        <progress class="meter-bar ${usageClass}" value="${pct}" max="100"></progress>
      </div>

      <!-- Quick KPI Counters -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-title">${esc(t.quarries)}</div>
          <div class="kpi-value">${Number(quarries.length)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">${esc(t.activeDocs)}</div>
          <div class="kpi-value">${Number(officeOverview.active_documents || 0)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">${esc(t.trashDocs)}</div>
          <div class="kpi-value">${Number(officeOverview.trash_documents || trashDocuments.length || 0)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">${esc(t.employees)}</div>
          <div class="kpi-value">${Number(employees.length)} / ${Number(officeOverview.max_users || usage.max_users || "-")}</div>
        </div>
      </div>

      <!-- 30-Day Activity Stats -->
      <div class="card">
        <h2>${esc(t.telemetryTitle)}</h2>
        <div class="kpi-grid mt-12">
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.uploadsCount)}</div>
            <div class="kpi-value">${Number(officeOverview.recent_uploads_count || 0)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.downloadsCount)}</div>
            <div class="kpi-value">${Number(officeOverview.recent_downloads_count || 0)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.deletionsCount)}</div>
            <div class="kpi-value">${Number(officeOverview.recent_deletions_count || 0)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.restorationsCount)}</div>
            <div class="kpi-value">${Number(officeOverview.recent_restorations_count || 0)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">${esc(t.failuresCount)}</div>
            <div class="kpi-value text-danger">${Number(officeOverview.recent_failures_count || 0)}</div>
          </div>
        </div>
      </div>

      <!-- Office Alerts -->
      ${
        officeAlerts.length > 0
          ? `
        <div class="card">
          <h2>${esc(t.operationalAlertsTitle)}</h2>
          <div class="alerts-list mt-12">
            ${alertRows}
          </div>
        </div>`
          : ""
      }
    `;
  }

  // 2. QUARRIES & DOCS TAB
  else if (activeTab === "quarries") {
    const quarryRows = quarries
      .map(
        (q) => `
        <tr class="${q.id === selectedQuarryId ? "active-row" : ""}">
          <td><strong>${esc(q.name)}</strong></td>
          <td><span class="tag ${esc(q.status)}">${esc(q.status)}</span></td>
          <td class="row">
            <button class="secondary btn-sm" data-view-docs="${esc(q.id)}">${esc(t.viewDocs)}</button>
            <button class="secondary btn-sm" data-rename="${esc(q.id)}" data-name="${esc(q.name)}">${esc(t.rename)}</button>
            ${
              q.status === "active"
                ? `<button class="danger btn-sm" data-deactivate="${esc(q.id)}">${esc(t.deactivate)}</button>`
                : `<button class="btn-sm" data-reactivate-q="${esc(q.id)}">${esc(t.reactivate)}</button>`
            }
          </td>
        </tr>`
      )
      .join("");

    const selectedQuarry = quarries.find((q) => q.id === selectedQuarryId);
    const docRows = selectedDocuments
      .map(
        (d) => `
        <tr>
          <td>
            <strong>${esc(d.display_name || d.original_filename)}</strong>
            ${d.display_name && d.display_name !== d.original_filename ? `<br/><small class="muted">${esc(d.original_filename)}</small>` : ""}
          </td>
          <td>${esc(fmtBytes(d.size_bytes))}</td>
          <td><span class="tag">${esc(d.mime_type.split("/")[1] || d.mime_type)}</span></td>
          <td>v${Number(d.version || 1)}</td>
          <td>${esc(d.created_at ? d.created_at.substring(0, 10) : "-")}</td>
          <td class="row">
            <a class="button secondary btn-sm" href="/documents/${esc(d.id)}/download" target="_blank" download="${esc(d.original_filename)}">${esc(t.download)}</a>
            <button class="danger btn-sm" data-delete-doc="${esc(d.id)}" data-quarry="${esc(selectedQuarryId)}">${esc(t.deleteDoc)}</button>
          </td>
        </tr>`
      )
      .join("");

    tabContent = `
      <div class="card">
        <h2>${esc(t.createQuarry)}</h2>
        <form id="quarry-form" class="row">
          <input name="name" placeholder="${esc(t.quarryNamePlaceholder)}" required />
          <button type="submit">${esc(t.create)}</button>
        </form>
        <p class="msg"></p>
      </div>

      <div class="card">
        <h2>${esc(t.quarries)}</h2>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>${esc(t.name)}</th>
                <th>${esc(t.status)}</th>
                <th>${esc(t.actions)}</th>
              </tr>
            </thead>
            <tbody>
              ${quarryRows || `<tr><td colspan="3" class="muted">${esc(t.noQuarries)}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" id="documents-card">
        <div class="spread">
          <div>
            <h2>${esc(t.documentsArchive)}</h2>
            <div class="muted">${selectedQuarry ? esc(selectedQuarry.name) : esc(t.selectQuarryPrompt)}</div>
          </div>
          ${
            quarries.length > 0
              ? `<div class="row">
                  <select id="select-quarry-docs">
                    ${quarries
                      .map(
                        (q) =>
                          `<option value="${esc(q.id)}" ${q.id === selectedQuarryId ? "selected" : ""}>${esc(q.name)}</option>`
                      )
                      .join("")}
                  </select>
                </div>`
              : ""
          }
        </div>

        ${
          selectedQuarry
            ? `
          <div class="mt-16">
            <form id="doc-upload-form" class="row upload-row">
              <input type="file" name="file" required />
              <input type="text" name="display_name" placeholder="${esc(t.documentName)} (optional)" />
              <button type="submit">${esc(t.uploadBtn)}</button>
            </form>
            <p class="msg upload-msg"></p>

            <div class="table-responsive mt-12">
              <table>
                <thead>
                  <tr>
                    <th>${esc(t.documentName)}</th>
                    <th>${esc(t.size)}</th>
                    <th>Type</th>
                    <th>${esc(t.version)}</th>
                    <th>${esc(t.date)}</th>
                    <th>${esc(t.actions)}</th>
                  </tr>
                </thead>
                <tbody>
                  ${docRows || `<tr><td colspan="6" class="muted">${esc(t.noDocuments)}</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>`
            : `<p class="muted mt-12">${esc(t.noQuarries)}</p>`
        }
      </div>
    `;
  }

  // 3. TRASH TAB
  else if (activeTab === "trash") {
    const trashRows = trashDocuments
      .map(
        (d) => `
        <tr>
          <td>
            <strong>${esc(d.display_name || d.original_filename)}</strong>
            <br/><small class="muted">${esc(d.original_filename)}</small>
          </td>
          <td>${esc(fmtBytes(d.size_bytes))}</td>
          <td>v${Number(d.version || 1)}</td>
          <td>${esc(d.deleted_at ? d.deleted_at.substring(0, 16).replace("T", " ") : "-")}</td>
          <td><small class="muted">${esc(d.retention_expires_at ? d.retention_expires_at.substring(0, 10) : "-")}</small></td>
          <td>
            <button class="btn-sm" data-restore-doc="${esc(d.id)}" data-quarry="${esc(d.quarry_id)}">${esc(t.restore)}</button>
          </td>
        </tr>`
      )
      .join("");

    tabContent = `
      <div class="card">
        <div class="spread">
          <div>
            <h2>${esc(t.trashTitle)}</h2>
            <div class="muted">${esc(t.trashSubtitle)}</div>
          </div>
          ${
            quarries.length > 0
              ? `<div class="row">
                  <select id="select-quarry-trash">
                    ${quarries
                      .map(
                        (q) =>
                          `<option value="${esc(q.id)}" ${q.id === selectedQuarryId ? "selected" : ""}>${esc(q.name)}</option>`
                      )
                      .join("")}
                  </select>
                </div>`
              : ""
          }
        </div>
        <div class="table-responsive mt-12">
          <table>
            <thead>
              <tr>
                <th>${esc(t.documentName)}</th>
                <th>${esc(t.size)}</th>
                <th>${esc(t.version)}</th>
                <th>${esc(t.deletedAt)}</th>
                <th>${esc(t.retentionExpires)}</th>
                <th>${esc(t.actions)}</th>
              </tr>
            </thead>
            <tbody>
              ${trashRows || `<tr><td colspan="6" class="muted">${esc(t.noTrash)}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // 4. EMPLOYEES & MATRIX TAB
  else if (activeTab === "employees") {
    const empRows = employees
      .map(
        (u) => `
        <tr>
          <td><strong>${esc(u.email)}</strong></td>
          <td>${esc(u.full_name || "-")}</td>
          <td><span class="badge-role">${esc(u.role)}</span></td>
          <td><span class="tag ${esc(u.status)}">${esc(u.status)}</span></td>
          <td class="row">
            ${
              u.status === "active"
                ? `<button class="danger btn-sm" data-disable="${esc(u.id)}">${esc(t.disable)}</button>`
                : `<button class="btn-sm" data-enable="${esc(u.id)}">${esc(t.enable)}</button>`
            }
          </td>
        </tr>`
      )
      .join("");

    const permMap = new Map();
    for (const p of permissionsList) {
      permMap.set(`${p.user_id}:${p.quarry_id}`, p);
    }

    const matrixHeaders = quarries
      .map((q) => `<th>${esc(q.name)}</th>`)
      .join("");

    const matrixRows = employees
      .map((emp) => {
        const cellTds = quarries
          .map((q) => {
            const perm = permMap.get(`${emp.id}:${q.id}`) || { can_view: false, can_upload: false, can_download: false };
            return `
              <td class="matrix-cell">
                <div class="perm-toggles" data-user="${esc(emp.id)}" data-quarry="${esc(q.id)}">
                  <label class="chk-label" title="${esc(t.view)}">
                    <input type="checkbox" data-ptype="can_view" ${perm.can_view ? "checked" : ""} />
                    <span>${esc(t.view[0])}</span>
                  </label>
                  <label class="chk-label" title="${esc(t.upload)}">
                    <input type="checkbox" data-ptype="can_upload" ${perm.can_upload ? "checked" : ""} />
                    <span>${esc(t.upload[0])}</span>
                  </label>
                  <label class="chk-label" title="${esc(t.download)}">
                    <input type="checkbox" data-ptype="can_download" ${perm.can_download ? "checked" : ""} />
                    <span>${esc(t.download[0])}</span>
                  </label>
                </div>
              </td>`;
          })
          .join("");

        return `
          <tr>
            <td><strong>${esc(emp.full_name || emp.email)}</strong><br/><small class="muted">${esc(emp.email)}</small></td>
            ${cellTds}
          </tr>`;
      })
      .join("");

    const memberOptions = employees
      .map((u) => `<option value="${esc(u.id)}">${esc(u.email)}</option>`)
      .join("");
    const quarryOptions = quarries
      .map((q) => `<option value="${esc(q.id)}">${esc(q.name)}</option>`)
      .join("");

    tabContent = `
      <div class="card">
        <h2>${esc(t.inviteEmployee)}</h2>
        <form id="invite-form" class="row">
          <input name="email" type="email" placeholder="${esc(t.emailPlaceholder)}" required />
          <input name="full_name" placeholder="${esc(t.fullNamePlaceholder)}" />
          <button type="submit">${esc(t.sendInvite)}</button>
        </form>
        <p class="msg"></p>
      </div>

      <div class="card">
        <h2>${esc(t.employees)}</h2>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>${esc(t.email)}</th>
                <th>${esc(t.fullName)}</th>
                <th>${esc(t.role)}</th>
                <th>${esc(t.status)}</th>
                <th>${esc(t.actions)}</th>
              </tr>
            </thead>
            <tbody>
              ${empRows || `<tr><td colspan="5" class="muted">${esc(t.noEmployees)}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>${esc(t.permissionsMatrix)}</h2>
        <p class="muted">${esc(t.permissionsDesc)}</p>
        <div class="table-responsive">
          <table class="matrix-table">
            <thead>
              <tr>
                <th>${esc(t.employees)}</th>
                ${matrixHeaders || `<th>${esc(t.quarries)}</th>`}
              </tr>
            </thead>
            <tbody>
              ${matrixRows || `<tr><td colspan="2" class="muted">${esc(t.noEmployees)}</td></tr>`}
            </tbody>
          </table>
        </div>

        <h3 class="sub-heading">${esc(t.savePermission)}</h3>
        <form id="perm-form" class="row">
          <select name="user_id">${memberOptions}</select>
          <select name="quarry_id">${quarryOptions}</select>
          <label class="row chk-label"><input type="checkbox" name="can_view" /> ${esc(t.view)}</label>
          <label class="row chk-label"><input type="checkbox" name="can_upload" /> ${esc(t.upload)}</label>
          <label class="row chk-label"><input type="checkbox" name="can_download" /> ${esc(t.download)}</label>
          <button type="submit">${esc(t.savePermission)}</button>
        </form>
        <p class="msg"></p>
      </div>
    `;
  }

  // 5. AUDIT TAB
  else if (activeTab === "audit") {
    const auditEvents = opts.auditEvents || [];
    const auditRows = auditEvents
      .map(
        (e) => `
        <tr>
          <td>${esc(e.created_at ? e.created_at.replace("T", " ").substring(0, 19) : "-")}</td>
          <td><code>${esc(e.action)}</code></td>
          <td><span class="tag ${e.result === "success" ? "active" : "inactive"}">${esc(e.result)}</span></td>
          <td>${esc(e.actor_email || "-")}</td>
          <td><small>${esc(e.target_type || "-")}: ${esc(e.target_id || "-")}</small></td>
          <td><small class="muted">${esc(e.ip || "-")}</small></td>
        </tr>`
      )
      .join("");

    tabContent = `
      <div class="card">
        <h2>${esc(t.auditCenterTitle)}</h2>
        <div class="table-responsive mt-12">
          <table>
            <thead>
              <tr>
                <th>${esc(t.timestamp)}</th>
                <th>${esc(t.action)}</th>
                <th>${esc(t.result)}</th>
                <th>${esc(t.actor)}</th>
                <th>${esc(t.target)}</th>
                <th>${esc(t.ip)}</th>
              </tr>
            </thead>
            <tbody>
              ${auditRows || `<tr><td colspan="6" class="muted">${esc(t.noAuditLogs)}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // 6. EXPORT TAB
  else if (activeTab === "export") {
    tabContent = `
      <div class="card">
        <h2>${esc(t.exportTitle)}</h2>
        <p class="muted">${esc(t.exportDesc)}</p>
        <div class="row mt-16">
          <button class="secondary" data-export-company="employees">${esc(t.exportEmployees)}</button>
          <button class="secondary" data-export-company="quarries">${esc(t.exportQuarries)}</button>
          <button class="secondary" data-export-company="documents">${esc(t.exportDocuments)}</button>
          <button class="secondary" data-export-company="audit">${esc(t.exportAudit)}</button>
        </div>
      </div>
    `;
  }

  return layout(
    opts.activeCompanyName || me?.company?.name || t.companyTitle,
    `${t.signedInAs} ${esc(me?.user?.email || "")} (${esc(me?.role || "admin")})`,
    `${renderTabs(tabs, activeTab)}${tabContent}`,
    lang,
    switchBtn,
    banner
  );
}
