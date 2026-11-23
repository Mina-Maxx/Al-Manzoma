import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { healthRouter } from './modules/health/router.js';
import { docsRouter } from './modules/docs/router.js';
import { authRouter } from './modules/auth/router.js';
import { usersRouter } from './modules/users/router.js';
import { quarriesRouter } from './modules/quarries/router.js';
import { documentsRouter } from './modules/documents/router.js';
import { syncRouter } from './modules/sync/router.js';
import { platformRouter } from './modules/platform/router.js';
import { companiesRouter } from './modules/companies/router.js';
import { updatesRouter } from './modules/updates/router.js';
import { dashboardRouter, dashboardSecurityHeaders, mountDashboardStatic } from './modules/dashboard/router.js';
import { errorHandler } from './middleware/errors.js';
import { config } from './config/index.js';

export function createApp(): Express {
  const app = express();

  // CORS configuration
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || config.webOrigin === '*' || origin === config.webOrigin) {
          return callback(null, true);
        }
        const origins = config.webOrigin.split(',').map((o) => o.trim());
        if (origins.includes(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match', 'X-Company-Id', 'X-Client-Application', 'X-App-Version-Code', 'X-Session-Id', 'x-session-id'],
      exposedHeaders: ['Content-Disposition', 'Content-Length', 'ETag'],
    })
  );

  // Helmet with relaxed cross-origin settings for local APIs and dashboard
  app.use(
    helmet({
      contentSecurityPolicy: false, // Customized in dashboardSecurityHeaders
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  // Security headers for dashboard
  app.use(dashboardSecurityHeaders);

  // Body parsers
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Register API Routers
  app.use(healthRouter);
  app.use(docsRouter);
  app.use('/auth', authRouter);
  app.use(usersRouter);
  app.use(quarriesRouter);
  app.use(documentsRouter);
  app.use(syncRouter);
  app.use('/platform', platformRouter);
  app.use(companiesRouter);
  app.use(updatesRouter);
  app.use(dashboardRouter);

  // Mount static dashboard
  mountDashboardStatic(app);

  // Fallback 404 handler for unmatched routes
  app.use((_req, res) => {
    res.status(404).json({ detail: 'not found' });
  });

  // Centralized Domain Error Handler
  app.use(errorHandler);

  return app;
}
