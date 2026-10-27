// Pure, DOM-free view helpers for the dashboard.
//
// Everything that renders user-supplied data (company / quarry / employee names
// and emails) goes through `esc()` and is inserted with textContent-equivalent
// strict escaping — never as raw HTML. Keeping these functions pure lets the
// test suite prove the escaping without a browser or jsdom.

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

export function platformView(companies) {
  const rows = companies
    .map(
      (c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td><span class="tag ${esc(c.status)}">${esc(c.status)}</span></td>
        <td>${Number(c.user_count)}</td>
        <td>${esc(fmtBytes(c.used_bytes))} / ${esc(fmtBytes(c.quota_bytes))}</td>
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

  return layout(
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
}

export function companyView(me, employees, quarries, usage) {
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

  return layout(
    me.company.name,
    `Signed in as ${me.user.email} (${me.role}) · ${fmtBytes(usage.used_bytes)} of ${fmtBytes(usage.quota_bytes)} used`,
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
}
