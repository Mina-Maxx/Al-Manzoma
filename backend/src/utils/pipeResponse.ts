import { Readable } from 'stream';
import type { NextFunction, Response } from 'express';
import { StorageFailureError } from '../middleware/errors.js';

/**
 * Streams `stream` to `res` with proper error propagation. A plain `stream.pipe(res)` has no error
 * handling: a storage error mid-download becomes an unhandled 'error' event and the request hangs.
 * (stream.pipeline is not used because it destroys `res` on failure, so no error response could be sent.)
 */
export function pipeToResponse(stream: Readable, res: Response, next: NextFunction): void {
  stream.once('error', (err: Error) => {
    console.error('[stream] error while sending response:', err.message);
    stream.unpipe(res);
    if (!res.headersSent) {
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Disposition');
      res.removeHeader('ETag');
      next(new StorageFailureError('failed to read file from storage'));
    } else {
      res.destroy(err);
    }
  });
  // Client disconnected before the stream finished: release the source (file handle / storage socket).
  res.once('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(res);
}
