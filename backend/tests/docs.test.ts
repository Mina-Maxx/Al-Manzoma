import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';

const app = createApp();

describe('API Documentation & Route Guarding Regressions', () => {
  it('GET /openapi.json returns valid OpenAPI 3.0 specification when enabled', async () => {
    const res = await request(app).get('/openapi.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.info.title).toBe('QuarryVault API');
    expect(res.body.paths).toBeDefined();

    // Verify key paths are present in schema
    expect(res.body.paths['/health']).toBeDefined();
    expect(res.body.paths['/auth/login']).toBeDefined();
    expect(res.body.paths['/me']).toBeDefined();
    expect(res.body.paths['/quarries']).toBeDefined();
    expect(res.body.paths['/documents']).toBeDefined();
    expect(res.body.paths['/company/employees']).toBeDefined();
    expect(res.body.paths['/platform/overview']).toBeDefined();
    expect(res.body.paths['/app/updates/latest']).toBeDefined();
    expect(res.body.paths['/dashboard/config']).toBeDefined();

    // Verify security schemes
    expect(res.body.components.securitySchemes.bearerAuth).toBeDefined();
    expect(res.body.components.securitySchemes.companyIdHeader).toBeDefined();
  });

  it('GET /docs serves interactive Swagger UI HTML', async () => {
    const res = await request(app).get('/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<!DOCTYPE html>');
    expect(res.text).toContain('QuarryVault API - Swagger UI');
    expect(res.text).toContain('swagger-ui-bundle.js');
    expect(res.text).toContain('/openapi.json');
  });

  it('GET /docs/ with trailing slash serves Swagger UI HTML', async () => {
    const res = await request(app).get('/docs/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('swagger-ui-bundle.js');
  });

  it('GET /app/updates/latest without credentials returns 404 (not hijacked by 401)', async () => {
    const res = await request(app).get('/app/updates/latest');

    // Should reach updatesRouter and return 404 with "no releases published", NOT 401 missing credentials
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe('no releases published');
  });

  it('GET /dashboard/config without credentials returns 200 (not hijacked by 401)', async () => {
    const res = await request(app).get('/dashboard/config');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('supabase_url');
  });

  it('GET /unknown-random-route returns 404 {"detail":"not found"} instead of 401', async () => {
    const res = await request(app).get('/unknown-random-route-xyz-404');

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe('not found');
  });

  it('strictly preserves authentication on protected routes', async () => {
    // Protected company route without auth header
    const companyRes = await request(app).get('/company/employees');
    expect(companyRes.status).toBe(401);
    expect(companyRes.body.detail).toBe('missing credentials');

    // Protected platform route without auth header
    const platformRes = await request(app).get('/platform/overview');
    expect(platformRes.status).toBe(401);
    expect(platformRes.body.detail).toBe('missing credentials');

    // Protected user profile without auth header
    const meRes = await request(app).get('/me');
    expect(meRes.status).toBe(401);
    expect(meRes.body.detail).toBe('missing credentials');

    // Protected quarries route without auth header
    const quarriesRes = await request(app).get('/quarries');
    expect(quarriesRes.status).toBe(401);
    expect(quarriesRes.body.detail).toBe('missing credentials');
  });

  it('respects config.enableDocs flag when disabled', async () => {
    const originalSetting = config.enableDocs;
    try {
      config.enableDocs = false;

      const docsRes = await request(app).get('/docs');
      expect(docsRes.status).toBe(404);
      expect(docsRes.body.detail).toContain('disabled');

      const openapiRes = await request(app).get('/openapi.json');
      expect(openapiRes.status).toBe(404);
      expect(openapiRes.body.detail).toContain('disabled');
    } finally {
      config.enableDocs = originalSetting;
    }
  });
});
