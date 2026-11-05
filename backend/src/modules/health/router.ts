import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { storage } from '../storage/index.js';
import { config } from '../../config/index.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req: Request, res: Response) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'healthy' : 'unhealthy';
  let storageStatus = 'healthy';

  try {
    // Basic existence check without exposing bucket secrets
    await storage.exists('health-check-probe');
  } catch {
    storageStatus = 'degraded';
  }

  const isHealthy = dbStatus === 'healthy';
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    services: {
      api: 'healthy',
      database: dbStatus,
      storage: storageStatus,
      storage_backend: config.storageBackend,
    },
  });
});
