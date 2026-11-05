import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';

const app = createApp();

describe('CORS origin policy', () => {
  it('allows the configured admin origin without enabling credentialed browser requests', async () => {
    const response = await request(app)
      .options('/auth/login')
      .set('Origin', config.webOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(config.webOrigin);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not grant CORS access to an unconfigured origin', async () => {
    const response = await request(app)
      .options('/auth/login')
      .set('Origin', 'https://untrusted.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    // Express may answer an unhandled OPTIONS request itself; the browser is
    // denied because the response has no Access-Control-Allow-Origin header.
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
