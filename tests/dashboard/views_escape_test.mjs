// Behavioural proof that user-supplied fields are escaped before rendering.
// Run with: node tests/dashboard/views_escape_test.mjs
import assert from "node:assert/strict";

import { esc, companyView, platformView } from "../../app/dashboard/views.js";

const payload = `<script>alert(1)</script>"><img src=x onerror=alert(1)>`;

// 1. esc() neutralizes both payload shapes.
const escaped = esc(payload);
assert.ok(!escaped.includes("<"), "esc must not emit '<'");
assert.ok(!escaped.includes(">"), "esc must not emit '>'");
assert.ok(!escaped.includes('"'), "esc must not emit '\"'");
assert.ok(escaped.includes("&lt;script&gt;"), "script tag must be escaped");
assert.ok(escaped.includes("&lt;img"), "img tag must be escaped");

// 2. company view: company name, employee email and quarry name are safe.
const me = {
  company: { name: payload },
  user: { email: payload },
  role: "company_admin",
};
const employees = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    email: payload,
    full_name: payload,
    status: "active",
    role: "employee",
  },
];
const quarries = [
  { id: "22222222-2222-2222-2222-222222222222", name: payload, status: "active" },
];
const html = companyView(me, employees, quarries, {
  used_bytes: 1024,
  quota_bytes: 2048,
});

assert.ok(!html.includes("<script>alert(1)</script>"), "raw <script> leaked");
assert.ok(!html.includes("<img"), "raw <img> leaked");
assert.ok(html.includes("&lt;script&gt;"), "escaped script missing");
assert.ok(html.includes("&lt;img"), "escaped img missing");

// 3. platform view: company name is safe.
const platformHtml = platformView([
  {
    id: "33333333-3333-3333-3333-333333333333",
    name: payload,
    status: "active",
    user_count: 1,
    used_bytes: 0,
    quota_bytes: 1,
  },
]);
assert.ok(!platformHtml.includes("<script>alert(1)</script>"), "raw <script> leaked");
assert.ok(!platformHtml.includes("<img"), "raw <img> leaked");

console.log("views escape tests passed");
