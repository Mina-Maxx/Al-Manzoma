// QuarryVault admin dashboard.
//
// Auth is delegated entirely to Supabase Auth (GoTrue) from the browser using
// the PUBLIC anon key. The service-role key never reaches this file. The
// backend still verifies every access token on each request.
//
// No framework, no build step: native ES modules + fetch. All user-supplied
// data is rendered through the escaped helpers in ./views.js.

import { esc, companyView, platformView } from "./views.js";

const app = document.getElementById("app");
const SESSION_KEY = "qv_session";
const LANG_KEY = "qv_lang";

const state = {
  config: null,
  session: null,
  me: null,
  isPlatform: false,
  role: null, // "platform" | "company" | "employee" | "none"
  activeCompanyId: null,
  activeCompanyName: null,
  callback: null,
  lang: localStorage.getItem(LANG_KEY) || "en",
  activeTabPlatform: "overview",
  activeTabCompany: "overview",
  selectedQuarryId: null,
  userSearch: "",
  userStatusFilter: "",
  auditSearch: "",
  auditResultFilter: "",
};

// --------------------------------------------------------------------------
// utilities
// --------------------------------------------------------------------------

function msg(container, text, kind = "") {
  const node = container.querySelector(".msg");
  if (node) {
    node.className = `msg ${kind}`;
    node.textContent = text || "";
  }
}

function stripAuthFragment() {
  history.replaceState(null, "", location.pathname + location.search);
}

// --------------------------------------------------------------------------
// auth: Supabase (GoTrue) over REST
// --------------------------------------------------------------------------

function parseAuthFragment() {
  if (!location.hash || location.hash.length < 2) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const accessToken = params.get("access_token");
  const type = params.get("type");
  if (!accessToken || !type) return null;
  return {
    access_token: accessToken,
    refresh_token: params.get("refresh_token"),
    type,
  };
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  state.session = session;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

function sessionFromTokens(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

function authBase() {
  return `${(state.config.supabase_url || "").replace(/\/+$/, "")}/auth/v1`;
}

async function gotrue(path, { method = "GET", body, token, query } = {}) {
  const url = new URL(authBase() + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers = {
    apikey: state.config.supabase_anon_key,
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function signIn(email, password) {
  return gotrue("/token", {
    method: "POST",
    query: { grant_type: "password" },
    body: { email, password },
  });
}

async function refreshSession() {
  if (!state.session?.refresh_token) return false;
  const res = await gotrue("/token", {
    method: "POST",
    query: { grant_type: "refresh_token" },
    body: { refresh_token: state.session.refresh_token },
  });
  if (!res.ok) return false;
  saveSession(sessionFromTokens(await res.json()));
  return true;
}

function updatePassword(password, accessToken) {
  return gotrue("/user", { method: "PUT", token: accessToken, body: { password } });
}

function recoverPassword(email) {
  const redirectTo = `${location.origin}/dashboard/reset-password`;
  return gotrue("/recover", {
    method: "POST",
    query: { redirect_to: redirectTo },
    body: { email },
  });
}

function signOut() {
  saveSession(null);
  state.me = null;
  state.role = null;
  state.isPlatform = false;
  state.activeCompanyId = null;
  state.activeCompanyName = null;
  history.replaceState(null, "", "/dashboard/");
  renderLogin();
}

function handleSessionExpired() {
  saveSession(null);
  state.me = null;
  state.role = null;
  renderLogin("Your session expired. Please sign in again.");
}

// --------------------------------------------------------------------------
// backend API
// --------------------------------------------------------------------------

async function ensureFreshSession() {
  if (!state.session) return;
  if (state.session.expires_at - 30000 < Date.now()) await refreshSession();
}

async function api(path, { method = "GET", body } = {}) {
  if (!state.session) return new Response(null, { status: 401 });
  await ensureFreshSession();
  if (!state.session) return new Response(null, { status: 401 });

  const doFetch = () => {
    const headers = { Authorization: `Bearer ${state.session.access_token}` };
    if (body) headers["Content-Type"] = "application/json";
    if (state.activeCompanyId) headers["X-Company-Id"] = state.activeCompanyId;
    return fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doFetch();
  if (res.status === 401) {
    if (await refreshSession()) res = await doFetch();
    if (res.status === 401) handleSessionExpired();
  }
  return res;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.detail) || `request failed (${res.status})`);
  return data;
}

async function downloadCsv(path, fallbackName) {
  try {
    const res = await api(path);
    if (!res.ok) {
      alert(`Export failed (${res.status})`);
      return;
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition");
    let filename = fallbackName;
    if (disposition && disposition.includes("filename=")) {
      filename = disposition.split("filename=")[1].replace(/["']/g, "").trim();
    }
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
  } catch (err) {
    alert(err.message);
  }
}

// --------------------------------------------------------------------------
// auth screens
// --------------------------------------------------------------------------

function renderLogin(error = "") {
  app.innerHTML = `
    <div class="auth">
      <h1>QuarryVault</h1>
      <p class="muted">Sign in with your administrative account.</p>
      <div class="card">
        <form id="login-form">
          <label>Email<input name="email" type="email" autocomplete="username" required /></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
          <button type="submit">Sign in</button>
        </form>
        <p class="msg error">${esc(error)}</p>
        <button class="secondary" id="to-forgot" type="button">Forgot password?</button>
      </div>
    </div>`;

  app.querySelector("#to-forgot").addEventListener("click", renderForgot);
  app.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = form.email.value.trim();
    const password = form.password.value;
    msg(app.querySelector(".auth .card"), "Signing in...", "");
    const res = await signIn(email, password);
    if (!res.ok) {
      renderLogin("Invalid email or password.");
      return;
    }
    saveSession(sessionFromTokens(await res.json()));
    history.replaceState(null, "", "/dashboard/");
    await start();
  });
}

function renderForgot() {
  app.innerHTML = `
    <div class="auth">
      <h1>Reset password</h1>
      <p class="muted">We will email you a reset link.</p>
      <div class="card">
        <form id="forgot-form">
          <label>Email<input name="email" type="email" required /></label>
          <button type="submit">Send reset link</button>
        </form>
        <p class="msg"></p>
        <button class="secondary" id="to-login" type="button">Back to sign in</button>
      </div>
    </div>`;

  app.querySelector("#to-login").addEventListener("click", () => renderLogin());
  app.querySelector("#forgot-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = event.currentTarget.email.value.trim();
    const card = app.querySelector(".auth .card");
    msg(card, "Sending...", "");
    await recoverPassword(email);
    msg(card, "If that email has an account, a reset link is on its way.", "ok");
    event.currentTarget.reset();
  });
}

function renderSetPassword() {
  const isInvite = state.callback.type === "invite";
  app.innerHTML = `
    <div class="auth">
      <h1>${isInvite ? "Accept your invitation" : "Set a new password"}</h1>
      <p class="muted">Choose a password for your account.</p>
      <div class="card">
        <form id="password-form">
          <label>New password<input name="password" type="password" minlength="8" autocomplete="new-password" required /></label>
          <button type="submit">Save password</button>
        </form>
        <p class="msg error"></p>
      </div>
    </div>`;

  app.querySelector("#password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const card = app.querySelector(".auth .card");
    const password = event.currentTarget.password.value;
    msg(card, "Saving...", "");
    const res = await updatePassword(password, state.callback.access_token);
    if (!res.ok) {
      msg(card, "That link is invalid or expired. Ask for a new invitation.", "error");
      return;
    }
    saveSession({
      access_token: state.callback.access_token,
      refresh_token: state.callback.refresh_token,
      expires_at: Date.now() + 3600 * 1000,
    });
    state.callback = null;
    stripAuthFragment();
    await start();
  });
}

function renderNotice(text) {
  app.innerHTML = `
    <div class="spread header-bar">
      <h1>QuarryVault</h1>
      <button class="secondary" id="signout">Sign out</button>
    </div>
    <div class="card"><p>${esc(text)}</p></div>`;
  wireHeaderActions();
}

function toggleLanguage() {
  state.lang = state.lang === "en" ? "ar" : "en";
  localStorage.setItem(LANG_KEY, state.lang);
  renderApp();
}

function wireHeaderActions() {
  const signout = app.querySelector("#signout");
  if (signout) signout.addEventListener("click", signOut);

  const langBtn = app.querySelector("#lang-toggle");
  if (langBtn) langBtn.addEventListener("click", toggleLanguage);

  const viewToggle = app.querySelector("#view-toggle");
  if (viewToggle) {
    viewToggle.addEventListener("click", () => {
      if (state.role === "company") {
        state.role = "platform";
        state.activeCompanyId = null;
        state.activeCompanyName = null;
      } else {
        state.role = "company";
      }
      state.selectedQuarryId = null;
      renderApp();
    });
  }

  const exitOffice = app.querySelector("#exit-office-view");
  if (exitOffice) {
    exitOffice.addEventListener("click", () => {
      state.activeCompanyId = null;
      state.activeCompanyName = null;
      state.role = "platform";
      state.selectedQuarryId = null;
      renderApp();
    });
  }
}

// --------------------------------------------------------------------------
// platform management screens
// --------------------------------------------------------------------------

async function renderPlatform() {
  const currentTab = state.activeTabPlatform;
  let overview = {};
  let companies = [];
  let users = [];
  let audit = { total: 0, items: [] };
  let alerts = [];

  try {
    if (currentTab === "overview") {
      [overview, alerts] = await Promise.all([
        apiJson("/platform/overview"),
        apiJson("/platform/alerts"),
      ]);
    } else if (currentTab === "offices") {
      companies = await apiJson("/platform/companies");
    } else if (currentTab === "users") {
      let q = `/platform/users?limit=100`;
      if (state.userStatusFilter) q += `&status=${encodeURIComponent(state.userStatusFilter)}`;
      if (state.userSearch) q += `&search=${encodeURIComponent(state.userSearch)}`;
      users = await apiJson(q);
    } else if (currentTab === "audit") {
      let q = `/platform/audit?limit=50`;
      if (state.auditResultFilter) q += `&result=${encodeURIComponent(state.auditResultFilter)}`;
      if (state.auditSearch) q += `&search=${encodeURIComponent(state.auditSearch)}`;
      audit = await apiJson(q);
    } else if (currentTab === "alerts") {
      alerts = await apiJson("/platform/alerts");
    }
  } catch (err) {
    console.error("Failed to load platform data:", err);
  }

  app.innerHTML = platformView(
    { overview, companies, users, audit, alerts },
    {
      lang: state.lang,
      activeTab: currentTab,
      canSwitchRole: !!(state.isPlatform && state.me?.role === "company_admin"),
    }
  );
  wireHeaderActions();

  // Tab switcher
  for (const tabBtn of app.querySelectorAll(".nav-tabs .tab-btn")) {
    tabBtn.addEventListener("click", () => {
      state.activeTabPlatform = tabBtn.dataset.tab;
      renderPlatform();
    });
  }

  // Offices Tab handlers
  if (currentTab === "offices") {
    const createForm = app.querySelector("#create-form");
    if (createForm) {
      const card = createForm.closest(".card");
      createForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        try {
          await apiJson("/platform/companies", {
            method: "POST",
            body: {
              name: form.name.value.trim(),
              quota_bytes: Number(form.quota_bytes.value),
              max_users: Number(form.max_users.value),
            },
          });
          renderPlatform();
        } catch (err) {
          msg(card, err.message, "error");
        }
      });
    }

    const officeSearch = app.querySelector("#office-search");
    if (officeSearch) {
      officeSearch.addEventListener("input", (e) => {
        const val = e.target.value.toLowerCase().trim();
        for (const row of app.querySelectorAll("#offices-table-body tr")) {
          const text = row.textContent.toLowerCase();
          row.style.display = text.includes(val) ? "" : "none";
        }
      });
    }

    for (const button of app.querySelectorAll("[data-view-company]")) {
      button.addEventListener("click", () => {
        state.activeCompanyId = button.dataset.viewCompany;
        state.activeCompanyName = button.dataset.companyName;
        state.role = "company";
        state.activeTabCompany = "overview";
        state.selectedQuarryId = null;
        renderApp();
      });
    }

    for (const button of app.querySelectorAll("[data-suspend]")) {
      button.addEventListener("click", async () => {
        await api(`/platform/companies/${button.dataset.suspend}/suspend`, { method: "POST" });
        renderPlatform();
      });
    }

    for (const button of app.querySelectorAll("[data-reactivate]")) {
      button.addEventListener("click", async () => {
        await api(`/platform/companies/${button.dataset.reactivate}/reactivate`, { method: "POST" });
        renderPlatform();
      });
    }
  }

  // Users Tab handlers
  if (currentTab === "users") {
    const searchInput = app.querySelector("#user-search");
    if (searchInput) {
      searchInput.value = state.userSearch;
      searchInput.addEventListener("change", (e) => {
        state.userSearch = e.target.value.trim();
        renderPlatform();
      });
    }

    const filterSelect = app.querySelector("#user-status-filter");
    if (filterSelect) {
      filterSelect.value = state.userStatusFilter;
      filterSelect.addEventListener("change", (e) => {
        state.userStatusFilter = e.target.value;
        renderPlatform();
      });
    }

    for (const btn of app.querySelectorAll("[data-user-status]")) {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.userStatus;
        const targetStatus = btn.dataset.targetStatus;
        try {
          await apiJson(`/platform/users/${userId}/status`, {
            method: "POST",
            body: { status: targetStatus },
          });
          renderPlatform();
        } catch (err) {
          alert(err.message);
        }
      });
    }
  }

  // Audit Tab handlers
  if (currentTab === "audit") {
    const auditSearch = app.querySelector("#audit-search");
    if (auditSearch) {
      auditSearch.value = state.auditSearch;
      auditSearch.addEventListener("change", (e) => {
        state.auditSearch = e.target.value.trim();
        renderPlatform();
      });
    }

    const auditFilter = app.querySelector("#audit-result-filter");
    if (auditFilter) {
      auditFilter.value = state.auditResultFilter;
      auditFilter.addEventListener("change", (e) => {
        state.auditResultFilter = e.target.value;
        renderPlatform();
      });
    }
  }

  // Export Tab handlers
  if (currentTab === "export") {
    for (const btn of app.querySelectorAll("[data-export-platform]")) {
      btn.addEventListener("click", () => {
        const type = btn.dataset.exportPlatform;
        downloadCsv(`/platform/export/${type}`, `platform_${type}.csv`);
      });
    }
  }
}

// --------------------------------------------------------------------------
// company management screens
// --------------------------------------------------------------------------

async function renderCompany() {
  const currentTab = state.activeTabCompany;
  let employees = [];
  let quarries = [];
  let usage = { used_bytes: 0, quota_bytes: 5368709120 };
  let permissionsData = { permissions: [] };
  let officeOverview = {};
  let documents = [];
  let trashDocuments = [];
  let auditEvents = [];

  try {
    quarries = await apiJson("/company/quarries");
    if (!state.selectedQuarryId && quarries.length > 0) {
      state.selectedQuarryId = quarries[0].id;
    }

    if (currentTab === "overview") {
      [officeOverview, usage, employees] = await Promise.all([
        apiJson("/company/overview"),
        apiJson("/company/usage"),
        apiJson("/company/employees"),
      ]);
    } else if (currentTab === "quarries") {
      if (state.selectedQuarryId) {
        documents = await apiJson(`/quarries/${state.selectedQuarryId}/documents`);
      }
    } else if (currentTab === "trash") {
      if (state.selectedQuarryId) {
        trashDocuments = await apiJson(`/quarries/${state.selectedQuarryId}/trash`);
      }
    } else if (currentTab === "employees") {
      [employees, permissionsData] = await Promise.all([
        apiJson("/company/employees"),
        apiJson("/company/permissions"),
      ]);
    } else if (currentTab === "audit") {
      const res = await apiJson("/company/audit?limit=100");
      auditEvents = res.items || [];
    }
  } catch (err) {
    console.error("Failed to load company data:", err);
  }

  app.innerHTML = companyView(state.me, employees, quarries, usage, {
    lang: state.lang,
    activeTab: currentTab,
    permissions: permissionsData?.permissions || [],
    selectedQuarryId: state.selectedQuarryId,
    documents,
    trashDocuments,
    officeOverview,
    auditEvents,
    canSwitchRole: !!state.isPlatform,
    activeCompanyName: state.activeCompanyName,
    isSuperAdminViewingOffice: !!(state.isPlatform && state.activeCompanyId),
  });
  wireHeaderActions();

  // Tab navigation
  for (const tabBtn of app.querySelectorAll(".nav-tabs .tab-btn")) {
    tabBtn.addEventListener("click", () => {
      state.activeTabCompany = tabBtn.dataset.tab;
      renderCompany();
    });
  }

  // Quarries Tab Handlers
  if (currentTab === "quarries") {
    const quarryCard = app.querySelector("#quarry-form")?.closest(".card");
    const quarryForm = app.querySelector("#quarry-form");
    if (quarryForm) {
      quarryForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        try {
          await apiJson("/company/quarries", {
            method: "POST",
            body: { name: form.name.value.trim() },
          });
          renderCompany();
        } catch (err) {
          msg(quarryCard, err.message, "error");
        }
      });
    }

    for (const button of app.querySelectorAll("[data-deactivate]")) {
      button.addEventListener("click", async () => {
        await api(`/company/quarries/${button.dataset.deactivate}/deactivate`, { method: "POST" });
        renderCompany();
      });
    }
    for (const button of app.querySelectorAll("[data-reactivate-q]")) {
      button.addEventListener("click", async () => {
        await api(`/company/quarries/${button.dataset.reactivateQ}/reactivate`, { method: "POST" });
        renderCompany();
      });
    }
    for (const button of app.querySelectorAll("[data-rename]")) {
      button.addEventListener("click", async () => {
        const name = prompt("New quarry name", button.dataset.name);
        if (name === null) return;
        const res = await api(`/company/quarries/${button.dataset.rename}`, {
          method: "PATCH",
          body: { name: name.trim() },
        });
        if (!res.ok) alert((await res.json()).detail);
        renderCompany();
      });
    }

    for (const button of app.querySelectorAll("[data-view-docs]")) {
      button.addEventListener("click", () => {
        state.selectedQuarryId = button.dataset.viewDocs;
        renderCompany();
        const docsCard = app.querySelector("#documents-card");
        if (docsCard) docsCard.scrollIntoView({ behavior: "smooth" });
      });
    }

    const quarrySelect = app.querySelector("#select-quarry-docs");
    if (quarrySelect) {
      quarrySelect.addEventListener("change", (e) => {
        state.selectedQuarryId = e.target.value;
        renderCompany();
      });
    }

    // Document upload
    const uploadForm = app.querySelector("#doc-upload-form");
    if (uploadForm && state.selectedQuarryId) {
      uploadForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fileInput = uploadForm.querySelector('input[type="file"]');
        const nameInput = uploadForm.querySelector('input[name="display_name"]');
        const uploadMsg = app.querySelector(".upload-msg");

        if (!fileInput.files.length) return;
        const file = fileInput.files[0];
        const formData = new FormData();
        formData.append("file", file);
        if (nameInput.value.trim()) {
          formData.append("display_name", nameInput.value.trim());
        }

        uploadMsg.className = "msg";
        uploadMsg.textContent = state.lang === "ar" ? "جارٍ الرفع..." : "Uploading...";

        try {
          await ensureFreshSession();
          const headers = {
            Authorization: `Bearer ${state.session.access_token}`,
            "Idempotency-Key": crypto.randomUUID(),
          };
          if (state.activeCompanyId) headers["X-Company-Id"] = state.activeCompanyId;

          const res = await fetch(`/quarries/${state.selectedQuarryId}/documents`, {
            method: "POST",
            headers,
            body: formData,
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || `Upload failed (${res.status})`);
          }

          uploadMsg.className = "msg ok";
          uploadMsg.textContent = state.lang === "ar" ? "تم رفع المستند بنجاح." : "Document uploaded successfully.";
          renderCompany();
        } catch (err) {
          uploadMsg.className = "msg error";
          uploadMsg.textContent = err.message;
        }
      });
    }

    // Delete Document button
    for (const btn of app.querySelectorAll("[data-delete-doc]")) {
      btn.addEventListener("click", async () => {
        const docId = btn.dataset.deleteDoc;
        const qId = btn.dataset.quarry;
        const confirmText = state.lang === "ar" ? "هل أنت متأكد من نقل هذا المستند إلى سلة المهملات؟" : "Move this document to trash?";
        if (!confirm(confirmText)) return;
        try {
          const res = await api(`/quarries/${qId}/documents/${docId}`, { method: "DELETE" });
          if (!res.ok) throw new Error((await res.json()).detail || "Failed to delete");
          renderCompany();
        } catch (err) {
          alert(err.message);
        }
      });
    }

    // Download document link
    for (const btn of app.querySelectorAll('a[href^="/documents/"]')) {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          const href = btn.getAttribute("href");
          const res = await api(href);
          if (!res.ok) {
            alert(`Download failed (${res.status})`);
            return;
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = btn.getAttribute("download") || "document";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (err) {
          alert(err.message);
        }
      });
    }
  }

  // Trash Tab Handlers
  if (currentTab === "trash") {
    const trashSelect = app.querySelector("#select-quarry-trash");
    if (trashSelect) {
      trashSelect.addEventListener("change", (e) => {
        state.selectedQuarryId = e.target.value;
        renderCompany();
      });
    }

    for (const btn of app.querySelectorAll("[data-restore-doc]")) {
      btn.addEventListener("click", async () => {
        const docId = btn.dataset.restoreDoc;
        const qId = btn.dataset.quarry;
        const confirmText = state.lang === "ar" ? "هل تريد استعادة هذا المستند؟" : "Restore this document?";
        if (!confirm(confirmText)) return;
        try {
          await apiJson(`/quarries/${qId}/documents/${docId}/restore`, { method: "POST" });
          renderCompany();
        } catch (err) {
          alert(err.message);
        }
      });
    }
  }

  // Employees Tab Handlers
  if (currentTab === "employees") {
    const inviteForm = app.querySelector("#invite-form");
    if (inviteForm) {
      const inviteCard = inviteForm.closest(".card");
      inviteForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        try {
          await apiJson("/company/employees/invite", {
            method: "POST",
            body: { email: form.email.value.trim(), full_name: form.full_name.value.trim() || null },
          });
          msg(inviteCard, state.lang === "ar" ? "تم إرسال الدعوة بنجاح." : "Invitation sent.", "ok");
          form.reset();
          renderCompany();
        } catch (err) {
          msg(inviteCard, err.message, "error");
        }
      });
    }

    for (const button of app.querySelectorAll("[data-disable]")) {
      button.addEventListener("click", async () => {
        const res = await api(`/company/employees/${button.dataset.disable}/disable`, { method: "POST" });
        if (!res.ok) alert((await res.json()).detail);
        renderCompany();
      });
    }
    for (const button of app.querySelectorAll("[data-enable]")) {
      button.addEventListener("click", async () => {
        const res = await api(`/company/employees/${button.dataset.enable}/enable`, { method: "POST" });
        if (!res.ok) alert((await res.json()).detail);
        renderCompany();
      });
    }

    for (const container of app.querySelectorAll(".perm-toggles")) {
      const userId = container.dataset.user;
      const quarryId = container.dataset.quarry;
      const chkView = container.querySelector('[data-ptype="can_view"]');
      const chkUpload = container.querySelector('[data-ptype="can_upload"]');
      const chkDownload = container.querySelector('[data-ptype="can_download"]');

      const onToggle = async () => {
        try {
          await apiJson(`/company/quarries/${quarryId}/permissions/${userId}`, {
            method: "PUT",
            body: {
              can_view: chkView.checked,
              can_upload: chkUpload.checked,
              can_download: chkDownload.checked,
            },
          });
        } catch (err) {
          alert(err.message);
          renderCompany();
        }
      };

      chkView.addEventListener("change", onToggle);
      chkUpload.addEventListener("change", onToggle);
      chkDownload.addEventListener("change", onToggle);
    }

    const permForm = app.querySelector("#perm-form");
    if (permForm) {
      const permCard = permForm.closest(".card");
      permForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        try {
          await apiJson(`/company/quarries/${form.quarry_id.value}/permissions/${form.user_id.value}`, {
            method: "PUT",
            body: {
              can_view: form.can_view.checked,
              can_upload: form.can_upload.checked,
              can_download: form.can_download.checked,
            },
          });
          msg(permCard, state.lang === "ar" ? "تم حفظ الصلاحية بنجاح." : "Permission saved.", "ok");
          renderCompany();
        } catch (err) {
          msg(permCard, err.message, "error");
        }
      });
    }
  }

  // Export Tab Handlers
  if (currentTab === "export") {
    for (const btn of app.querySelectorAll("[data-export-company]")) {
      btn.addEventListener("click", () => {
        const type = btn.dataset.exportCompany;
        downloadCsv(`/company/export/${type}`, `office_${type}.csv`);
      });
    }
  }
}

// --------------------------------------------------------------------------
// bootstrap
// --------------------------------------------------------------------------

async function resolveRole() {
  const platformRes = await api("/platform/companies");
  state.isPlatform = platformRes.ok;
  const meRes = await api("/me");
  if (meRes.ok) {
    state.me = await meRes.json();
  }
  if (!state.role) {
    if (state.isPlatform) {
      state.role = "platform";
    } else if (state.me) {
      state.role = state.me.role === "company_admin" ? "company" : "employee";
    } else {
      state.role = "none";
    }
  }
}

async function renderApp() {
  if (!state.session) return;
  if (state.role === "platform") return renderPlatform();
  if (state.role === "company") return renderCompany();
  if (state.role === "employee") {
    return renderNotice("Your account is an employee. Ask an office admin for access.");
  }
  return renderNotice("No access for this account.");
}

async function start() {
  state.callback = parseAuthFragment();
  if (state.callback) {
    stripAuthFragment();
    renderSetPassword();
    return;
  }
  state.session = state.session || loadSession();
  if (!state.session) {
    renderLogin();
    return;
  }
  try {
    await resolveRole();
    if (!state.session) return;
    await renderApp();
  } catch {
    signOut();
  }
}

async function main() {
  const res = await fetch("/dashboard/config");
  state.config = await res.json();
  if (!state.config.supabase_url || !state.config.supabase_anon_key) {
    app.innerHTML = `<div class="auth"><div class="card"><h1>Not configured</h1>
      <p>Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> on the backend.</p></div></div>`;
    return;
  }
  await start();
}

main();
