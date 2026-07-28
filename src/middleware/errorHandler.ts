import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';

/** Represents an HTTP error carrying an optional numeric status code or an Axios-style response object. */
interface HttpError extends Error {
    status?: number;
    response?: { status: number };
}

/**
 * Centralized Express error-handling middleware. Maps a thrown/forwarded error to
 * an HTTP status (from `err.status`, a nested `err.response.status`, or 500) and a
 * JSON body, hiding the real message for 5xx errors so internals aren't leaked to
 * the client. Must be registered last, after all routes.
 * @param err - The error being handled; `status`/`response.status` drive the HTTP status code.
 * @param _req - Express request (unused).
 * @param res - Express response used to send the error JSON.
 * @param _next - Express next function (required in the signature so Express recognizes this as an error handler).
 * @returns Nothing — sends the response directly.
 */
function errorHandler(err: HttpError, _req: Request, res: Response, _next: NextFunction): void {
    const status = err.status ?? err.response?.status ?? 500;
    const message = status < 500 ? err.message : 'Internal server error';

    if (status >= 500) {
        logger.error('Unhandled error:', err);
    }

    res.status(status).json({ error: message });
}

export default errorHandler;
