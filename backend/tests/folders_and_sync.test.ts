import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestQuarry,
  createTestPermission,
  generateAuthHeader,
} from './helpers.js';
import { MembershipRole } from '../src/types/index.js';

const app = createApp();

describe('Folders Hierarchy & Sync Change Feed', () => {
  it('manages folder creation, nesting, duplicate rejection, and empty-only soft deletion', async () => {
    const company = await createTestCompany();
    const user = await createTestUser();
    const membership = await createTestMembership(user._id, company._id, MembershipRole.employee);
    membership.can_delete = true;
    await membership.save();
    const quarry = await createTestQuarry(company._id);

    await createTestPermission(user._id, quarry._id, {
      can_view: true,
      can_upload: true,
      can_delete: true,
    });

    const authHeader = generateAuthHeader(user);

    // 1. Create root folder "Plans"
    const rootRes = await request(app)
      .post(`/quarries/${quarry._id}/folders`)
      .set(authHeader)
      .send({ name: 'Plans' });

    expect(rootRes.status).toBe(201);
    expect(rootRes.body.name).toBe('Plans');
    expect(rootRes.body.parent_id).toBeNull();
    const rootId = rootRes.body.id;

    // 2. Reject duplicate folder name under same parent
    const dupRes = await request(app)
      .post(`/quarries/${quarry._id}/folders`)
      .set(authHeader)
      .send({ name: 'plans' }); // Case-insensitive duplicate
    expect(dupRes.status).toBe(409);

    // 3. Create nested child folder "2026" under "Plans"
    const childRes = await request(app)
      .post(`/quarries/${quarry._id}/folders`)
      .set(authHeader)
      .send({ name: '2026', parent_id: rootId });

    expect(childRes.status).toBe(201);
    expect(childRes.body.parent_id).toBe(rootId);
    const childId = childRes.body.id;

    // 4. Attempt to delete non-empty parent folder (must return 409 Conflict)
    const deleteParentRes = await request(app)
      .delete(`/quarries/${quarry._id}/folders/${rootId}`)
      .set(authHeader);
    expect(deleteParentRes.status).toBe(409);
    expect(deleteParentRes.body.detail).toContain('folder is not empty');

    // 5. Delete empty child folder
    const deleteChildRes = await request(app)
      .delete(`/quarries/${quarry._id}/folders/${childId}`)
      .set(authHeader);
    expect(deleteChildRes.status).toBe(204);

    // 6. Now parent folder is empty, delete succeeds
    const deleteParentRes2 = await request(app)
      .delete(`/quarries/${quarry._id}/folders/${rootId}`)
      .set(authHeader);
    expect(deleteParentRes2.status).toBe(204);
  });

  it('delivers signed HMAC cursor sync change feed on GET /sync/changes', async () => {
    const company = await createTestCompany();
    const user = await createTestUser();
    await createTestMembership(user._id, company._id, MembershipRole.employee);
    const quarry = await createTestQuarry(company._id);
    await createTestPermission(user._id, quarry._id, { can_view: true, can_upload: true });
    const authHeader = generateAuthHeader(user);

    // Bootstrap request (no cursor)
    const bootstrapRes = await request(app).get('/sync/changes').set(authHeader);
    expect(bootstrapRes.status).toBe(200);
    expect(bootstrapRes.body.bootstrap_required).toBe(true);
    expect(bootstrapRes.body.next_cursor).toBeDefined();
    expect(bootstrapRes.body.next_cursor.startsWith('v1.')).toBe(true);

    const initialCursor = bootstrapRes.body.next_cursor;

    // Create a folder (mutates state and appends to change log)
    await request(app)
      .post(`/quarries/${quarry._id}/folders`)
      .set(authHeader)
      .send({ name: 'Sync Tested Folder' });

    // Poll with saved cursor
    const changesRes = await request(app)
      .get(`/sync/changes?cursor=${initialCursor}`)
      .set(authHeader);

    expect(changesRes.status).toBe(200);
    expect(changesRes.body.changes.length).toBeGreaterThan(0);
    expect(changesRes.body.changes[0].entity_type).toBe('folder');
    expect(changesRes.body.changes[0].change_type).toBe('created');
  });
});
