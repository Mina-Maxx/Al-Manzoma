// QuarryVault admin dashboard.
//
// Auth is delegated entirely to Supabase Auth (GoTrue) from the browser using
// the PUBLIC anon key. The service-role key never reaches this file. The
// backend still verifies every access token on each request.
//
// No framework, no build step: native ES modules + fetch.

const app = document.getElementById("app");
const SESSION_KEY = "qv_session";

const state = {
  config: null,
  session: null,
  me: null,
  role: null, // "platform" | "company" | "employee" | "none"
  callback: null,
};

// --------------------------------------------------------------------------
// utilities
// --------------------------------------------------------------------------

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtBytes(n) {
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

function msg(container, text, kind = "") {
  const node = container.querySelector(".msg");
  if (node) {
    node.className = `msg ${kind}`;
    node.textContent = text || "";
  }
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
  history.replaceState(null, "", "/dashboard/");
  renderLogin();
}

// --------------------------------------------------------------------------
// backend API
// --------------------------------------------------------------------------

async function ensureFreshSession() {
  if (!state.session) return;
  if (state.session.expires_at - 30000 < Date.now()) await refreshSession();
}

async function api(path, { method = "GET", body } = {}) {
  await ensureFreshSession();
  const doFetch = () => {
    const headers = { Authorization: `Bearer ${state.session.access_token}` };
    if (body) headers["Content-Type"] = "application/json";
    return fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  };
  let res = await doFetch();
  if (res.status === 401 && (await refreshSession())) res = await doFetch();
  return res;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.detail) || `request failed (${res.status})`);
  return data;
}

// --------------------------------------------------------------------------
// views
// --------------------------------------------------------------------------

function layout(title, subtitle, body) {
  return `
    <div class="spread">
      <div>
        <h1>${esc(title)}</h1>
        <div class="muted">${esc(subtitle || "")}</div>
      </div>
      <button class="secondary" id="signout">Sign out</button>
    </div>
    ${body}
  `;
}

function renderLogin(error = "") {
  app.innerHTML = `
    <div class="auth">
      <h1>QuarryVault</h1>
      <p class="muted">Sign in with your account.</p>
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
    // Never reveal whether the address exists.
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
    history.replaceState(null, "", "/dashboard/");
    await start();
  });
}

function renderNotice(text) {
  app.innerHTML = `
    <div class="spread">
      <h1>QuarryVault</h1>
      <button class="secondary" id="signout">Sign out</button>
    </div>
    <div class="card"><p>${esc(text)}</p></div>`;
  app.querySelector("#signout").addEventListener("click", signOut);
}

async function renderPlatform() {
  const companies = await apiJson("/platform/companies");
  const rows = companies
    .map(
      (c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td><span class="tag ${esc(c.status)}">${esc(c.status)}</span></td>
        <td>${c.user_count}</td>
        <td>${fmtBytes(c.used_bytes)} / ${fmtBytes(c.quota_bytes)}</td>
        <td class="row">
          ${
            c.status === "active"
              ? `<button class="danger" data-suspend="${esc(c.id)}">Suspend</button>`
              : `<button data-reactivate="${esc(c.id)}">Reactivate</button>`
          }
        </td>
      </tr>`
    )
    .join("");

  app.innerHTML = layout(
    "Platform",
    "All companies",
    `
    <div class="card">
      <h2>Create company</h2>
      <form id="create-form" class="row">
        <input name="name" placeholder="Company name" required />
        <input name="quota_bytes" type="number" min="1" placeholder="Quota (bytes)" value="5368709120" />
        <input name="max_users" type="number" min="1" placeholder="Max users" value="10" />
        <button type="submit">Create</button>
      </form>
      <p class="msg"></p>
    </div>
    <div class="card">
      <h2>Companies</h2>
      <table>
        <thead><tr><th>Name</th><th>Status</th><th>Users</th><th>Usage</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="muted">No companies yet.</td></tr>`}</tbody>
      </table>
    </div>`
  );

  wireSignOut();
  const card = app.querySelector("#create-form").closest(".card");
  app.querySelector("#create-form").addEventListener("submit", async (event) => {
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

async function renderCompany() {
  const [employees, quarries, usage] = await Promise.all([
    apiJson("/company/employees"),
    apiJson("/company/quarries"),
    apiJson("/company/usage"),
  ]);

  const empRows = employees
    .map(
      (u) => `
      <tr>
        <td>${esc(u.email)}</td>
        <td>${esc(u.role)}</td>
        <td><span class="tag ${esc(u.status)}">${esc(u.status)}</span></td>
        <td class="row">
          ${
            u.status === "active"
              ? `<button class="danger" data-disable="${esc(u.id)}">Disable</button>`
              : `<button data-enable="${esc(u.id)}">Enable</button>`
          }
        </td>
      </tr>`
    )
    .join("");

  const quarryRows = quarries
    .map(
      (q) => `
      <tr>
        <td>${esc(q.name)}</td>
        <td><span class="tag ${esc(q.status)}">${esc(q.status)}</span></td>
        <td class="row">
          <button class="secondary" data-rename="${esc(q.id)}" data-name="${esc(q.name)}">Rename</button>
          ${
            q.status === "active"
              ? `<button class="danger" data-deactivate="${esc(q.id)}">Deactivate</button>`
              : `<button data-reactivate-q="${esc(q.id)}">Reactivate</button>`
          }
        </td>
      </tr>`
    )
    .join("");

  const memberOptions = employees
    .map((u) => `<option value="${esc(u.id)}">${esc(u.email)}</option>`)
    .join("");
  const quarryOptions = quarries
    .map((q) => `<option value="${esc(q.id)}">${esc(q.name)}</option>`)
    .join("");

  app.innerHTML = layout(
    esc(state.me.company.name),
    `Signed in as ${esc(state.me.user.email)} (${esc(state.me.role)}) · ${fmtBytes(usage.used_bytes)} of ${fmtBytes(usage.quota_bytes)} used`,
    `
    <div class="grid2">
      <div class="card">
        <h2>Invite employee</h2>
        <form id="invite-form" class="row">
          <input name="email" type="email" placeholder="email@example.com" required />
          <input name="full_name" placeholder="Full name (optional)" />
          <button type="submit">Send invite</button>
        </form>
        <p class="msg"></p>
      </div>
      <div class="card">
        <h2>Create quarry</h2>
        <form id="quarry-form" class="row">
          <input name="name" placeholder="Quarry name" required />
          <button type="submit">Create</button>
        </form>
        <p class="msg"></p>
      </div>
    </div>

    <div class="card">
      <h2>Employees</h2>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>${empRows || `<tr><td colspan="4" class="muted">No employees.</td></tr>`}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Quarries</h2>
      <table>
        <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
        <tbody>${quarryRows || `<tr><td colspan="3" class="muted">No quarries.</td></tr>`}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Permissions</h2>
      <form id="perm-form" class="row">
        <select name="user_id">${memberOptions}</select>
        <select name="quarry_id">${quarryOptions}</select>
        <label class="row"><input type="checkbox" name="can_view" /> view</label>
        <label class="row"><input type="checkbox" name="can_upload" /> upload</label>
        <label class="row"><input type="checkbox" name="can_download" /> download</label>
        <button type="submit">Save</button>
      </form>
      <p class="msg"></p>
    </div>`
  );

  wireSignOut();

  const inviteCard = app.querySelector("#invite-form").closest(".card");
  app.querySelector("#invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await apiJson("/company/employees/invite", {
        method: "POST",
        body: { email: form.email.value.trim(), full_name: form.full_name.value.trim() || null },
      });
      msg(inviteCard, "Invitation sent.", "ok");
      form.reset();
    } catch (err) {
      msg(inviteCard, err.message, "error");
    }
  });

  const quarryCard = app.querySelector("#quarry-form").closest(".card");
  app.querySelector("#quarry-form").addEventListener("submit", async (event) => {
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

  const permCard = app.querySelector("#perm-form").closest(".card");
  app.querySelector("#perm-form").addEventListener("submit", async (event) => {
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
      msg(permCard, "Permission saved.", "ok");
    } catch (err) {
      msg(permCard, err.message, "error");
    }
  });
}

function wireSignOut() {
  const button = app.querySelector("#signout");
  if (button) button.addEventListener("click", signOut);
}

// --------------------------------------------------------------------------
// bootstrap
// --------------------------------------------------------------------------

async function resolveRole() {
  if ((await api("/platform/companies")).ok) {
    state.role = "platform";
    return;
  }
  const me = await api("/me");
  if (me.ok) {
    state.me = await me.json();
    state.role = state.me.role === "company_admin" ? "company" : "employee";
    return;
  }
  state.role = "none";
}

async function renderApp() {
  if (state.role === "platform") return renderPlatform();
  if (state.role === "company") return renderCompany();
  if (state.role === "employee") {
    return renderNotice("Your account is an employee. Ask a company admin for access.");
  }
  return renderNotice("No access for this account.");
}

async function start() {
  state.callback = parseAuthFragment();
  if (state.callback) {
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
