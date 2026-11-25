import { describe, it, expect, vi, afterEach } from 'vitest';

const saved = { NODE_ENV: process.env.NODE_ENV, APP_ENV: process.env.APP_ENV };
afterEach(() => {
  if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.NODE_ENV;
  if (saved.APP_ENV === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = saved.APP_ENV;
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  return import('../src/config/index.js');
}

describe('config fails closed (round1 #3)', () => {
  it('unset NODE_ENV is treated as production, so validateProductionConfig runs and the public default secrets are refused', async () => {
    delete process.env.NODE_ENV; delete process.env.APP_ENV;
    const m = await loadConfig();
    expect(m.config.env).toBe('production');
    expect(m.config.enableDocs).toBe(false);
    expect(() => m.validateProductionConfig(m.config)).toThrow(/Fatal/);
  });

  it('explicit development / test still work', async () => {
    process.env.NODE_ENV = 'development';
    expect((await loadConfig()).config.env).toBe('development');
    process.env.NODE_ENV = 'test';
    expect((await loadConfig()).config.env).toBe('test');
  });

  it('dev-password fallback needs an explicit NODE_ENV=development, never a defaulted one', async () => {
    delete process.env.NODE_ENV; delete process.env.APP_ENV;
    const unset = await loadConfig();
    expect(unset.isDevPasswordFallbackEnabled({ ...unset.config, env: 'development' })).toBe(false);
    expect(unset.isDevPasswordFallbackEnabled(unset.config)).toBe(false);
    process.env.NODE_ENV = 'development';
    const dev = await loadConfig();
    expect(dev.isDevPasswordFallbackEnabled(dev.config)).toBe(true);
    process.env.NODE_ENV = 'production';
    const prod = await loadConfig();
    expect(prod.isDevPasswordFallbackEnabled(prod.config)).toBe(false);
  });
});
