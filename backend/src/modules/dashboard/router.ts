import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../../config/index.js';

export const dashboardRouter = Router();

/**
 * Public dashboard config (preserved for client bootstrap & test compatibility)
 */
dashboardRouter.get('/dashboard/config', (_req: Request, res: Response) => {
  res.json({
    supabase_url: config.supabaseUrl,
    supabase_anon_key: config.supabaseAnonKey,
  });
});

/**
 * Redirect obsolete /dashboard routes to modern Admin Portal (port 3001)
 */
dashboardRouter.get('/dashboard', (_req: Request, res: Response) => {
  res.redirect(302, config.webOrigin || 'http://localhost:3001');
});

dashboardRouter.get('/dashboard/*', (_req: Request, res: Response) => {
  res.redirect(302, config.webOrigin || 'http://localhost:3001');
});

/**
 * Middleware for strict dashboard CSP headers
 */
export function dashboardSecurityHeaders(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith('/dashboard')) {
    const supabaseOrigin = (config.supabaseUrl || '').replace(/\/+$/, '');
    const connectSrc = `'self'${supabaseOrigin ? ` ${supabaseOrigin}` : ''}`;

    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ${connectSrc}; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}

/**
 * Legacy static mount removed - redirected to Admin Portal
 */
export function mountDashboardStatic(_app: any) {
  // Legacy vanilla JS dashboard in backend/dashboard/ removed.
  // /dashboard routes are now redirected to config.webOrigin (Admin Portal).
}
