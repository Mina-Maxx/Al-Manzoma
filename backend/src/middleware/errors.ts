import { Request, Response, NextFunction } from 'express';

export class DomainError extends Error {
  httpStatus: number;
  code?: string;

  constructor(message: string, httpStatus: number = 400, code?: string) {
    super(message);
    this.name = 'DomainError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string = 'not found') {
    super(message, 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string = 'forbidden') {
    super(message, 403);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message: string = 'invalid or missing credentials') {
    super(message, 401);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, code?: string) {
    super(message, 409, code);
  }
}

export class PreconditionFailedError extends DomainError {
  constructor(message: string) {
    super(message, 412);
  }
}

export class GoneError extends DomainError {
  constructor(message: string) {
    super(message, 410);
  }
}

export class StorageFailureError extends DomainError {
  constructor(message: string = 'file storage is unavailable') {
    super(message, 502);
  }
}

export class UpgradeRequiredError extends DomainError {
  data: any;
  constructor(data: any) {
    super('Upgrade Required', 426, 'UPGRADE_REQUIRED');
    this.data = data;
  }
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof UpgradeRequiredError) {
    res.status(426).json({
      detail: err.data,
      code: 'UPGRADE_REQUIRED',
    });
    return;
  }

  if (err instanceof DomainError || (err && typeof err.httpStatus === 'number')) {
    const payload: { detail: string; code?: string } = { detail: err.message || 'error' };
    if (err.code) payload.code = err.code;
    res.status(err.httpStatus || 400).json(payload);
    return;
  }

  // Handle MongoDB duplicate key errors (code 11000)
  if (err && (err.code === 11000 || err.code === '11000' || (err.name === 'MongoServerError' && err.code === 11000))) {
    res.status(409).json({ detail: 'a resource with this identifier already exists', code: 'DUPLICATE_KEY' });
    return;
  }

  // Handle Multer file limit errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ detail: 'file is larger than maximum permitted size' });
    return;
  }

  console.error('[Error] Unhandled server error on', req.method, req.url, ':', err);
  res.status(500).json({ detail: 'internal server error' });
}
